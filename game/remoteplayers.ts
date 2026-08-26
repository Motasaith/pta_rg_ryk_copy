import * as THREE from 'three';
import {
  createHumanoid, disposeHumanoid, HAIRS, Humanoid, PANTS, poseHumanoid, setHumanoidDetail,
  SHIRTS, SKINS,
} from './humanoid';
import { NetClient } from './netclient';
import {
  F_AIMING, F_CROUCH, F_DEAD, F_GROUNDED, F_SPRINT, F_VEHICLE, PlayerState, TEAM_COLOURS, TEAM_NONE,
  VEH_KINDS,
} from './protocol';
import { NetTarget } from './combat';
import { Box } from './physics';
import {
  CAR_COLOURS, createVehicle, poseNetVehicle, placeVehicle, updateSiren, Vehicle, VehKind,
} from './vehicle';
import { mulberry32 } from './mathx';

interface Remote {
  id: number;
  h: Humanoid;
  plate: THREE.Sprite;
  /** what the plate was last drawn with, so we only repaint when it actually changes */
  plateKey: string;
  /** the car this player is driving, created on demand and kept while they stay in it */
  veh: Vehicle | null;
  last: PlayerState | null;
}

/**
 * Draws the other players. They use the same 11-joint rig and the same procedural animation
 * as the local character, driven from interpolated network state instead of input — so a
 * friend running past looks exactly like you do, including the walk cycle and head tracking.
 *
 * A player who gets into a car is drawn *as* that car: their state carries the kind and
 * colour, so we build the same vehicle everyone else can see and pose it from the same
 * interpolated transform. Before this existed, F_VEHICLE simply hid the humanoid and a
 * driving friend became invisible.
 */
export class RemotePlayers {
  private list = new Map<number, Remote>();
  private group = new THREE.Group();
  private targets: NetTarget[] = [];

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** Reconcile our visuals with the client's peer list, then pose everyone. */
  update(net: NetClient, dt: number, t: number, now: number, camX: number, camZ: number, drawDist: number): void {
    // remove anyone who left
    for (const [id, r] of this.list) {
      if (!net.peers.has(id)) this.despawn(id, r);
    }

    this.targets.length = 0;

    for (const peer of net.peers.values()) {
      let r = this.list.get(peer.id);
      if (!r) {
        r = this.spawn(peer.id);
        this.list.set(peer.id, r);
      }
      const s = peer.buf.sample(now);
      if (!s) {
        r.h.root.visible = false;
        r.plate.visible = false;
        continue;
      }
      r.last = s;

      const inCar = (s.flags & F_VEHICLE) !== 0;
      const dead = (s.flags & F_DEAD) !== 0;
      const far = (s.x - camX) ** 2 + (s.z - camZ) ** 2 > drawDist * drawDist;

      // A shootable target even when culled from view: bullets travel further than the
      // draw distance, and "I could not hit him because my graphics were low" is not a
      // trade anyone would accept.
      if (!dead) {
        this.targets.push({
          id: peer.id,
          x: s.x, y: s.y, z: s.z,
          // In free-roam everyone is team 0 and nobody is a valid target; in a match only
          // the other side is. Both cases fall out of one comparison.
          friendly: net.myTeam === TEAM_NONE || net.myTeam === peer.team || inCar,
        });
      }

      this.updateVehicle(r, s, inCar, dt, t);

      r.h.root.visible = !inCar && !far;
      r.plate.visible = !far;
      if (r.plate.visible) {
        this.repaintPlate(r, peer.name, peer.team, s.health, dead);
        // Float the tag above the roof when they are driving, above the head when not.
        r.plate.position.set(s.x, s.y + (inCar ? 2.4 : 2.12), s.z);
      }
      if (!r.h.root.visible) continue;

      r.h.root.position.set(s.x, s.y, s.z);
      r.h.root.rotation.y = s.yaw;
      setHumanoidDetail(r.h, true, (s.x - camX) ** 2 + (s.z - camZ) ** 2 < 900);

      poseHumanoid(r.h, {
        dt, t,
        speed: s.speed,
        runSpeed: 6.1,
        grounded: (s.flags & F_GROUNDED) !== 0,
        airVy: 0,
        aiming: (s.flags & F_AIMING) !== 0,
        aimPitch: 0,
        dead: dead ? 1 : 0,
        seated: false,
        crouching: (s.flags & F_CROUCH) !== 0,
        punch: 0,
        flinch: 0,
        steer: 0,
      });
    }
  }

  /** Remote players as bullet targets, refreshed by the last update(). */
  hitTargets(): NetTarget[] {
    return this.targets;
  }

  /**
   * Collision boxes for the cars other players are driving.
   *
   * Without these a friend's car is scenery you drive straight through and bullets pass
   * clean out the other side — the car is drawn but not present. Pushed into the same
   * dynamic list the ambient traffic uses, so one mechanism covers both.
   */
  collisionBoxes(out: Box[]): void {
    for (const r of this.list.values()) {
      if (r.veh) out.push(r.veh.box);
    }
  }

  /** Interpolated position of one player, for a melee swing or a kill camera. */
  stateOf(id: number): PlayerState | null {
    return this.list.get(id)?.last ?? null;
  }

  /** Positions for the radar. */
  forEach(cb: (x: number, z: number, team: number) => void): void {
    for (const r of this.list.values()) {
      if (r.last && (r.h.root.visible || r.veh)) cb(r.last.x, r.last.z, r.last.team);
    }
  }

  /**
   * Build, pose or tear down the car a remote player is driving. The car is rebuilt only
   * when they change vehicle, so hopping in and out of the same taxi costs nothing.
   */
  private updateVehicle(r: Remote, s: PlayerState, inCar: boolean, dt: number, t: number): void {
    if (!inCar) {
      if (r.veh) {
        r.veh.group.removeFromParent();
        r.veh = null;
      }
      return;
    }
    const kind = (VEH_KINDS[s.vkind] ?? 'sedan') as VehKind;
    if (r.veh && r.veh.kind !== kind) {
      r.veh.group.removeFromParent();
      r.veh = null;
    }
    if (!r.veh) {
      r.veh = createVehicle(kind, CAR_COLOURS[s.vcolour % CAR_COLOURS.length]);
      placeVehicle(r.veh, s.x, s.z, s.yaw);
      r.veh.y = s.y;
      this.group.add(r.veh.group);
    }
    r.veh.siren = kind === 'police';
    updateSiren(r.veh, t);
    poseNetVehicle(r.veh, s.x, s.y, s.z, s.yaw, dt);
  }

  private spawn(id: number): Remote {
    // deterministic outfit from the id, so a given player looks the same to everyone
    const rng = mulberry32(id * 2654435761);
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];
    const h = createHumanoid({
      skin: pick(SKINS), shirt: pick(SHIRTS), pants: pick(PANTS),
      hair: pick(HAIRS), shoes: 0x2b2f33, scale: 1,
    });
    this.group.add(h.root);
    const plate = blankPlate();
    this.group.add(plate);
    return { id, h, plate, plateKey: '', veh: null, last: null };
  }

  private despawn(id: number, r: Remote): void {
    disposeHumanoid(r.h);
    if (r.veh) r.veh.group.removeFromParent();
    this.group.remove(r.plate);
    disposePlate(r.plate);
    this.list.delete(id);
  }

  /**
   * Repaint the name tag only when something on it changed. Health moves constantly during
   * a firefight, so it is bucketed to 5% — a canvas upload per player per frame is exactly
   * the kind of thing that quietly costs more than the rest of the netcode put together.
   */
  private repaintPlate(r: Remote, name: string, team: number, health: number, dead: boolean): void {
    const bucket = dead ? -1 : Math.round(Math.max(0, Math.min(100, health)) / 5);
    const key = `${name}|${team}|${bucket}`;
    if (key === r.plateKey) return;
    r.plateKey = key;
    drawPlate(r.plate, name, team, dead ? 0 : bucket * 5, dead);
  }

  dispose(): void {
    for (const r of this.list.values()) {
      disposeHumanoid(r.h);
      if (r.veh) r.veh.group.removeFromParent();
      disposePlate(r.plate);
    }
    this.list.clear();
    this.targets.length = 0;
    this.group.removeFromParent();
  }
}

/* ── name tags ─────────────────────────────────────────────────────────────── */

const PLATE_W = 256;
const PLATE_H = 80;

/** One small canvas per player, capped at 8, so the cost is trivial. */
function blankPlate(): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = PLATE_W;
  c.height = PLATE_H;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false,
  }));
  sp.scale.set(2.2, 0.69, 1);
  sp.renderOrder = 10;
  sp.userData.canvas = c;
  return sp;
}

/**
 * Name in the team colour, with a health bar under it. The bar is the whole reason a
 * firefight is readable: without it you cannot tell a player you have nearly killed from
 * one who just spawned, and every fight becomes a coin flip.
 */
function drawPlate(sp: THREE.Sprite, name: string, team: number, health: number, dead: boolean): void {
  const c = sp.userData.canvas as HTMLCanvasElement;
  const g = c.getContext('2d')!;
  const colour = TEAM_COLOURS[team] ?? TEAM_COLOURS[0];
  const css = `#${colour.toString(16).padStart(6, '0')}`;

  g.clearRect(0, 0, PLATE_W, PLATE_H);
  g.font = 'bold 30px ui-monospace, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,.72)';
  g.strokeText(name, PLATE_W / 2, 26);
  g.fillStyle = dead ? '#8b8f96' : css;
  g.fillText(name, PLATE_W / 2, 26);

  if (dead) {
    g.font = 'bold 20px ui-monospace, monospace';
    g.strokeText('DOWN', PLATE_W / 2, 58);
    g.fillText('DOWN', PLATE_W / 2, 58);
  } else if (team !== TEAM_NONE) {
    const bw = 150, bh = 10, bx = (PLATE_W - bw) / 2, by = 50;
    g.fillStyle = 'rgba(0,0,0,.6)';
    g.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    g.fillStyle = css;
    g.fillRect(bx, by, bw * Math.max(0, Math.min(1, health / 100)), bh);
  }

  const map = (sp.material as THREE.SpriteMaterial).map;
  if (map) map.needsUpdate = true;
}

function disposePlate(sp: THREE.Sprite): void {
  const m = sp.material as THREE.SpriteMaterial;
  m.map?.dispose();
  m.dispose();
}

/** Pack the local player's animation state into protocol flags. */
export function packFlags(o: {
  sprint: boolean; aiming: boolean; inVehicle: boolean; dead: boolean; grounded: boolean;
  crouching?: boolean;
}): number {
  return (o.sprint ? F_SPRINT : 0)
    | (o.aiming ? F_AIMING : 0)
    | (o.inVehicle ? F_VEHICLE : 0)
    | (o.dead ? F_DEAD : 0)
    | (o.grounded ? F_GROUNDED : 0)
    | (o.crouching ? F_CROUCH : 0);
}

import * as THREE from 'three';
import { angleDamp, clamp, damp, dist2, mulberry32, pick, ri, Rng, wrapPi } from './mathx';
import { Physics } from './physics';
import { City } from './city';
import {
  createHumanoid, disposeHumanoid, HAIRS, Humanoid, Look, PANTS, poseHumanoid, setHumanoidDetail, SHIRTS, SKINS,
} from './humanoid';
import { createWeaponModel } from './weapons';

export type PedState = 'walk' | 'idle' | 'flee' | 'chase' | 'dead';

export interface Ped {
  h: Humanoid;
  cop: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  radius: number;
  state: PedState;
  health: number;
  loop: { x: number; z: number }[];
  li: number;
  dir: number;
  /** seconds left of panic */
  fleeT: number;
  fleeFromX: number;
  fleeFromZ: number;
  flinch: number;
  deadT: number;
  corpseT: number;
  shootCd: number;
  aiming: boolean;
  aimPitch: number;
  idleT: number;
  bleed: number;
}

const WALK = 1.35;
const RUN = 5.2;
const COP_RUN = 5.8;

export class PedManager {
  peds: Ped[] = [];
  private rng: Rng = mulberry32(1337);
  private streamT = 0;

  constructor(
    private scene: THREE.Scene,
    private phys: Physics,
    private city: City,
  ) {}

  private look(cop: boolean): Look {
    const r = this.rng;
    if (cop) {
      return {
        skin: pick(r, SKINS), shirt: 0x1c2f52, pants: 0x22262e,
        hair: 0x15100c, shoes: 0x101216, scale: 0.99 + r() * 0.03,
      };
    }
    return {
      skin: pick(r, SKINS), shirt: pick(r, SHIRTS), pants: pick(r, PANTS),
      hair: pick(r, HAIRS), shoes: pick(r, [0x24262b, 0x3b2b20, 0xf0f0ec]),
      scale: 0.93 + r() * 0.14,
    };
  }

  spawnPed(cop = false, atX?: number, atZ?: number): Ped {
    const loop = this.city.pedLoops[ri(this.rng, 0, this.city.pedLoops.length - 1)];
    const li = ri(this.rng, 0, loop.length - 1);
    const h = createHumanoid(this.look(cop));
    this.scene.add(h.root);
    if (cop) {
      const w = createWeaponModel('pistol');
      if (w) h.gunMount.add(w.group);
    }
    const ped: Ped = {
      h, cop,
      x: atX ?? loop[li].x, y: 0, z: atZ ?? loop[li].z,
      yaw: this.rng() * 6.28, speed: 0, radius: 0.32,
      state: cop ? 'chase' : 'walk',
      health: cop ? 140 : 100,
      loop, li, dir: this.rng() > 0.5 ? 1 : -1,
      fleeT: 0, fleeFromX: 0, fleeFromZ: 0, flinch: 0, deadT: 0, corpseT: 0,
      shootCd: 1.2, aiming: false, aimPitch: 0, idleT: 0, bleed: 0,
    };
    this.peds.push(ped);
    return ped;
  }

  populate(count: number): void {
    for (let i = 0; i < count; i++) this.spawnPed(false);
  }

  /** Move a pedestrian to a pavement loop within a distance band of the player. */
  private relocate(p: Ped, px: number, pz: number, minD: number, maxD: number): boolean {
    for (let i = 0; i < 40; i++) {
      const loop = this.city.pedLoops[ri(this.rng, 0, this.city.pedLoops.length - 1)];
      const li = ri(this.rng, 0, loop.length - 1);
      const n = loop[li];
      const d2 = dist2(n.x, n.z, px, pz);
      if (d2 < minD * minD || d2 > maxD * maxD) continue;
      p.loop = loop; p.li = li;
      p.x = n.x; p.z = n.z;
      p.speed = 0;
      return true;
    }
    return false;
  }

  /**
   * Population streaming. Sixteen people spread over twenty-five blocks looks abandoned, so
   * anyone who wanders too far is quietly moved to a street near the player instead.
   */
  streamTo(px: number, pz: number, keepWithin = 155): void {
    for (const p of this.peds) {
      if (p.cop || p.state === 'dead') continue;
      if (dist2(p.x, p.z, px, pz) <= keepWithin * keepWithin) continue;
      this.relocate(p, px, pz, 32, 100);
    }
  }

  /** Recycle a corpse somewhere out of sight but still in the neighbourhood. */
  private respawn(p: Ped, px: number, pz: number): void {
    this.relocate(p, px, pz, 55, 130);
    p.health = p.cop ? 140 : 100;
    p.state = p.cop ? 'chase' : 'walk';
    p.deadT = 0; p.corpseT = 0; p.fleeT = 0; p.flinch = 0; p.bleed = 0;
    p.speed = 0;
    p.h.tilt.rotation.set(0, 0, 0);
    p.h.root.visible = true;
  }

  panic(x: number, z: number, radius: number, seconds = 6): void {
    const r2 = radius * radius;
    for (const p of this.peds) {
      if (p.state === 'dead' || p.cop) continue;
      if (dist2(p.x, p.z, x, z) > r2) continue;
      p.state = 'flee';
      p.fleeT = Math.max(p.fleeT, seconds);
      p.fleeFromX = x;
      p.fleeFromZ = z;
    }
  }

  /** Returns true if this hit killed them. */
  damage(p: Ped, amount: number, fromX: number, fromZ: number): boolean {
    if (p.state === 'dead') return false;
    p.health -= amount;
    p.flinch = 0.35;
    p.bleed = 1;
    if (p.health <= 0) {
      p.state = 'dead';
      p.deadT = 0.001;
      p.corpseT = 0;
      p.speed = 0;
      p.aiming = false;
      return true;
    }
    if (!p.cop) {
      p.state = 'flee';
      p.fleeT = 8;
      p.fleeFromX = fromX;
      p.fleeFromZ = fromZ;
    }
    return false;
  }

  nearestAlive(x: number, z: number, maxDist: number, copsOnly = false): Ped | null {
    let best: Ped | null = null, bd = maxDist * maxDist;
    for (const p of this.peds) {
      if (p.state === 'dead') continue;
      if (copsOnly && !p.cop) continue;
      const d = dist2(p.x, p.z, x, z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  copCount(): number {
    let n = 0;
    for (const p of this.peds) if (p.cop && p.state !== 'dead') n++;
    return n;
  }

  update(
    dt: number, t: number,
    px: number, py: number, pz: number,
    playerVisible: boolean, wanted: number,
    onCopShoot: (p: Ped) => void,
    drawDist: number,
  ): void {
    this.streamT -= dt;
    if (this.streamT <= 0) {
      this.streamT = 1.5;
      this.streamTo(px, pz);
    }
    for (const p of this.peds) {
      p.flinch = Math.max(0, p.flinch - dt);
      p.bleed = Math.max(0, p.bleed - dt * 2);

      if (p.state === 'dead') {
        p.deadT = Math.min(1, p.deadT + dt * 2.0);
        p.corpseT += dt;
        p.y = damp(p.y, this.phys.groundHeight(p.x, p.z, p.radius, p.y + 0.6), 18, dt);
        p.h.root.position.set(p.x, p.y, p.z);
        p.h.root.rotation.y = p.yaw;
        poseHumanoid(p.h, basePose(dt, t, 0, p, false));
        if (p.corpseT > 30 && dist2(p.x, p.z, px, pz) > 60 * 60) this.respawn(p, px, pz);
        this.detail(p, px, pz, drawDist);
        continue;
      }

      let tx = p.x, tz = p.z, want = 0;
      p.aiming = false;

      if (p.cop && wanted > 0) {
        // chase the player, stop at shooting distance and open fire
        const d = Math.hypot(px - p.x, pz - p.z);
        tx = px; tz = pz;
        want = d > 9 ? COP_RUN : d > 5 ? 1.6 : 0;
        p.shootCd -= dt;
        const los = this.phys.segmentClear(p.x, p.y + 1.5, p.z, px, py + 1.1, pz) > 0.985;
        if (d < 26 && los && playerVisible) {
          p.aiming = true;
          p.aimPitch = Math.atan2(py + 1.0 - (p.y + 1.45), d);
          if (p.shootCd <= 0) {
            p.shootCd = 0.55 + this.rng() * 0.7;
            onCopShoot(p);
          }
        }
      } else if (p.state === 'flee') {
        p.fleeT -= dt;
        const dx = p.x - p.fleeFromX, dz = p.z - p.fleeFromZ;
        const l = Math.hypot(dx, dz) || 1;
        tx = p.x + (dx / l) * 8;
        tz = p.z + (dz / l) * 8;
        want = RUN;
        if (p.fleeT <= 0) { p.state = 'walk'; p.li = ri(this.rng, 0, p.loop.length - 1); }
      } else if (p.state === 'idle') {
        p.idleT -= dt;
        want = 0;
        if (p.idleT <= 0) p.state = 'walk';
      } else {
        const n = p.loop[p.li];
        tx = n.x; tz = n.z;
        want = WALK;
        if (dist2(p.x, p.z, tx, tz) < 1.5) {
          p.li = (p.li + p.dir + p.loop.length) % p.loop.length;
          if (this.rng() < 0.12) { p.state = 'idle'; p.idleT = 1.5 + this.rng() * 3; }
        }
      }

      // steer + move
      const dx = tx - p.x, dz = tz - p.z;
      const l = Math.hypot(dx, dz);
      if (l > 0.05 && want > 0.05) {
        const desired = Math.atan2(dx, dz);
        p.yaw = angleDamp(p.yaw, desired, p.state === 'flee' ? 9 : 6, dt);
      } else if (p.aiming) {
        p.yaw = angleDamp(p.yaw, Math.atan2(px - p.x, pz - p.z), 10, dt);
      }
      p.speed = damp(p.speed, want, 6, dt);
      if (p.speed > 0.02) {
        const nx = p.x + Math.sin(p.yaw) * p.speed * dt;
        const nz = p.z + Math.cos(p.yaw) * p.speed * dt;
        this.phys.resolveCircle(nx, nz, p.radius, p.y, p.y + 1.7, 0.35, true);
        // if we are wedged, pick a new waypoint rather than grinding a wall
        if (Math.hypot(this.phys.outX - nx, this.phys.outZ - nz) > 0.02 && this.rng() < 0.04) {
          p.li = (p.li + 1) % p.loop.length;
        }
        p.x = this.phys.outX;
        p.z = this.phys.outZ;
      }
      p.y = damp(p.y, this.phys.groundHeight(p.x, p.z, p.radius, p.y + 0.6), 14, dt);

      p.h.root.position.set(p.x, p.y, p.z);
      p.h.root.rotation.y = p.yaw;
      poseHumanoid(p.h, basePose(dt, t, p.speed, p, p.aiming));
      this.detail(p, px, pz, drawDist);
    }
  }

  private detail(p: Ped, px: number, pz: number, drawDist: number): void {
    const d2 = dist2(p.x, p.z, px, pz);
    setHumanoidDetail(p.h, d2 < drawDist * drawDist, d2 < 42 * 42);
  }

  removeCops(): void {
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      if (!p.cop) continue;
      disposeHumanoid(p.h);
      this.peds.splice(i, 1);
    }
  }

  dispose(): void {
    for (const p of this.peds) disposeHumanoid(p.h);
    this.peds.length = 0;
  }
}

function basePose(dt: number, t: number, speed: number, p: Ped, aiming: boolean) {
  return {
    dt, t, speed, runSpeed: RUN, grounded: true, airVy: 0,
    aiming, aimPitch: p.aimPitch, dead: p.deadT, seated: false,
    punch: 0, flinch: p.flinch, steer: 0,
  };
}

export { WALK as PED_WALK, RUN as PED_RUN };
export function pedYawTo(p: Ped, x: number, z: number): number {
  return wrapPi(Math.atan2(x - p.x, z - p.z) - p.yaw);
}
export const clampPed = clamp;

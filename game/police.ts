import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, dist2, mulberry32, Rng } from './mathx';
import { Box, KIND, Physics } from './physics';
import { City, RoadNode } from './city';
import { Mats } from './materials';
import { Vehicle } from './vehicle';

/**
 * What the top three stars actually put on the street.
 *
 * Everything here is **pooled and pre-built**: two roadblocks and one helicopter are
 * constructed once, at boot, and then shown, hidden and moved. Nothing is allocated
 * when the heat rises, so going from one star to five costs a few `visible = true`
 * writes rather than a stall while the police are built.
 *
 * The blockade colliders go into `phys.dyn` — the per-frame dynamic list the engine
 * already rebuilds for vehicles — instead of into the static set, because adding to the
 * static set means rebuilding the whole spatial hash every time a roadblock moves.
 */

const BLOCKADES = 2;
/** How far ahead of the player a blockade is dropped. */
const BLOCK_MIN = 70;
const BLOCK_MAX = 165;

interface Blockade {
  group: THREE.Group;
  boxes: Box[];
  /** spike strip footprint */
  sx: number;
  sz: number;
  /** true when this blockade runs along X (so it blocks north–south traffic) */
  alongX: boolean;
  live: boolean;
  node: RoadNode | null;
  /** stops it being re-used the instant the player drives past */
  cool: number;
}

export class PoliceOps {
  /** 0..1 how loud the rotor should be right now; the engine hands this to the audio. */
  rotorVolume = 0;
  /** true while the helicopter has the player lit up */
  spotted = false;

  private blockades: Blockade[] = [];
  private heli: THREE.Group;
  private heliRotor: THREE.Group;
  private heliTail: THREE.Group;
  private beam: THREE.Mesh;
  private pool: THREE.Mesh;
  private heliAngle = 0;
  private heliY = 6;
  private heliOn = false;
  private rng: Rng = mulberry32(70707);
  private blockTimer = 0;

  constructor(private scene: THREE.Scene, private phys: Physics, private city: City, mats: Mats) {
    for (let i = 0; i < BLOCKADES; i++) this.blockades.push(makeBlockade(scene, phys, mats));
    const built = makeHelicopter(mats);
    this.heli = built.group;
    this.heliRotor = built.rotor;
    this.heliTail = built.tail;
    this.beam = built.beam;
    this.pool = built.pool;
    this.heli.visible = false;
    this.pool.visible = false;
    this.beam.visible = false;
    // The beam lives in world space, not under the aircraft: aiming a child means
    // undoing the parent's bank and yaw every frame for no benefit.
    scene.add(this.heli, this.beam, this.pool);
  }

  /**
   * Called every frame after the engine has refilled `phys.dyn` from the vehicles, so a
   * live blockade is as solid as a parked car and costs the same to test against.
   */
  addColliders(dyn: Box[]): void {
    for (const b of this.blockades) {
      if (!b.live) continue;
      for (const box of b.boxes) dyn.push(box);
    }
  }

  /**
   * Has this car just driven over a live spike strip? One rect test per live blockade.
   * Returns true once per crossing — the caller shreds the tyres.
   */
  spikeHit(v: Vehicle): boolean {
    if (v.spikeT > 0) return false;
    for (const b of this.blockades) {
      if (!b.live) continue;
      const halfA = b.alongX ? 9 : 1.4;
      const halfB = b.alongX ? 1.4 : 9;
      if (Math.abs(v.x - b.sx) < halfA && Math.abs(v.z - b.sz) < halfB) return true;
    }
    return false;
  }

  update(
    dt: number, t: number, wanted: number,
    px: number, py: number, pz: number, dirX: number, dirZ: number,
  ): void {
    /* ── 3 stars: roadblocks ─────────────────────────────────────────────── */
    for (const b of this.blockades) {
      b.cool = Math.max(0, b.cool - dt);
      // retire one the player has left well behind, so the pool can get ahead again
      if (b.live && b.node && dist2(b.node.x, b.node.z, px, pz) > (BLOCK_MAX + 90) ** 2) {
        this.retire(b);
      }
    }
    if (wanted >= 3) {
      this.blockTimer -= dt;
      if (this.blockTimer <= 0) {
        this.blockTimer = 4;
        const free = this.blockades.find((b) => !b.live && b.cool <= 0);
        if (free) this.deploy(free, px, pz, dirX, dirZ);
      }
    } else if (this.blockades.some((b) => b.live)) {
      for (const b of this.blockades) this.retire(b);
    }

    /* ── 5 stars: the search helicopter ──────────────────────────────────── */
    const wantHeli = wanted >= 5;
    if (wantHeli && !this.heliOn) {
      this.heliOn = true;
      this.heli.visible = true;
      this.beam.visible = true;
      this.pool.visible = true;
      // arrive from off the map rather than fading in over the player's head
      this.heliAngle = this.rng() * Math.PI * 2;
      this.heliY = 95;
    } else if (!wantHeli && this.heliOn) {
      this.heliOn = false;
      this.heli.visible = false;
      this.beam.visible = false;
      this.pool.visible = false;
      this.spotted = false;
      this.rotorVolume = 0;
    }

    if (this.heliOn) {
      this.heliAngle += dt * 0.42;
      const R = 34;
      const hx = px + Math.cos(this.heliAngle) * R;
      const hz = pz + Math.sin(this.heliAngle) * R;
      this.heliY += (42 - this.heliY) * Math.min(1, dt * 0.6);
      this.heli.position.set(hx, this.heliY, hz);
      // nose along the orbit, banked into the turn
      this.heli.rotation.y = Math.atan2(-Math.sin(this.heliAngle), Math.cos(this.heliAngle)) + Math.PI / 2;
      this.heli.rotation.z = -0.16;
      this.heliRotor.rotation.y = t * 28;
      this.heliTail.rotation.x = t * 34;

      // The beam: one cone, authored apex-up and spanning y 0 to -1, so aiming it is a
      // single setFromUnitVectors onto the direction from the aircraft to the target.
      // No SpotLight — a shadow-casting spotlight means rendering the scene a second
      // time from the helicopter, every frame, which is the most expensive thing in the
      // engine and would buy nothing you can see from forty metres up.
      const dx = px - hx, dy = (py + 1) - this.heliY, dz = pz - hz;
      const len = Math.max(1, Math.hypot(dx, dy, dz));
      TMP.set(dx / len, dy / len, dz / len);
      this.beam.position.set(hx, this.heliY - 1.2, hz);
      this.beam.quaternion.setFromUnitVectors(DOWN, TMP);
      this.beam.scale.set(len * 0.14, len, len * 0.14);

      this.pool.position.set(px, this.phys.groundHeight(px, pz, 0.5, py + 2) + 0.06, pz);
      const flicker = 0.72 + Math.sin(t * 9) * 0.06;
      (this.pool.material as THREE.MeshBasicMaterial).opacity = 0.3 * flicker;
      (this.beam.material as THREE.MeshBasicMaterial).opacity = 0.09 * flicker;
      this.spotted = true;
      this.rotorVolume = clamp(1 - len / 130, 0.15, 1);
    }
  }

  private deploy(b: Blockade, px: number, pz: number, dirX: number, dirZ: number): void {
    let best: RoadNode | null = null;
    let bestScore = -1e9;
    for (const n of this.city.nodes) {
      const dx = n.x - px, dz = n.z - pz;
      const d = Math.hypot(dx, dz);
      if (d < BLOCK_MIN || d > BLOCK_MAX) continue;
      if (this.blockades.some((o) => o.live && o.node === n)) continue;
      // strongly prefer junctions the player is heading towards
      const ahead = (dx * dirX + dz * dirZ) / (d || 1);
      if (ahead < 0.45) continue;
      const score = ahead * 100 - d * 0.1;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    if (!best) return;

    // Lay the barrier across the approach the player is on: if they are coming mostly
    // along Z, the line of barriers runs along X.
    const alongX = Math.abs(dirZ) > Math.abs(dirX);
    b.alongX = alongX;
    b.node = best;
    b.live = true;
    b.group.visible = true;
    b.group.position.set(best.x, 0, best.z);
    b.group.rotation.y = alongX ? 0 : Math.PI / 2;
    b.sx = best.x;
    b.sz = best.z;

    // three collider slabs with a gap in the middle: a roadblock you cannot squeeze past
    // is a wall, and a wall on the only bridge would strand the player
    const halfLong = alongX ? 5.6 : 1.1;
    const halfShort = alongX ? 1.1 : 5.6;
    const offs = [-6.2, 6.2];
    for (let i = 0; i < b.boxes.length; i++) {
      const o = offs[i] ?? 0;
      const cx = best.x + (alongX ? o : 0);
      const cz = best.z + (alongX ? 0 : o);
      const box = b.boxes[i];
      box.minX = cx - halfLong;
      box.maxX = cx + halfLong;
      box.minZ = cz - halfShort;
      box.maxZ = cz + halfShort;
      box.bottom = 0;
      box.top = 1.1;
    }
  }

  private retire(b: Blockade): void {
    if (!b.live) return;
    b.live = false;
    b.node = null;
    b.group.visible = false;
    b.cool = 12;
  }

  /** Everything goes away the moment the heat does. */
  clear(): void {
    for (const b of this.blockades) this.retire(b);
    this.heliOn = false;
    this.heli.visible = false;
    this.beam.visible = false;
    this.pool.visible = false;
    this.spotted = false;
    this.rotorVolume = 0;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.heli, this.beam, this.pool);
    for (const b of this.blockades) this.scene.remove(b.group);
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);
const TMP = new THREE.Vector3();

/**
 * Four barriers, two beacons and a spike strip.
 *
 * Merged down to three meshes. Authored one-part-at-a-time this is forty-five objects
 * — thirty-three of them individual spikes — and two deployed blockades were adding
 * ninety draw calls to a frame that already had a police chase in it. Nothing here ever
 * moves relative to anything else here, so it is merged once at boot and the group is
 * simply positioned.
 */
function makeBlockade(scene: THREE.Scene, phys: Physics, mats: Mats): Blockade {
  const g = new THREE.Group();
  g.visible = false;

  const stripes: THREE.BufferGeometry[] = [];
  const metal: THREE.BufferGeometry[] = [];
  const lamps: THREE.BufferGeometry[] = [];
  const at = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
    geo.translate(x, y, z);
    return geo;
  };

  for (const x of [-6.2, 6.2]) {
    stripes.push(at(new THREE.BoxGeometry(4.4, 0.34, 0.16), x, 0.86, 0));
    stripes.push(at(new THREE.BoxGeometry(4.4, 0.34, 0.16), x, 0.48, 0));
    for (const lx of [-1.9, 1.9]) {
      metal.push(at(new THREE.BoxGeometry(0.12, 1.0, 0.9), x + lx, 0.5, 0));
    }
  }
  for (const bx of [-8.6, 8.6]) lamps.push(at(new THREE.SphereGeometry(0.2, 8, 6), bx, 1.1, 0));

  // spike strip: one bar and thirty-three cones, all into the metal batch
  metal.push(at(new THREE.BoxGeometry(18, 0.09, 0.55), 0, 0.07, 0));
  for (let i = -16; i <= 16; i++) {
    metal.push(at(new THREE.ConeGeometry(0.05, 0.26, 4), i * 0.55, 0.22, 0));
  }

  const add = (parts: THREE.BufferGeometry[], mat: THREE.Material) => {
    const merged = mergeGeometries(parts, false);
    if (!merged) return;
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  };
  add(stripes, stripeMat());
  add(metal, mats.metal);
  add(lamps, new THREE.MeshBasicMaterial({ color: 0x2f6fd0 }));
  scene.add(g);

  // colliders are created up front and parked outside the world until deployed
  const boxes: Box[] = [];
  for (let i = 0; i < 2; i++) {
    boxes.push({ minX: 0, maxX: 0, minZ: 0, maxZ: 0, bottom: 0, top: 1.1, kind: KIND.Fence });
  }
  void phys;
  return { group: g, boxes, sx: 0, sz: 0, alongX: true, live: false, node: null, cool: 0 };
}

let stripeTex: THREE.Texture | null = null;
function stripeMat(): THREE.MeshStandardMaterial {
  if (!stripeTex) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 16;
    const x = c.getContext('2d')!;
    x.fillStyle = '#e8e4dc';
    x.fillRect(0, 0, 64, 16);
    x.fillStyle = '#c8322a';
    for (let i = -1; i < 5; i++) {
      x.beginPath();
      x.moveTo(i * 16, 0); x.lineTo(i * 16 + 8, 0);
      x.lineTo(i * 16 + 16, 16); x.lineTo(i * 16 + 8, 16);
      x.closePath(); x.fill();
    }
    stripeTex = new THREE.CanvasTexture(c);
    stripeTex.wrapS = stripeTex.wrapT = THREE.RepeatWrapping;
    stripeTex.repeat.set(3, 1);
  }
  return new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.7 });
}

/**
 * The search helicopter: a fuselage, a boom, two spinning rotors, a beam cone and a
 * ground pool.
 *
 * The airframe is merged into a single mesh, because none of it moves relative to the
 * rest of it and a silhouette forty metres up does not need sixteen draw calls. Only the
 * things that genuinely move or need their own material stay separate: the two rotors,
 * the canopy glass and the two navigation lights.
 */
function makeHelicopter(mats: Mats): {
  group: THREE.Group; rotor: THREE.Group; tail: THREE.Group; beam: THREE.Mesh; pool: THREE.Mesh;
} {
  const g = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0x1b2b48, roughness: 0.5, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.7 });

  /* ── airframe: one mesh ── */
  const hull: THREE.BufferGeometry[] = [];
  const body = new THREE.SphereGeometry(1.5, 12, 9);
  body.scale(1, 0.95, 1.9);
  hull.push(body);
  const boom = new THREE.CylinderGeometry(0.22, 0.4, 4.6, 8);
  boom.rotateX(Math.PI / 2);
  boom.translate(0, 0.4, -3.4);
  hull.push(boom);
  const fin = new THREE.BoxGeometry(0.14, 1.3, 0.9);
  fin.translate(0, 1.1, -5.4);
  hull.push(fin);
  const airframe = mergeGeometries(hull, false);
  if (airframe) {
    const m = new THREE.Mesh(airframe, shell);
    m.castShadow = true;
    g.add(m);
  }

  /* ── skids and struts: one mesh, its own darker material ── */
  const gear: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const skid = new THREE.CylinderGeometry(0.09, 0.09, 4.2, 6);
    skid.rotateX(Math.PI / 2);
    skid.translate(sx * 1.15, -1.5, 0.2);
    gear.push(skid);
    const strut = new THREE.BoxGeometry(0.12, 0.9, 0.12);
    strut.translate(sx * 1.05, -1.05, 0.4);
    gear.push(strut);
  }
  const gearGeo = mergeGeometries(gear, false);
  if (gearGeo) g.add(new THREE.Mesh(gearGeo, dark));

  const glass = new THREE.Mesh(new THREE.SphereGeometry(1.15, 10, 8), new THREE.MeshStandardMaterial({
    color: 0x7fa8c8, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.55,
  }));
  glass.scale.set(0.95, 0.8, 1.1);
  glass.position.set(0, 0.15, 1.55);
  g.add(glass);

  /* ── the parts that spin ── */
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.55, 0);
  const blades: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.2, 0.26, 0.4, 8)];
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.BoxGeometry(9.6, 0.06, 0.42);
    blade.rotateY((i / 4) * Math.PI * 2);
    blade.translate(0, 0.16, 0);
    blades.push(blade);
  }
  const rotorGeo = mergeGeometries(blades, false);
  if (rotorGeo) rotor.add(new THREE.Mesh(rotorGeo, dark));
  g.add(rotor);

  const tail = new THREE.Group();
  tail.position.set(0.28, 1.1, -5.4);
  const tailParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const b = new THREE.BoxGeometry(0.05, 1.7, 0.2);
    b.rotateX((i / 3) * Math.PI * 2);
    tailParts.push(b);
  }
  const tailGeo = mergeGeometries(tailParts, false);
  if (tailGeo) tail.add(new THREE.Mesh(tailGeo, dark));
  g.add(tail);

  // navigation lights, as unlit dots — cheaper than any light and reads fine at range
  for (const [lx, col] of [[-1.6, 0xd03a3a], [1.6, 0x3ad06a]] as [number, number][]) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 5), new THREE.MeshBasicMaterial({ color: col }));
    l.position.set(lx, -0.2, 0.6);
    g.add(l);
  }

  // Unit cone: apex at y = 0, base of radius 1 at y = -1. Scaling y gives its length and
  // scaling x/z gives its spread, so one geometry covers every distance.
  const beamGeo = new THREE.ConeGeometry(1, 1, 14, 1, true);
  beamGeo.translate(0, -0.5, 0);
  const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
    color: 0xfff3d0, transparent: true, opacity: 0.09, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));

  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(5.5, 24),
    new THREE.MeshBasicMaterial({
      color: 0xfff0c8, transparent: true, opacity: 0.3, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  void mats;
  return { group: g, rotor, tail, beam, pool };
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Mats, uvScale, uvScaleBox } from './materials';
import { KIND, Physics } from './physics';
import { Rng } from './mathx';
import { AoGrid } from './ao';

/**
 * Shared layout toolkit: the geometry batcher, the street furniture and the data types
 * that both the invented city grid (city.ts) and the real Rahim Garden scheme (scheme.ts)
 * are built from.
 */

/** feet → metres. The housing scheme's plan is dimensioned in feet, so we keep it honest. */
export const FT = 0.3048;

export const ROAD_Y = 0.02;
export const PAINT_Y = 0.045;
export const WALK_Y = 0.16;
export const LOT_Y = 0.17;

/** Pakistan drives on the left — flip this for right-hand traffic. */
export const LEFT_HAND_TRAFFIC = true;
/** Default lane offset from a centre line; narrow streets scale this down by width. */
export const LANE_OFF = 4;

export interface WorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface RoadNode {
  x: number;
  z: number;
  nb: RoadNode[];
  /** carriageway width of the edge to the matching entry in `nb` */
  nbWidth: number[];
}

export function connect(a: RoadNode, b: RoadNode, width: number): void {
  if (a === b || a.nb.includes(b)) return;
  a.nb.push(b);
  a.nbWidth.push(width);
  b.nb.push(a);
  b.nbWidth.push(width);
}

export function laneOffsetFor(from: RoadNode, to: RoadNode): number {
  const i = from.nb.indexOf(to);
  const w = i >= 0 ? from.nbWidth[i] : 16;
  return Math.min(LANE_OFF, w / 4);
}

export interface Poi {
  name: string;
  x: number;
  z: number;
  kind: 'mosque' | 'market' | 'police' | 'park' | 'plaza' | 'shop' | 'home' | 'gate';
}

export interface Shop {
  x: number;
  z: number;
  yaw: number;
  name: string;
  kind: 'food' | 'ammo' | 'health';
}

export interface MinimapData {
  roads: { x1: number; z1: number; x2: number; z2: number; w: number }[];
  blocks: { x: number; z: number; s: number }[];
  buildings: { x: number; z: number; w: number; d: number }[];
  parks: { x: number; z: number; w: number; d: number }[];
  water: { x: number; z: number; w: number; d: number }[];
  labels: { t: string; x: number; z: number }[];
}

/** A body of water the engine has to treat as lethal: drop below `surface` and you drown. */
export interface WaterZone {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  surface: number;
}

export interface City {
  root: THREE.Group;
  nodes: RoadNode[];
  pedLoops: { x: number; z: number }[][];
  parkSpots: { x: number; z: number; yaw: number }[];
  roadSpawns: { x: number; z: number; yaw: number }[];
  shops: Shop[];
  pois: Poi[];
  minimap: MinimapData;
  itemSpots: { x: number; y: number; z: number }[];
  pickupSpots: { x: number; z: number }[];
  playerStart: { x: number; z: number; yaw: number };
  policeStation: { x: number; z: number };
  hospital: { x: number; z: number };
  bounds: WorldBounds;
  waterZones: WaterZone[];
  /** Which map in maps.ts produced this world. */
  mapId: string;
  mapName: string;
  lampGlow: THREE.Points;
  setNight(n: number): void;
  triangles: number;
}

/** Everything the district builders write into. */
export interface Collect {
  minimap: MinimapData;
  pedLoops: { x: number; z: number }[][];
  parkSpots: { x: number; z: number; yaw: number }[];
  roadSpawns: { x: number; z: number; yaw: number }[];
  shops: Shop[];
  pois: Poi[];
  itemSpots: { x: number; y: number; z: number }[];
  pickupSpots: { x: number; z: number }[];
  lampPts: number[];
  signs: THREE.Mesh[];
  nodes: RoadNode[];
  waterZones: WaterZone[];
}

export function newCollect(): Collect {
  return {
    minimap: { roads: [], blocks: [], buildings: [], parks: [], water: [], labels: [] },
    pedLoops: [], parkSpots: [], roadSpawns: [], shops: [], pois: [],
    itemSpots: [], pickupSpots: [], lampPts: [], signs: [], nodes: [], waterZones: [],
  };
}

/* ── geometry batcher ─────────────────────────────────────────────────────── */

export class Builder {
  private groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  triangles = 0;

  push(mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number, rotY = 0, rotX = 0, rotZ = 0): void {
    this.q.setFromEuler(this.e.set(rotX, rotY, rotZ));
    this.m.compose(this.v.set(x, y, z), this.q, this.one);
    geo.applyMatrix4(this.m);
    geo.deleteAttribute('uv1');
    let list = this.groups.get(mat);
    if (!list) this.groups.set(mat, (list = []));
    list.push(geo);
    this.triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  }

  /** Box with world-space-constant texture tiling. */
  box(mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number, rotY = 0, tile = 4): void {
    const g = new THREE.BoxGeometry(w, h, d);
    if (tile > 0) uvScaleBox(g, w, h, d, tile);
    this.push(mat, g, x, y, z, rotY);
  }

  /**
   * Flat horizontal quad (roads, lot ground, paint).
   *
   * Subdivided on a ~4m grid when it is big enough to matter: baked AO is per-vertex, so a
   * single 64m quad with four corners cannot show a kerb's contact shadow. The extra
   * triangles are free — they merge into the same batch.
   */
  quad(mat: THREE.Material, x: number, y: number, z: number, w: number, d: number, tile = 4, rotY = 0): void {
    const sw = w > 7 ? Math.min(24, Math.round(w / 4)) : 1;
    const sd = d > 7 ? Math.min(24, Math.round(d / 4)) : 1;
    const g = new THREE.PlaneGeometry(w, d, sw, sd);
    if (tile > 0) uvScale(g, w / tile, d / tile);
    this.push(mat, g, x, y, z, rotY, -Math.PI / 2);
  }

  cyl(mat: THREE.Material, x: number, y: number, z: number, rt: number, rb: number, h: number, seg = 8, rotX = 0): void {
    this.push(mat, new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, 0, rotX);
  }

  /** Half-cylinder cap, used for the rounded ends of the scheme's park. */
  halfCyl(mat: THREE.Material, x: number, y: number, z: number, r: number, h: number, rotY: number, seg = 14): void {
    this.push(mat, new THREE.CylinderGeometry(r, r, h, seg, 1, false, 0, Math.PI), x, y, z, rotY);
  }

  sphere(mat: THREE.Material, x: number, y: number, z: number, r: number, w = 10, h = 7, sy = 1): void {
    const g = new THREE.SphereGeometry(r, w, h);
    if (sy !== 1) g.scale(1, sy, 1);
    this.push(mat, g, x, y, z);
  }

  cone(mat: THREE.Material, x: number, y: number, z: number, r: number, h: number, seg = 8, rotY = 0): void {
    this.push(mat, new THREE.ConeGeometry(r, h, seg), x, y, z, rotY);
  }

  /**
   * Gable roof from two slabs. `w` is the ridge length, `d` the span being sloped.
   * The tilt is applied on the correct world axis instead of composing Euler angles.
   */
  gable(mat: THREE.Material, x: number, y: number, z: number, w: number, d: number, rise: number, slopeAlongX = false): void {
    const slope = Math.atan2(rise, d / 2);
    const len = Math.hypot(d / 2, rise) + 0.25;
    const off = d / 4, cy = rise / 2;
    if (!slopeAlongX) {
      const a = new THREE.BoxGeometry(w + 0.5, 0.16, len);
      uvScaleBox(a, w, 0.16, len, 3);
      const b = a.clone();
      this.push(mat, a, x, y + cy, z + off, 0, slope, 0);
      this.push(mat, b, x, y + cy, z - off, 0, -slope, 0);
    } else {
      const a = new THREE.BoxGeometry(len, 0.16, w + 0.5);
      uvScaleBox(a, len, 0.16, w, 3);
      const b = a.clone();
      this.push(mat, a, x + off, y + cy, z, 0, 0, -slope);
      this.push(mat, b, x - off, y + cy, z, 0, 0, slope);
    }
  }

  /** Merge every batch into one mesh per material, baking AO into vertex colours. */
  finish(root: THREE.Group, ao?: AoGrid): void {
    for (const [mat, list] of this.groups) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      if (ao) bakeAo(merged, ao);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
      list.length = 0;
    }
    this.groups.clear();
  }
}

/* ── street furniture ─────────────────────────────────────────────────────── */

let M: Mats | null = null;

/** Called once before any district is built so prop helpers can stay terse. */
export function bindProps(mats: Mats): void {
  M = mats;
}

export function tree(B: Builder, phys: Physics, rng: Rng, x: number, z: number, s: number, baseY = WALK_Y): void {
  const m = M!;
  const h = 2.4 * s;
  B.cyl(m.trunk, x, baseY + h / 2, z, 0.13 * s, 0.2 * s, h, 7);
  const top = baseY + h;
  B.sphere(m.foliage, x, top + 0.75 * s, z, 1.35 * s, 9, 7, 0.92);
  B.sphere(m.foliage, x + 0.5 * s, top + 1.5 * s, z + 0.3 * s, 0.9 * s, 8, 6, 0.9);
  B.sphere(m.foliage, x - 0.55 * s, top + 1.35 * s, z - 0.4 * s, 0.8 * s, 8, 6, 0.9);
  if (rng() > 0.5) B.sphere(m.foliage, x + 0.1 * s, top + 2.1 * s, z - 0.1 * s, 0.7 * s, 8, 6, 0.9);
  phys.addCentered(x, z, 0.3 * s, 0.3 * s, 0, baseY + h * 0.8, KIND.Prop);
}

/** Date palm: a bare leaning trunk with a crown of drooping fronds. Desert map. */
export function palm(B: Builder, phys: Physics, rng: Rng, x: number, z: number, s: number, baseY = WALK_Y): void {
  const m = M!;
  const h = 6.2 * s;
  const lean = (rng() - 0.5) * 0.16;
  // the trunk is four stacked segments so the lean reads as a curve, not a tilted pole
  for (let i = 0; i < 4; i++) {
    const t = i / 4;
    B.cyl(m.trunk, x + lean * h * t * t, baseY + h * (t + 0.125), z, 0.16 * s, 0.21 * s, h / 4 + 0.05, 7);
  }
  const tx = x + lean * h, ty = baseY + h;
  for (let a = 0; a < 9; a++) {
    const an = (a / 9) * Math.PI * 2 + rng() * 0.3;
    const r = 1.9 * s;
    B.box(m.foliage, tx + Math.cos(an) * r * 0.55, ty + 0.35 * s, z + Math.sin(an) * r * 0.55,
      r * 1.25, 0.1, 0.45 * s, -an, 0);
  }
  B.sphere(m.foliage, tx, ty + 0.15 * s, z, 0.55 * s, 8, 6, 0.8);
  phys.addCentered(x, z, 0.28 * s, 0.28 * s, 0, baseY + h * 0.8, KIND.Prop);
}

/** Conifer: a straight trunk under three stacked cones. Pine valley map. */
export function pine(B: Builder, phys: Physics, rng: Rng, x: number, z: number, s: number, baseY = WALK_Y): void {
  const m = M!;
  const h = 3.1 * s;
  B.cyl(m.trunk, x, baseY + h / 2, z, 0.14 * s, 0.24 * s, h, 7);
  const top = baseY + h * 0.42;
  const jitter = rng() * 0.5;
  B.cone(m.foliage, x, top + 1.5 * s, z, 2.05 * s, 3.4 * s, 9, jitter);
  B.cone(m.foliage, x, top + 3.5 * s, z, 1.5 * s, 3.0 * s, 9, jitter + 0.4);
  B.cone(m.foliage, x, top + 5.3 * s, z, 0.95 * s, 2.6 * s, 8, jitter + 0.8);
  phys.addCentered(x, z, 0.32 * s, 0.32 * s, 0, baseY + h * 0.9, KIND.Prop);
}

export type Species = 'broadleaf' | 'palm' | 'pine';

/** One call site for every map: the theme picks the species, the generator stays the same. */
export function plant(
  B: Builder, phys: Physics, rng: Rng, x: number, z: number, s: number,
  species: Species = 'broadleaf', baseY = WALK_Y,
): void {
  if (species === 'palm') palm(B, phys, rng, x, z, s, baseY);
  else if (species === 'pine') pine(B, phys, rng, x, z, s, baseY);
  else tree(B, phys, rng, x, z, s, baseY);
}

export function lamp(
  B: Builder, phys: Physics, x: number, z: number, ax: number, az: number,
  lampPts: number[], baseY = WALK_Y, h = 5.4,
): void {
  const m = M!;
  B.cyl(m.metal, x, baseY + h / 2, z, 0.08, 0.13, h, 6);
  const armX = ax * 0.9, armZ = az * 0.9;
  B.box(m.metal, x + armX / 2, baseY + h, z + armZ / 2, ax ? 0.9 : 0.14, 0.14, az ? 0.9 : 0.14, 0, 2);
  B.box(m.metal, x + armX, baseY + h - 0.16, z + armZ, 0.5, 0.2, 0.34, 0, 2);
  lampPts.push(x + armX, baseY + h - 0.3, z + armZ);
  phys.addCentered(x, z, 0.2, 0.2, 0, baseY + 1.2, KIND.Prop);
}

export function bench(B: Builder, phys: Physics, x: number, z: number, rotY: number, baseY = WALK_Y): void {
  const m = M!;
  B.box(m.wood, x, baseY + 0.45, z, 1.9, 0.1, 0.55, rotY, 2);
  B.box(m.wood, x - Math.sin(rotY) * 0.24, baseY + 0.78, z - Math.cos(rotY) * 0.24, 1.9, 0.55, 0.09, rotY, 2);
  B.box(m.metal, x - Math.cos(rotY) * 0.82, baseY + 0.22, z + Math.sin(rotY) * 0.82, 0.1, 0.44, 0.5, rotY, 2);
  B.box(m.metal, x + Math.cos(rotY) * 0.82, baseY + 0.22, z - Math.sin(rotY) * 0.82, 0.1, 0.44, 0.5, rotY, 2);
  phys.addCentered(x, z, 1, 0.4, 0, baseY + 0.5, KIND.Prop);
}

export function cart(B: Builder, phys: Physics, x: number, z: number, yaw: number): void {
  const m = M!;
  B.box(m.wood, x, LOT_Y + 0.78, z, 1.5, 0.7, 0.85, yaw, 2);
  B.cyl(m.metal, x - 0.6, LOT_Y + 0.3, z + 0.5, 0.3, 0.3, 0.08, 10, Math.PI / 2);
  B.cyl(m.metal, x + 0.6, LOT_Y + 0.3, z + 0.5, 0.3, 0.3, 0.08, 10, Math.PI / 2);
  B.cyl(m.metal, x, LOT_Y + 1.7, z, 0.04, 0.04, 1.8, 5);
  B.cone(m.roof, x, LOT_Y + 2.45, z, 1.25, 0.5, 8, yaw);
  for (let i = 0; i < 8; i++) {
    B.sphere(m.foliage, x - 0.5 + (i % 4) * 0.33, LOT_Y + 1.2, z + (i < 4 ? -0.18 : 0.18), 0.11, 7, 5);
  }
  phys.addCentered(x, z, 0.85, 0.6, 0, LOT_Y + 1.1, KIND.Prop);
}

/* ── street life ──────────────────────────────────────────────────────────── */

function rawBox(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

/**
 * Overhead power lines: concrete-and-timber poles, three sagging conductors, the odd
 * transformer drum. Nothing says South Asian street faster than a skyline criss-crossed
 * with cables, and it is only thin boxes merged into the existing batches.
 */
export function powerLine(
  B: Builder, phys: Physics, x0: number, z0: number, x1: number, z1: number,
  spacing = 28, baseY = WALK_Y,
): void {
  const m = M!;
  const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
  const span = alongX ? x1 - x0 : z1 - z0;
  const n = Math.max(1, Math.round(Math.abs(span) / spacing));
  const step = span / n;
  const H = 8.4;
  const at2 = (i: number): [number, number] => (alongX ? [x0 + step * i, z0] : [x0, z0 + step * i]);

  for (let i = 0; i <= n; i++) {
    const [px, pz] = at2(i);
    B.cyl(m.wood, px, baseY + H / 2, pz, 0.12, 0.19, H, 7);
    B.box(m.wood, px, baseY + H - 0.45, pz, alongX ? 0.16 : 2.5, 0.14, alongX ? 2.5 : 0.16, 0, 2);
    for (const o of [-1, 0, 1]) {
      B.cyl(m.concrete, alongX ? px : px + o, baseY + H - 0.24, alongX ? pz + o : pz, 0.055, 0.07, 0.28, 6);
    }
    if (i % 3 === 1) {
      B.cyl(m.metal, px + (alongX ? 0.45 : 0), baseY + H - 2.2, pz + (alongX ? 0 : 0.45), 0.32, 0.32, 0.85, 10);
    }
    phys.addCentered(px, pz, 0.22, 0.22, 0, baseY + 2.2, KIND.Prop);

    if (i === n) break;
    const [qx, qz] = at2(i + 1);
    for (const o of [-1, 0, 1]) {
      cable(B, alongX ? px : px + o, alongX ? pz + o : pz, alongX ? qx : qx + o, alongX ? qz + o : qz, baseY + H - 0.28, 0.8, alongX);
    }
  }
}

/** One conductor, as four chords of its catenary sag. */
function cable(B: Builder, x0: number, z0: number, x1: number, z1: number, y: number, sag: number, alongX: boolean): void {
  const m = M!;
  const SEG = 4;
  const dx = (x1 - x0) / SEG, dz = (z1 - z0) / SEG;
  const flat = Math.hypot(dx, dz);
  for (let k = 0; k < SEG; k++) {
    const t0 = k / SEG, t1 = (k + 1) / SEG;
    const y0 = y - sag * 4 * t0 * (1 - t0);
    const y1 = y - sag * 4 * t1 * (1 - t1);
    const len = Math.hypot(flat, y1 - y0);
    const tilt = Math.atan2(y1 - y0, flat);
    const cx = x0 + dx * (k + 0.5), cz = z0 + dz * (k + 0.5), cy = (y0 + y1) / 2;
    // rotation about Z lifts +X; rotation about X lifts +Z the other way round
    if (alongX) B.push(m.metal, rawBox(len, 0.045, 0.045), cx, cy, cz, 0, 0, tilt);
    else B.push(m.metal, rawBox(0.045, 0.045, len), cx, cy, cz, 0, -tilt, 0);
  }
}

/** A charpai — the woven rope bed that lives outside every second house. */
export function charpai(B: Builder, phys: Physics, x: number, z: number, rotY: number, baseY = LOT_Y): void {
  const m = M!;
  const w = 1.0, l = 1.9, h = 0.42;
  for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
    const lx = x + (rotY ? oz * l / 2 : ox * w / 2), lz = z + (rotY ? ox * w / 2 : oz * l / 2);
    B.cyl(m.wood, lx, baseY + h / 2, lz, 0.05, 0.07, h, 6);
  }
  // frame
  B.box(m.wood, x, baseY + h, z, rotY ? l : w, 0.09, rotY ? w : l, 0, 2);
  // rope weave: a lattice of thin strips
  for (let i = -3; i <= 3; i++) {
    B.box(m.dirt, x + (rotY ? 0 : i * w / 7), baseY + h + 0.06, z + (rotY ? i * w / 7 : 0), rotY ? l : 0.05, 0.03, rotY ? 0.05 : l, 0, 2);
  }
  for (let i = -6; i <= 6; i++) {
    B.box(m.dirt, x + (rotY ? i * l / 13 : 0), baseY + h + 0.09, z + (rotY ? 0 : i * l / 13), rotY ? 0.05 : w, 0.03, rotY ? w : 0.05, 0, 2);
  }
  phys.addCentered(x, z, rotY ? l / 2 : w / 2, rotY ? w / 2 : l / 2, 0, baseY + h + 0.1, KIND.Prop);
}

/** Tandoor and naan counter: clay oven, stacked naan, a flour sack. */
export function tandoor(B: Builder, phys: Physics, x: number, z: number, baseY = LOT_Y): void {
  const m = M!;
  B.cyl(m.brick, x, baseY + 0.55, z, 0.52, 0.66, 1.1, 12);
  B.cyl(m.dirt, x, baseY + 1.12, z, 0.3, 0.42, 0.1, 12);          // mouth
  B.box(m.wood, x + 1.5, baseY + 0.45, z, 1.9, 0.09, 0.85, 0, 2); // counter
  for (const ox of [0.7, 2.3]) {
    B.cyl(m.wood, x + ox, baseY + 0.22, z - 0.3, 0.05, 0.05, 0.44, 5);
    B.cyl(m.wood, x + ox, baseY + 0.22, z + 0.3, 0.05, 0.05, 0.44, 5);
  }
  for (let i = 0; i < 5; i++) B.cyl(m.dirt, x + 1.2, baseY + 0.52 + i * 0.035, z + 0.1, 0.26, 0.26, 0.035, 10);
  B.box(m.dirt, x + 2.5, baseY + 0.3, z + 0.5, 0.6, 0.6, 0.45, 0, 2);   // flour sack
  phys.addCentered(x + 0.7, z, 1.8, 0.6, 0, baseY + 1.1, KIND.Prop);
}

/** Chai stall: kettle on a burner, glasses, a bench and a cloth awning. */
export function chaiStall(B: Builder, phys: Physics, x: number, z: number, rotY: number, baseY = LOT_Y): void {
  const m = M!;
  B.box(m.wood, x, baseY + 0.45, z, 1.7, 0.1, 0.8, rotY, 2);
  for (const ox of [-0.7, 0.7]) {
    for (const oz of [-0.3, 0.3]) {
      B.cyl(m.wood, x + Math.cos(rotY) * ox, baseY + 0.22, z - Math.sin(rotY) * ox + oz, 0.05, 0.05, 0.44, 5);
    }
  }
  // kettle: body, spout, lid
  B.cyl(m.metal, x - 0.35, baseY + 0.68, z, 0.2, 0.24, 0.36, 12);
  B.cyl(m.metal, x - 0.15, baseY + 0.78, z, 0.03, 0.05, 0.28, 6, Math.PI / 2.6);
  B.sphere(m.metal, x - 0.35, baseY + 0.88, z, 0.09, 8, 6);
  // glasses in a row
  for (let i = 0; i < 5; i++) B.cyl(m.glass, x + 0.15 + i * 0.14, baseY + 0.56, z + 0.2, 0.045, 0.04, 0.11, 6);
  // awning on two poles
  for (const ox of [-0.85, 0.85]) B.cyl(m.metal, x + ox, baseY + 1.15, z - 0.5, 0.035, 0.035, 1.5, 5);
  B.box(m.roof, x, baseY + 1.95, z - 0.1, 2.4, 0.07, 1.5, rotY, 3);
  bench(B, phys, x, z - 1.5, rotY, baseY);
  phys.addCentered(x, z, 0.95, 0.5, 0, baseY + 0.9, KIND.Prop);
}

/** Rooftop satellite dish — on half the roofs in the country. */
export function satelliteDish(B: Builder, x: number, y: number, z: number, rotY: number): void {
  const m = M!;
  B.box(m.metal, x, y + 0.06, z, 0.34, 0.12, 0.34, 0, 2);
  B.cyl(m.metal, x, y + 0.34, z, 0.035, 0.045, 0.5, 6);
  B.push(m.concrete, new THREE.CylinderGeometry(0.42, 0.42, 0.05, 14), x, y + 0.62, z, rotY, -0.9);
  B.cyl(m.metal, x + Math.sin(rotY) * 0.28, y + 0.78, z + Math.cos(rotY) * 0.28, 0.03, 0.03, 0.22, 5);
}

/** Washing line with clothes pegged out — the other half of every roof. */
export function laundryLine(B: Builder, x: number, y: number, z: number, len: number, rotY: number): void {
  const m = M!;
  const sx = Math.sin(rotY), cz = Math.cos(rotY);
  for (const t of [-0.5, 0.5]) {
    B.cyl(m.metal, x + sx * len * t, y + 0.6, z + cz * len * t, 0.03, 0.04, 1.2, 5);
  }
  B.box(m.metal, x, y + 1.16, z, sx ? len : 0.02, 0.02, sx ? 0.02 : len, 0, 2);
  // hanging cloth, alternating colours
  const cols = [m.plaster[0], m.plaster[3], m.plaster[2], m.plaster[4]];
  for (let i = 0; i < 4; i++) {
    const t = -0.36 + i * 0.24;
    B.box(cols[i % cols.length], x + sx * len * t, y + 0.86, z + cz * len * t, sx ? 0.42 : 0.05, 0.55, sx ? 0.05 : 0.42, 0, 2);
  }
}

/* ── plot number plates ───────────────────────────────────────────────────── */

let plateMat: THREE.MeshBasicMaterial | null = null;

/**
 * One 16×16 atlas holds plot numbers 0–255, so every gate plate in the scheme merges into
 * a single draw call instead of needing its own texture.
 */
function plateMaterial(): THREE.MeshBasicMaterial {
  if (plateMat) return plateMat;
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d')!;
  const cell = 64;
  g.fillStyle = '#14335e';
  g.fillRect(0, 0, 1024, 1024);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < 256; i++) {
    const cx = (i % 16) * cell, cy = Math.floor(i / 16) * cell;
    g.fillStyle = '#eef3f8';
    g.fillRect(cx + 4, cy + 4, cell - 8, cell - 8);
    g.fillStyle = '#14335e';
    g.font = `bold ${i > 99 ? 30 : 38}px "Trebuchet MS", system-ui, sans-serif`;
    g.fillText(String(i), cx + cell / 2, cy + cell / 2 + 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  plateMat = new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide });
  return plateMat;
}

export function numberPlate(B: Builder, n: number, x: number, y: number, z: number, rotY: number, size = 0.34): void {
  const g = new THREE.PlaneGeometry(size, size);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const idx = ((n % 256) + 256) % 256;
  const col = idx % 16, row = Math.floor(idx / 16);
  for (let i = 0; i < uv.count; i++) {
    // canvas row 0 is the top; three flips Y, so v runs from (15−row)/16 upwards
    uv.setXY(i, (col + uv.getX(i)) / 16, (15 - row + uv.getY(i)) / 16);
  }
  uv.needsUpdate = true;
  B.push(plateMaterial(), g, x, y, z, rotY);
}

/**
 * Write per-vertex occlusion into a merged geometry's colour attribute. Uint8 normalised
 * keeps it to 3 bytes a vertex — about 0.6MB for the whole city.
 */
function bakeAo(geo: THREE.BufferGeometry, ao: AoGrid): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
  const n = pos.count;
  const col = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = ao.sample(
      pos.getX(i), pos.getY(i), pos.getZ(i),
      nrm ? nrm.getX(i) : 0, nrm ? nrm.getY(i) : 1, nrm ? nrm.getZ(i) : 0,
    );
    const b = (v * 255) | 0;
    col[i * 3] = b;
    col[i * 3 + 1] = b;
    col[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
}

import { clamp } from './mathx';

export const KIND = {
  Ground: 0,
  Building: 1,
  Prop: 2,
  Fence: 3,
  Vehicle: 4,
} as const;

export type Kind = (typeof KIND)[keyof typeof KIND];

export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  bottom: number;
  top: number;
  kind: Kind;
  /** Back-reference for hit reporting (a Vehicle, a Ped, …). */
  owner?: unknown;
}

/**
 * A rectangle where the world floor is *below* zero — a dug canal, a dry wadi bed, a
 * harbour basin. Without this the ground query bottoms out at y = 0 everywhere and a
 * "river" is only a blue quad you drive straight across.
 */
export interface Pit {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** bed height, negative */
  bed: number;
}

export interface RayHit {
  t: number;
  box: Box | null;
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Axis-aligned collision world with a uniform spatial hash.
 *
 * Everything the player can bump into is an AABB with an explicit bottom/top, which is what
 * makes "walk up a 15cm curb but not through a wall" work: horizontal blocking only considers
 * boxes taller than the step height, and the ground query snaps you onto the tallest surface
 * below your feet. Movement is sub-stepped by the caller so nothing tunnels at high speed.
 */
export class Physics {
  boxes: Box[] = [];
  /** Rebuilt every frame from moving bodies; checked linearly (there are only dozens). */
  dyn: Box[] = [];
  /** Dug-out regions. A handful per map, so a linear scan is cheaper than any index. */
  pits: Pit[] = [];

  private cs = 12;
  private grid = new Map<number, number[]>();
  private stamp = new Int32Array(0);
  private mark = 1;
  private cand: Box[] = [];

  /** Result of the last resolveCircle() — avoids allocating a vector per call. */
  outX = 0;
  outZ = 0;
  outHit = false;

  addBox(minX: number, minZ: number, maxX: number, maxZ: number, bottom: number, top: number, kind: Kind = KIND.Building): Box {
    const b: Box = { minX, maxX, minZ, maxZ, bottom, top, kind };
    this.boxes.push(b);
    return b;
  }

  /** Dig a rectangle down to `bed`. Anything inside falls to that height instead of y = 0. */
  addPit(minX: number, minZ: number, maxX: number, maxZ: number, bed: number): Pit {
    const p: Pit = { minX, maxX, minZ, maxZ, bed };
    this.pits.push(p);
    return p;
  }

  /**
   * World floor under a point: zero, or the bed of the deepest pit it is inside.
   * The pit only counts when the whole probe circle is inside it, so a body standing on
   * the very lip of the embankment stays on the bank rather than snapping to the bed.
   */
  floorAt(x: number, z: number, r = 0): number {
    let y = 0;
    for (let i = 0; i < this.pits.length; i++) {
      const p = this.pits[i];
      if (x - r > p.minX && x + r < p.maxX && z - r > p.minZ && z + r < p.maxZ && p.bed < y) y = p.bed;
    }
    return y;
  }

  /** Centre + half-extent form — most of the city generator thinks this way. */
  addCentered(cx: number, cz: number, hx: number, hz: number, bottom: number, top: number, kind: Kind = KIND.Building): Box {
    return this.addBox(cx - hx, cz - hz, cx + hx, cz + hz, bottom, top, kind);
  }

  build(): void {
    this.grid.clear();
    this.stamp = new Int32Array(this.boxes.length);
    this.mark = 1;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const x0 = Math.floor(b.minX / this.cs), x1 = Math.floor(b.maxX / this.cs);
      const z0 = Math.floor(b.minZ / this.cs), z1 = Math.floor(b.maxZ / this.cs);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = this.key(cx, cz);
          let cell = this.grid.get(k);
          if (!cell) this.grid.set(k, (cell = []));
          cell.push(i);
        }
      }
    }
  }

  private key(cx: number, cz: number): number {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  /** Gather static boxes overlapping an XZ rect into the shared candidate buffer. */
  private query(minX: number, minZ: number, maxX: number, maxZ: number): Box[] {
    const out = this.cand;
    out.length = 0;
    const m = this.mark++;
    const x0 = Math.floor(minX / this.cs), x1 = Math.floor(maxX / this.cs);
    const z0 = Math.floor(minZ / this.cs), z1 = Math.floor(maxZ / this.cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const cell = this.grid.get(this.key(cx, cz));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const idx = cell[i];
          if (this.stamp[idx] === m) continue;
          this.stamp[idx] = m;
          out.push(this.boxes[idx]);
        }
      }
    }
    return out;
  }

  /**
   * Highest surface under a footprint circle, ignoring anything above `maxTop`
   * (so you climb curbs and stairs but do not teleport onto roofs).
   */
  groundHeight(x: number, z: number, r: number, maxTop: number, includeDyn = true): number {
    let best = this.floorAt(x, z, r);
    const c = this.query(x - r, z - r, x + r, z + r);
    for (let i = 0; i < c.length; i++) {
      const b = c[i];
      if (b.top > maxTop || b.top <= best) continue;
      if (this.circleTouches(x, z, r, b)) best = b.top;
    }
    if (includeDyn) {
      for (let i = 0; i < this.dyn.length; i++) {
        const b = this.dyn[i];
        if (b.top > maxTop || b.top <= best) continue;
        if (this.circleTouches(x, z, r, b)) best = b.top;
      }
    }
    return best;
  }

  private circleTouches(x: number, z: number, r: number, b: Box): boolean {
    const cx = clamp(x, b.minX, b.maxX), cz = clamp(z, b.minZ, b.maxZ);
    const dx = x - cx, dz = z - cz;
    return dx * dx + dz * dz < r * r;
  }

  /**
   * Push a vertical cylinder out of everything it overlaps.
   * `step` is how tall a ledge may be before it blocks instead of being climbed.
   */
  resolveCircle(x: number, z: number, r: number, feetY: number, headY: number, step: number, includeDyn = true, skip?: unknown): boolean {
    let px = x, pz = z, hit = false;
    const lo = feetY + step;
    const c = this.query(x - r - 1, z - r - 1, x + r + 1, z + r + 1);
    // Two passes: the second one settles inside-corner cases the first pass creates.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < c.length; i++) {
        if (this.push(c[i], px, pz, r, lo, headY)) { px = this.outX; pz = this.outZ; hit = true; }
      }
      if (includeDyn) {
        for (let i = 0; i < this.dyn.length; i++) {
          const b = this.dyn[i];
          if (skip !== undefined && b.owner === skip) continue;
          if (this.push(b, px, pz, r, lo, headY)) { px = this.outX; pz = this.outZ; hit = true; }
        }
      }
    }
    this.outX = px;
    this.outZ = pz;
    this.outHit = hit;
    return hit;
  }

  private push(b: Box, x: number, z: number, r: number, lo: number, headY: number): boolean {
    if (b.top <= lo || b.bottom >= headY) return false;
    const cx = clamp(x, b.minX, b.maxX), cz = clamp(z, b.minZ, b.maxZ);
    let dx = x - cx, dz = z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) return false;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      this.outX = cx + (dx / d) * r;
      this.outZ = cz + (dz / d) * r;
    } else {
      // Centre is inside the box: escape through the nearest face.
      const l = x - b.minX, ri = b.maxX - x, u = z - b.minZ, dn = b.maxZ - z;
      const m = Math.min(l, ri, u, dn);
      this.outX = x; this.outZ = z;
      if (m === l) this.outX = b.minX - r;
      else if (m === ri) this.outX = b.maxX + r;
      else if (m === u) this.outZ = b.minZ - r;
      else this.outZ = b.maxZ + r;
    }
    return true;
  }

  /** Is a cylinder free of geometry here? Used to find a safe spot to step out of a car. */
  isFree(x: number, z: number, r: number, feetY: number, headY: number, skip?: unknown): boolean {
    const lo = feetY + 0.25;
    const c = this.query(x - r, z - r, x + r, z + r);
    for (let i = 0; i < c.length; i++) {
      const b = c[i];
      if (b.top <= lo || b.bottom >= headY) continue;
      if (this.circleTouches(x, z, r, b)) return false;
    }
    for (let i = 0; i < this.dyn.length; i++) {
      const b = this.dyn[i];
      if (skip !== undefined && b.owner === skip) continue;
      if (b.top <= lo || b.bottom >= headY) continue;
      if (this.circleTouches(x, z, r, b)) return false;
    }
    return true;
  }

  /**
   * Ray against the static world (and optionally moving bodies).
   * `pad` inflates every box — a cheap sphere-cast, used to keep the camera out of walls.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxT: number, includeDyn = true, pad = 0, skip?: unknown,
  ): RayHit | null {
    const ex = ox + dx * maxT, ez = oz + dz * maxT;
    const c = this.query(Math.min(ox, ex) - pad - 1, Math.min(oz, ez) - pad - 1, Math.max(ox, ex) + pad + 1, Math.max(oz, ez) + pad + 1);
    let bestT = maxT, best: Box | null = null, bnx = 0, bny = 0, bnz = 0;
    const test = (b: Box) => {
      const h = slab(b, ox, oy, oz, dx, dy, dz, bestT, pad);
      if (h) { bestT = h.t; best = b; bnx = h.nx; bny = h.ny; bnz = h.nz; }
    };
    for (let i = 0; i < c.length; i++) test(c[i]);
    if (includeDyn) {
      for (let i = 0; i < this.dyn.length; i++) {
        if (skip !== undefined && this.dyn[i].owner === skip) continue;
        test(this.dyn[i]);
      }
    }
    if (!best) return null;
    return { t: bestT, box: best, nx: bnx, ny: bny, nz: bnz };
  }

  /** 0..1 fraction of a segment that is unobstructed. */
  segmentClear(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, pad = 0): number {
    let dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return 1;
    dx /= len; dy /= len; dz /= len;
    const h = this.raycast(x1, y1, z1, dx, dy, dz, len, false, pad);
    return h ? clamp(h.t / len, 0, 1) : 1;
  }
}

const _n = { t: 0, nx: 0, ny: 0, nz: 0 };

/** Standard slab test, with the entry face normal. Returns null when farther than `bestT`. */
function slab(
  b: Box, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, bestT: number, pad: number,
): typeof _n | null {
  const minX = b.minX - pad, maxX = b.maxX + pad;
  const minZ = b.minZ - pad, maxZ = b.maxZ + pad;
  const minY = b.bottom - pad, maxY = b.top + pad;
  let tmin = 0, tmax = bestT;
  let axis = 0, sign = 0;

  // X
  if (Math.abs(dx) < 1e-9) {
    if (ox < minX || ox > maxX) return null;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv, t2 = (maxX - ox) * inv;
    let s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 0; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Y
  if (Math.abs(dy) < 1e-9) {
    if (oy < minY || oy > maxY) return null;
  } else {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv, t2 = (maxY - oy) * inv;
    let s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 1; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Z
  if (Math.abs(dz) < 1e-9) {
    if (oz < minZ || oz > maxZ) return null;
  } else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv, t2 = (maxZ - oz) * inv;
    let s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 2; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmin <= 0 || tmin >= bestT) return null;
  _n.t = tmin;
  _n.nx = axis === 0 ? sign : 0;
  _n.ny = axis === 1 ? sign : 0;
  _n.nz = axis === 2 ? sign : 0;
  return _n;
}

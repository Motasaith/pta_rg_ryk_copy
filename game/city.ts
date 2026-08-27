import * as THREE from 'three';
import { glowTexture, Mats, signTexture, uvScale } from './materials';
import { KIND, Physics } from './physics';
import { chance, mulberry32, pick, ri, rr, Rng } from './mathx';
import { QualityPreset } from './settings';
import {
  bench, bindProps, Builder, cart, chaiStall, charpai, City, connect, lamp, LANE_OFF,
  LEFT_HAND_TRAFFIC, LOT_Y, MinimapData, newCollect, PAINT_Y, Poi, powerLine, RoadNode,
  ROAD_Y, Shop, tandoor, tree, WALK_Y, WorldBounds,
} from './layout';
import { buildScheme } from './scheme';
import { AoGrid } from './ao';

/* The geometry batcher, street furniture and shared types live in layout.ts. They are
   re-exported here so the rest of the game can keep importing "the map" from one place. */
export type { City, MinimapData, Poi, RoadNode, Shop } from './layout';
export { LANE_OFF, LEFT_HAND_TRAFFIC, LOT_Y, PAINT_Y, ROAD_Y, WALK_Y } from './layout';

/* ----------------------------------------------------------------------------
   City grid constants.

   The invented city derives from these four numbers, which is exactly why nothing
   ends up standing in a road: roads own the band around each grid line, the next
   4m is pavement, and every building and prop is placed inside the remaining core
   rect. The real Rahim Garden scheme to the south (scheme.ts) uses its own
   plan-derived dimensions, but the same discipline.
   ---------------------------------------------------------------------------- */
export const N = 6;                 // road lines per axis -> 5x5 city blocks
export const PITCH = 80;            // distance between road centre lines
export const ROADW = 16;            // road width (two 8m lanes)
export const SIDEWALK = 4;          // pavement ring inside each block
export const BLOCK = PITCH - ROADW; // 64 -> block slab size
export const CORE = BLOCK - SIDEWALK * 2; // 56 -> buildable area
export const HALF_BLOCK = BLOCK / 2;
export const HALF_CORE = CORE / 2;

export function roadCoord(i: number): number {
  return (i - (N - 1) / 2) * PITCH;
}
export function blockCentre(b: number): number {
  return (roadCoord(b) + roadCoord(b + 1)) / 2;
}

/** Extent of the grid city alone; the world is this plus the housing scheme. */
export const CITY_MIN = roadCoord(0) - ROADW / 2 - 26;
export const CITY_MAX = roadCoord(N - 1) + ROADW / 2 + 26;

export type BlockType = 'plaza' | 'tower' | 'shops' | 'houses' | 'park' | 'mosque' | 'market' | 'police' | 'parking';

export function buildCity(scene: THREE.Scene, phys: Physics, mats: Mats, preset: QualityPreset, seed = 20260805): City {
  bindProps(mats);
  const rng = mulberry32(seed);
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  scene.add(root);
  const B = new Builder();

  // One collector shared by both districts, destructured for brevity (the fields are
  // arrays, so pushing through either name hits the same storage).
  const C = newCollect();
  const {
    minimap, pedLoops, parkSpots, roadSpawns, shops, pois, itemSpots, pickupSpots,
    lampPts, signs: signMeshes, nodes,
  } = C;

  /* ground -------------------------------------------------------------- */
  const groundGeo = new THREE.PlaneGeometry(2000, 2000);
  uvScale(groundGeo, 2000 / 6, 2000 / 6);
  const ground = new THREE.Mesh(groundGeo, mats.grass);
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = 160;   // centred on the city + scheme, not just the city
  ground.receiveShadow = true;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();
  root.add(ground);

  /* roads --------------------------------------------------------------- */
  const HR = ROADW / 2;
  for (let i = 0; i < N; i++) {
    const x = roadCoord(i);
    for (let j = 0; j < N - 1; j++) {
      const z1 = roadCoord(j) + HR, z2 = roadCoord(j + 1) - HR;
      B.quad(mats.asphalt, x, ROAD_Y, (z1 + z2) / 2, ROADW, z2 - z1, 8);
      // dashed centre line
      for (let z = z1 + 3; z < z2 - 3; z += 7) B.quad(mats.paint, x, PAINT_Y, z, 0.22, 3, 0);
      // lane edges
      B.quad(mats.paint, x - HR + 0.55, PAINT_Y, (z1 + z2) / 2, 0.16, z2 - z1, 0);
      B.quad(mats.paint, x + HR - 0.55, PAINT_Y, (z1 + z2) / 2, 0.16, z2 - z1, 0);
    }
    minimap.roads.push({ x1: x, z1: roadCoord(0), x2: x, z2: roadCoord(N - 1), w: ROADW });
  }
  for (let j = 0; j < N; j++) {
    const z = roadCoord(j);
    for (let i = 0; i < N - 1; i++) {
      const x1 = roadCoord(i) + HR, x2 = roadCoord(i + 1) - HR;
      B.quad(mats.asphalt, (x1 + x2) / 2, ROAD_Y, z, x2 - x1, ROADW, 8);
      for (let x = x1 + 3; x < x2 - 3; x += 7) B.quad(mats.paint, x, PAINT_Y, z, 3, 0.22, 0);
      B.quad(mats.paint, (x1 + x2) / 2, PAINT_Y, z - HR + 0.55, x2 - x1, 0.16, 0);
      B.quad(mats.paint, (x1 + x2) / 2, PAINT_Y, z + HR - 0.55, x2 - x1, 0.16, 0);
    }
    minimap.roads.push({ x1: roadCoord(0), z1: z, x2: roadCoord(N - 1), z2: z, w: ROADW });
  }

  /* intersections + crosswalks ------------------------------------------ */
  const nodeGrid: (RoadNode | undefined)[] = new Array(N * N).fill(undefined);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = roadCoord(i), z = roadCoord(j);
      B.quad(mats.asphalt, x, ROAD_Y, z, ROADW, ROADW, 8);
      // zebra crossings on each approach that has a road
      const approaches: [number, number][] = [];
      if (j > 0) approaches.push([0, -1]);
      if (j < N - 1) approaches.push([0, 1]);
      if (i > 0) approaches.push([-1, 0]);
      if (i < N - 1) approaches.push([1, 0]);
      for (const [ax, az] of approaches) {
        const cx = x + ax * (HR - 1.6), cz = z + az * (HR - 1.6);
        for (let k = -3; k <= 3; k++) {
          if (ax !== 0) B.quad(mats.paint, cx, PAINT_Y, cz + k * 2, 2.6, 0.85, 0);
          else B.quad(mats.paint, cx + k * 2, PAINT_Y, cz, 0.85, 2.6, 0);
        }
        // Stop line just before the crossing, on the lane the incoming traffic uses.
        // Traffic arriving from the +ax side travels in −ax, and left-hand traffic keeps
        // to the left of that direction.
        const sx = x + ax * (HR - 3.6), sz = z + az * (HR - 3.6);
        const side = LEFT_HAND_TRAFFIC ? 1 : -1;
        if (ax !== 0) B.quad(mats.paint, sx, PAINT_Y, sz + side * ax * LANE_OFF, 0.3, 7, 0);
        else B.quad(mats.paint, sx - side * az * LANE_OFF, PAINT_Y, sz, 7, 0.3, 0);
      }
      const n: RoadNode = { x, z, nb: [], nbWidth: [] };
      nodes.push(n);
      nodeGrid[i * N + j] = n;
      // traffic light poles on the two safe corners (inside the block slab, never on tarmac)
      if (preset.detail && (i + j) % 2 === 0) {
        for (const [sx2, sz2] of [[1, 1], [-1, -1]] as [number, number][]) {
          const px = x + sx2 * (HR + 1.4), pz = z + sz2 * (HR + 1.4);
          if (Math.abs(px) > CITY_MAX - 4 || Math.abs(pz) > CITY_MAX - 4) continue;
          B.cyl(mats.metal, px, WALK_Y + 2.6, pz, 0.11, 0.13, 5.2, 6);
          B.box(mats.metal, px, WALK_Y + 5.1, pz, 0.24, 0.24, 2.4, 0, 2);
          B.box(mats.metal, px, WALK_Y + 4.5, pz + sz2 * -1.1, 0.34, 0.9, 0.3, 0, 2);
          phys.addCentered(px, pz, 0.28, 0.28, 0, 5.2, KIND.Prop);
        }
      }
    }
  }
  const node = (i: number, j: number) => (i < 0 || j < 0 || i >= N || j >= N ? undefined : nodeGrid[i * N + j]);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = node(i, j)!;
      const right = node(i + 1, j);
      const down = node(i, j + 1);
      if (right) connect(a, right, ROADW);
      if (down) connect(a, down, ROADW);
    }
  }

  /* block layout -------------------------------------------------------- */
  const layout: BlockType[][] = [];
  for (let bi = 0; bi < N - 1; bi++) {
    layout[bi] = [];
    for (let bj = 0; bj < N - 1; bj++) {
      const ring = Math.max(Math.abs(bi - 2), Math.abs(bj - 2));
      let t: BlockType;
      if (ring === 0) t = 'plaza';
      else if (ring === 1) t = pick(rng, ['tower', 'tower', 'shops'] as BlockType[]);
      else t = pick(rng, ['houses', 'houses', 'houses', 'park', 'shops', 'parking'] as BlockType[]);
      layout[bi][bj] = t;
    }
  }
  // Landmarks get fixed slots so the map always reads the same way.
  layout[1][1] = 'mosque';
  layout[1][3] = 'market';
  layout[3][1] = 'police';
  layout[3][3] = 'tower';
  layout[0][2] = 'park';
  layout[4][2] = 'houses';
  layout[2][0] = 'shops';
  layout[2][4] = 'park';
  layout[3][4] = 'houses';   // the player's own street — must exist

  let policeStation = { x: 0, z: 0 };
  let hospital = { x: 0, z: 0 };
  let playerStart = { x: 0, z: 0, yaw: 0 };

  for (let bi = 0; bi < N - 1; bi++) {
    for (let bj = 0; bj < N - 1; bj++) {
      const cx = blockCentre(bi), cz = blockCentre(bj);
      const type = layout[bi][bj];

      // pavement slab + kerb (a 16cm step the player walks up, cars can mount)
      B.box(mats.concrete, cx, WALK_Y / 2, cz, BLOCK, WALK_Y, BLOCK, 0, 3);
      phys.addCentered(cx, cz, HALF_BLOCK, HALF_BLOCK, 0, WALK_Y, KIND.Ground);
      minimap.blocks.push({ x: cx, z: cz, s: BLOCK });

      // pedestrian loop around the block, on the pavement mid-line
      const loopR = HALF_BLOCK - SIDEWALK / 2;
      pedLoops.push([
        { x: cx - loopR, z: cz - loopR }, { x: cx + loopR, z: cz - loopR },
        { x: cx + loopR, z: cz + loopR }, { x: cx - loopR, z: cz + loopR },
      ]);

      streetFurniture(B, phys, mats, rng, cx, cz, preset, lampPts, pickupSpots);
      // overhead cables down the north pavement of every block
      const cableZ = cz - HALF_BLOCK + SIDEWALK * 0.42;
      powerLine(B, phys, cx - HALF_BLOCK + 11, cableZ, cx + HALF_BLOCK - 11, cableZ, 26);

      switch (type) {
        case 'plaza': plaza(B, phys, mats, rng, cx, cz, itemSpots, pois, minimap); break;
        case 'tower': towers(B, phys, mats, rng, cx, cz, minimap, preset); break;
        case 'shops': shopRow(B, phys, mats, rng, cx, cz, shops, minimap, signMeshes, pois); break;
        case 'houses': {
          const home = houses(B, phys, mats, rng, cx, cz, minimap, preset, parkSpots, itemSpots);
          if (playerStart.x === 0 && playerStart.z === 0 && bi === 3 && bj === 4) {
            playerStart = home;
            pois.push({ name: 'HOME', x: home.x, z: home.z, kind: 'home' });
          }
          break;
        }
        case 'park': park(B, phys, mats, rng, cx, cz, minimap, pois, itemSpots, preset); break;
        case 'mosque': mosque(B, phys, mats, cx, cz, minimap, pois, signMeshes, itemSpots); break;
        case 'market': {
          market(B, phys, mats, cx, cz, minimap, pois, shops, signMeshes, parkSpots);
          hospital = { x: cx, z: cz - 6 };
          break;
        }
        case 'police': policeStation = policeBlock(B, phys, mats, cx, cz, minimap, pois, signMeshes, parkSpots); break;
        case 'parking': parking(B, phys, mats, rng, cx, cz, minimap, parkSpots, pickupSpots); break;
      }
    }
  }

  if (playerStart.x === 0 && playerStart.z === 0) {
    // never fall back to a block centre — that is inside a building. Use the pavement.
    playerStart = { x: blockCentre(4), z: blockCentre(4) - (HALF_BLOCK - SIDEWALK / 2), yaw: Math.PI };
  }

  /* on-street parking spots + world edge ------------------------------- */
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N - 1; j++) {
      const x = roadCoord(i), z = (roadCoord(j) + roadCoord(j + 1)) / 2;
      roadSpawns.push({ x: x + (LEFT_HAND_TRAFFIC ? -LANE_OFF : LANE_OFF), z, yaw: 0 });
      roadSpawns.push({ x: x + (LEFT_HAND_TRAFFIC ? LANE_OFF : -LANE_OFF), z: z + 12, yaw: Math.PI });
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N - 1; i++) {
      const z = roadCoord(j), x = (roadCoord(i) + roadCoord(i + 1)) / 2;
      roadSpawns.push({ x, z: z + (LEFT_HAND_TRAFFIC ? LANE_OFF : -LANE_OFF), yaw: Math.PI / 2 });
      roadSpawns.push({ x: x + 12, z: z + (LEFT_HAND_TRAFFIC ? -LANE_OFF : LANE_OFF), yaw: -Math.PI / 2 });
    }
  }

  /* ── RAHIM GARDEN HOUSING SCHEME ─────────────────────────────────────── */
  // The real society, built from its own layout plan, hanging off the south arterial.
  const scheme = buildScheme(B, phys, mats, preset, rng, C);
  // Wire its four entrances into the city grid so traffic flows straight in. The edge
  // carries the *scheme* street's width, so cars entering a 30ft street pick a lane
  // offset that fits it instead of the city's 16m one.
  for (const e of scheme.entrances) {
    const gi = Math.round(e.x / PITCH + (N - 1) / 2);
    const top = node(gi, N - 1);
    if (top) connect(top, e.node, e.w);
  }
  // The player lives on plot 34, off the boulevard.
  playerStart = scheme.home;
  pois.push({ name: 'HOME', x: scheme.home.x, z: scheme.home.z, kind: 'home' });

  /* ── world edge ──────────────────────────────────────────────────────── */
  const bounds: WorldBounds = {
    minX: CITY_MIN, maxX: CITY_MAX,
    minZ: CITY_MIN, maxZ: scheme.south + 18,
  };
  // invisible walls so you cannot walk off the world
  const T = 24;
  phys.addBox(bounds.minX - T, bounds.minZ - T, bounds.maxX + T, bounds.minZ, 0, 40, KIND.Building);
  phys.addBox(bounds.minX - T, bounds.maxZ, bounds.maxX + T, bounds.maxZ + T, 0, 40, KIND.Building);
  phys.addBox(bounds.minX - T, bounds.minZ, bounds.minX, bounds.maxZ, 0, 40, KIND.Building);
  phys.addBox(bounds.maxX, bounds.minZ, bounds.maxX + T, bounds.maxZ, 0, 40, KIND.Building);
  // countryside hedge line so the edge reads as intentional
  for (let x = bounds.minX; x <= bounds.maxX; x += 8) {
    B.box(mats.foliage, x, WALK_Y + 0.9, bounds.minZ - 1, 8, 1.8, 1.6, 0, 3);
    B.box(mats.foliage, x, WALK_Y + 0.9, bounds.maxZ + 1, 8, 1.8, 1.6, 0, 3);
  }
  for (let z = bounds.minZ; z <= bounds.maxZ; z += 8) {
    B.box(mats.foliage, bounds.minX - 1, WALK_Y + 0.9, z, 1.6, 1.8, 8, 0, 3);
    B.box(mats.foliage, bounds.maxX + 1, WALK_Y + 0.9, z, 1.6, 1.8, 8, 0, 3);
  }

  /* ── bake ambient occlusion ──────────────────────────────────────────── */
  // Voxelise what we just built, then bake per-vertex occlusion into the merged meshes.
  // Zero runtime cost: it is only vertex colours.
  const ao = new AoGrid(bounds);
  for (const b of phys.boxes) ao.addBox(b);
  B.finish(root, ao);
  for (const s of signMeshes) root.add(s);
  phys.build();

  /* lamp glow sprites (one draw call for every street light at night) --- */
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(lampPts, 3));
  const lampGlow = new THREE.Points(
    glowGeo,
    new THREE.PointsMaterial({
      map: glowTexture(), color: 0xffd9a0, size: 3.4, sizeAttenuation: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
    }),
  );
  lampGlow.frustumCulled = false;
  root.add(lampGlow);

  minimap.labels.push(
    ...pois.filter((p) => p.kind !== 'shop').map((p) => ({ t: p.name, x: p.x, z: p.z })),
  );

  return {
    root, nodes, pedLoops, parkSpots, roadSpawns, shops, pois, minimap,
    itemSpots, pickupSpots, playerStart, policeStation, hospital, lampGlow, bounds,
    triangles: B.triangles,
    setNight(n: number) {
      (lampGlow.material as THREE.PointsMaterial).opacity = n * 0.85;
      for (const f of mats.facade) f.emissiveIntensity = n * 0.9;
    },
  };
}

/* ── pavement furniture ───────────────────────────────────────────────────── */

function streetFurniture(
  B: Builder, phys: Physics, mats: Mats, rng: Rng, cx: number, cz: number,
  preset: QualityPreset, lampPts: number[], pickupSpots: { x: number; z: number }[],
): void {
  const mid = HALF_BLOCK - SIDEWALK / 2;   // pavement centre line
  const step = 16 * preset.propStep;
  const corner = 10;                       // keep corners clear for crossings
  for (const side of [0, 1, 2, 3]) {
    for (let t = -mid + corner; t <= mid - corner; t += step) {
      const along = t;
      let x = 0, z = 0, inward = 0;
      if (side === 0) { x = cx + along; z = cz - mid; inward = 1; }
      if (side === 1) { x = cx + mid; z = cz + along; inward = 1; }
      if (side === 2) { x = cx + along; z = cz + mid; inward = -1; }
      if (side === 3) { x = cx - mid; z = cz + along; inward = -1; }
      const isTree = ((Math.round(along) / step) | 0) % 2 === 0;
      if (isTree) tree(B, phys, rng, x, z, 0.9 + rng() * 0.5);
      else lamp(B, phys, x, z, side % 2 === 0 ? (side === 0 ? 1 : -1) : 0, side % 2 === 1 ? (side === 1 ? -1 : 1) : 0, lampPts);
      if (chance(rng, 0.1)) pickupSpots.push({ x: x + inward * 1.2, z });
    }
  }
  // one bin + bench per block, on the pavement, tucked inside the kerb
  const bx = cx + rr(rng, -mid + 12, mid - 12), bz = cz - mid + 0.6;
  bench(B, phys, bx, bz, 0);
  B.cyl(mats.metal, cx + mid - 0.8, WALK_Y + 0.42, cz - mid + 4, 0.32, 0.28, 0.84, 8);
}




/* ── block builders ───────────────────────────────────────────────────────── */

function plaza(
  B: Builder, phys: Physics, mats: Mats, rng: Rng, cx: number, cz: number,
  itemSpots: { x: number; y: number; z: number }[], pois: Poi[], minimap: MinimapData,
): void {
  B.quad(mats.concrete, cx, LOT_Y, cz, CORE, CORE, 4);
  minimap.parks.push({ x: cx, z: cz, w: CORE, d: CORE });
  // fountain
  B.cyl(mats.concrete, cx, LOT_Y + 0.35, cz, 5.4, 5.8, 0.7, 20);
  B.cyl(mats.water, cx, LOT_Y + 0.68, cz, 5, 5, 0.12, 20);
  B.cyl(mats.concrete, cx, LOT_Y + 1.5, cz, 0.5, 0.9, 2.2, 12);
  B.cyl(mats.concrete, cx, LOT_Y + 2.7, cz, 1.9, 1.4, 0.22, 14);
  B.sphere(mats.water, cx, LOT_Y + 3.1, cz, 0.7, 10, 7);
  phys.addCentered(cx, cz, 5.9, 5.9, 0, LOT_Y + 0.7, KIND.Prop);
  for (let a = 0; a < 8; a++) {
    const an = (a / 8) * Math.PI * 2;
    bench(B, phys, cx + Math.cos(an) * 12, cz + Math.sin(an) * 12, -an + Math.PI / 2);
    tree(B, phys, rng, cx + Math.cos(an + 0.4) * 20, cz + Math.sin(an + 0.4) * 20, 1.2);
  }
  // clock tower — the visual landmark at the centre of the map
  B.box(mats.concrete, cx - 18, LOT_Y + 0.6, cz - 18, 6, 1.2, 6, 0, 3);
  B.box(mats.plaster[2], cx - 18, LOT_Y + 8, cz - 18, 4, 16, 4, 0, 4);
  B.box(mats.plaster[0], cx - 18, LOT_Y + 16.6, cz - 18, 5.2, 1.2, 5.2, 0, 3);
  for (const [dx, dz] of [[0, 2.7], [0, -2.7], [2.7, 0], [-2.7, 0]] as [number, number][]) {
    const faceZ = dz !== 0;
    B.box(mats.paint, cx - 18 + dx, LOT_Y + 14.4, cz - 18 + dz, faceZ ? 2.3 : 0.14, 2.3, faceZ ? 0.14 : 2.3, 0, 0);
  }
  B.cone(mats.roof, cx - 18, LOT_Y + 19, cz - 18, 3.8, 3.6, 8);
  phys.addCentered(cx - 18, cz - 18, 3, 3, 0, LOT_Y + 17, KIND.Building);
  minimap.buildings.push({ x: cx - 18, z: cz - 18, w: 6, d: 6 });
  pois.push({ name: 'CITY PLAZA', x: cx, z: cz, kind: 'plaza' });
  itemSpots.push({ x: cx + 8, y: LOT_Y + 0.2, z: cz + 14 });
}

function towers(
  B: Builder, phys: Physics, mats: Mats, rng: Rng, cx: number, cz: number,
  minimap: MinimapData, preset: QualityPreset,
): void {
  B.quad(mats.concrete, cx, LOT_Y, cz, CORE, CORE, 4);
  const cells = 2;
  const size = CORE / cells;
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const x = cx - CORE / 2 + size * (i + 0.5), z = cz - CORE / 2 + size * (j + 0.5);
      const w = size - rr(rng, 6, 10), d = size - rr(rng, 6, 10);
      const floors = ri(rng, 4, 13);
      const h = floors * 3.5;
      const fac = mats.facade[ri(rng, 0, mats.facade.length - 1)];
      B.box(fac, x, LOT_Y + h / 2, z, w, h, d, 0, 14);
      // parapet + plinth
      B.box(mats.concrete, x, LOT_Y + h + 0.5, z, w + 0.7, 1, d + 0.7, 0, 3);
      B.box(mats.concrete, x, LOT_Y + 0.15, z, w + 1.2, 0.3, d + 1.2, 0, 3);
      // ground-floor glazing
      B.box(mats.glass, x, LOT_Y + 1.7, z + d / 2 + 0.06, w * 0.7, 3, 0.1, 0, 0);
      if (h > 24) {
        const w2 = w * 0.6, d2 = d * 0.6, h2 = rr(rng, 6, 14);
        B.box(fac, x, LOT_Y + h + 1 + h2 / 2, z, w2, h2, d2, 0, 14);
        B.box(mats.concrete, x, LOT_Y + h + 1 + h2 + 0.4, z, w2 + 0.6, 0.8, d2 + 0.6, 0, 3);
        if (preset.detail) B.cyl(mats.metal, x, LOT_Y + h + h2 + 5, z, 0.06, 0.1, 8, 5);
      }
      if (preset.detail) {
        B.box(mats.metal, x + w / 4, LOT_Y + h + 1.4, z, 2.2, 1.4, 2.2, 0, 2);
        B.cyl(mats.metal, x - w / 4, LOT_Y + h + 1.9, z + d / 4, 1.1, 1.1, 2.4, 10);
      }
      phys.addCentered(x, z, w / 2, d / 2, 0, LOT_Y + h, KIND.Building);
      minimap.buildings.push({ x, z, w, d });
    }
  }
}

function shopRow(
  B: Builder, phys: Physics, mats: Mats, rng: Rng, cx: number, cz: number,
  shops: Shop[], minimap: MinimapData, signMeshes: THREE.Mesh[], pois: Poi[],
): void {
  B.quad(mats.concrete, cx, LOT_Y, cz, CORE, CORE, 4);
  const NAMES: [string, Shop['kind'], string][] = [
    ['ZAM ZAM KIRYANA STORE', 'health', '#2e8b57'],
    ['AL-HABIB TANDOOR & NAAN', 'health', '#b3564e'],
    ['QUETTA CHAI HOTEL', 'health', '#8a5a33'],
    ['AL-NOOR HARDWARE', 'ammo', '#2b5aa0'],
    ['MADINA SWEETS & BAKERY', 'health', '#c96a86'],
    ['SHAHEEN MOBILE & EASYLOAD', 'ammo', '#4a5a6a'],
    ['BISMILLAH BIRYANI', 'health', '#a8451f'],
    ['NEW PUNCTURE SHOP', 'ammo', '#3f4a52'],
    ['GUJRANWALA CLOTH HOUSE', 'health', '#7a3b8a'],
    ['CHAMAN FRUIT & SABZI', 'health', '#1f7a4a'],
  ];
  // four shop units, each facing outward on its own side of the block
  const sides: [number, number, number][] = [
    [0, -1, 0], [1, 0, -Math.PI / 2], [0, 1, Math.PI], [-1, 0, Math.PI / 2],
  ];
  for (let s = 0; s < 4; s++) {
    const [ax, az, yaw] = sides[s];
    const depth = 15, width = 34;
    const x = cx + ax * (HALF_CORE - depth / 2), z = cz + az * (HALF_CORE - depth / 2);
    const w = ax ? depth : width, d = ax ? width : depth;
    const h = rr(rng, 7, 9.5);
    const wall = mats.plaster[ri(rng, 0, 5)];
    B.box(wall, x, LOT_Y + h / 2, z, w, h, d, 0, 5);
    B.box(mats.concrete, x, LOT_Y + h + 0.35, z, w + 0.8, 0.7, d + 0.8, 0, 3);
    // shopfront: glass, door, awning, sign
    const fx = x + ax * (ax ? depth / 2 : 0), fz = z + az * (az ? depth / 2 : 0);
    const front = ax !== 0;
    B.box(mats.glass, fx + ax * 0.1, LOT_Y + 1.9, fz + az * 0.1, front ? 0.12 : width * 0.6, 2.6, front ? width * 0.6 : 0.12, 0, 0);
    B.box(mats.wood, fx + ax * 0.12, LOT_Y + 1.15, fz + az * 0.12, front ? 0.16 : 1.3, 2.3, front ? 1.3 : 0.16, 0, 2);
    B.box(mats.metal, fx + ax * 1.3, LOT_Y + 3.5, fz + az * 1.3, front ? 2.8 : width * 0.72, 0.12, front ? width * 0.72 : 2.8, 0, 3);
    // block centres are negative on half the map, so keep the index positive
    const pickIdx = (s + Math.abs(Math.round((cx + cz) / PITCH))) % NAMES.length;
    const [name, kind, colour] = NAMES[pickIdx];
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(front ? 0.1 : width * 0.62, 1.5),
      new THREE.MeshBasicMaterial({ map: signTexture(name, colour, '#ffffff', 512, 96), side: THREE.DoubleSide }),
    );
    if (front) {
      sign.geometry = new THREE.PlaneGeometry(width * 0.62, 1.5);
      sign.rotation.y = ax > 0 ? Math.PI / 2 : -Math.PI / 2;
    } else if (az > 0) sign.rotation.y = 0;
    else sign.rotation.y = Math.PI;
    sign.position.set(fx + ax * 0.35, LOT_Y + 4.6, fz + az * 0.35);
    signMeshes.push(sign);
    // counter you walk up to
    const px = fx + ax * 2.4, pz = fz + az * 2.4;
    shops.push({ x: px, z: pz, yaw, name, kind });
    pois.push({ name, x: px, z: pz, kind: 'shop' });
    phys.addCentered(x, z, w / 2, d / 2, 0, LOT_Y + h, KIND.Building);
    minimap.buildings.push({ x, z, w, d });
  }
  // vendor carts, parked on the pavement-side lot edge — not in the road
  for (let i = 0; i < 2; i++) {
    const vx = cx + rr(rng, -12, 12), vz = cz + (i ? 1 : -1) * (HALF_CORE - 17);
    cart(B, phys, vx, vz, i ? Math.PI : 0);
  }
  // the bazaar's real fixtures: a tandoor, a chai stall and a charpai to wait on
  tandoor(B, phys, cx - HALF_CORE + 8, cz - 2);
  chaiStall(B, phys, cx + HALF_CORE - 9, cz + 3, Math.PI / 2);
  charpai(B, phys, cx + HALF_CORE - 9, cz - 4, 1);
}


function houses(
  B: Builder, phys: Physics, mats: Mats, rng: Rng, cx: number, cz: number,
  minimap: MinimapData, preset: QualityPreset,
  parkSpots: { x: number; z: number; yaw: number }[],
  itemSpots: { x: number; y: number; z: number }[],
): { x: number; z: number; yaw: number } {
  const cells = 3;
  const size = CORE / cells;             // ≈18.7 per plot
  let home = { x: cx, z: cz, yaw: 0 };
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const lx = cx - CORE / 2 + size * (i + 0.5);
      const lz = cz - CORE / 2 + size * (j + 0.5);
      // Which block edge does this plot face? Corner plots take the Z street; the
      // middle plot gets a south gate so no plot is ever landlocked.
      const oX = i === 0 ? -1 : i === cells - 1 ? 1 : 0;
      const oZ = j === 0 ? -1 : j === cells - 1 ? 1 : 0;
      const fx = oZ !== 0 ? 0 : oX;
      const fz = oZ !== 0 ? oZ : oX !== 0 ? 0 : -1;
      const yaw = Math.atan2(fx, fz);      // faces out towards the pavement
      const half = size / 2 - 0.7;
      const alongX = fz !== 0;             // the street-facing wall runs along X

      B.quad(chance(rng, 0.5) ? mats.grass : mats.dirt, lx, LOT_Y + 0.005, lz, half * 2, half * 2, 4);

      // boundary wall — solid all round except a gate gap on the street side
      const wallH = 1.9, gate = 3.8, len = half * 2;
      for (const [sx, sz] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as [number, number][]) {
        const horiz = sz !== 0;
        const wx = lx + sx * half, wz = lz + sz * half;
        const seg = (x: number, z: number, l: number) => {
          B.box(mats.plaster[3], x, LOT_Y + wallH / 2, z, horiz ? l : 0.3, wallH, horiz ? 0.3 : l, 0, 3);
          phys.addCentered(x, z, horiz ? l / 2 : 0.15, horiz ? 0.15 : l / 2, 0, LOT_Y + wallH, KIND.Fence);
        };
        if (sx === fx && sz === fz) {
          const sl = (len - gate) / 2;
          const base = horiz ? lx : lz;
          for (const o of [-(gate + sl) / 2, (gate + sl) / 2]) {
            seg(horiz ? base + o : wx, horiz ? wz : base + o, sl);
          }
          for (const o of [-gate / 2, gate / 2]) {
            B.box(mats.concrete, horiz ? lx + o : wx, LOT_Y + 1.2, horiz ? wz : lz + o, 0.42, 2.4, 0.42, 0, 2);
          }
        } else seg(wx, wz, len);
      }

      // house, set back from the gate so the driveway fits in front of it
      const hw = half * 1.25, hd = half * 1.05;
      const storeys = chance(rng, 0.45) ? 2 : 1;
      const h = storeys * 3.3;
      const setback = Math.max(half - (alongX ? hd : hw) / 2 - 2.8, 0);
      const bx = lx - fx * setback, bz = lz - fz * setback;
      B.box(mats.plaster[ri(rng, 0, 5)], bx, LOT_Y + h / 2, bz, hw, h, hd, 0, 5);
      B.gable(mats.roof, bx, LOT_Y + h, bz, alongX ? hw + 0.6 : hd + 0.6, alongX ? hd + 0.9 : hw + 0.9, 1.4, !alongX);
      phys.addCentered(bx, bz, hw / 2, hd / 2, 0, LOT_Y + h, KIND.Building);
      minimap.buildings.push({ x: bx, z: bz, w: hw, d: hd });

      // door + windows, always on the street-facing wall
      const doorX = bx + fx * (hw / 2 + 0.07), doorZ = bz + fz * (hd / 2 + 0.07);
      B.box(mats.wood, doorX, LOT_Y + 1.1, doorZ, alongX ? 1.05 : 0.14, 2.2, alongX ? 0.14 : 1.05, 0, 2);
      for (const o of [-2.6, 2.6]) {
        B.box(mats.glass, doorX + (alongX ? o : 0), LOT_Y + 1.78, doorZ + (alongX ? 0 : o), alongX ? 1.5 : 0.1, 1.35, alongX ? 0.1 : 1.5, 0, 0);
      }
      if (storeys === 2) {
        for (const o of [-2.3, 0, 2.3]) {
          B.box(mats.glass, doorX + (alongX ? o : 0), LOT_Y + 4.75, doorZ + (alongX ? 0 : o), alongX ? 1.3 : 0.1, 1.25, alongX ? 0.1 : 1.3, 0, 0);
        }
        if (preset.detail) {
          B.box(mats.concrete, doorX + fx * 0.6, LOT_Y + 3.45, doorZ + fz * 0.6, alongX ? 4.8 : 1.4, 0.22, alongX ? 1.4 : 4.8, 0, 3);
        }
      }
      // water tank on the roof — every rooftop here has one
      B.cyl(mats.metal, bx + hw / 4, LOT_Y + h + 2.35, bz, 0.6, 0.6, 1.2, 10);

      // driveway from gate to house, inside the plot
      const dvx = lx + fx * (half - 2.6), dvz = lz + fz * (half - 2.6);
      B.quad(mats.concrete, dvx, LOT_Y + 0.012, dvz, alongX ? 5.2 : 4.6, alongX ? 4.6 : 5.2, 3);
      if (chance(rng, 0.45)) parkSpots.push({ x: dvx, z: dvz, yaw });
      if (chance(rng, 0.4)) {
        tree(B, phys, rng, lx + (alongX ? half - 2.2 : fx * (half - 2.6)), lz + (alongX ? fz * (half - 2.6) : half - 2.2), 0.85);
      }
      if (chance(rng, 0.2)) itemSpots.push({ x: lx + (alongX ? 4 : 0), y: LOT_Y + 0.25, z: lz + (alongX ? 0 : 4) });

      if (i === 1 && j === 0) home = { x: doorX + fx * 3.4, z: doorZ + fz * 3.4, yaw };
    }
  }
  return home;
}

function park(
  B: Builder, phys: Physics, mats: Mats, rng: Rng, cx: number, cz: number,
  minimap: MinimapData, pois: Poi[], itemSpots: { x: number; y: number; z: number }[], preset: QualityPreset,
): void {
  B.quad(mats.grass, cx, LOT_Y, cz, CORE, CORE, 5);
  minimap.parks.push({ x: cx, z: cz, w: CORE, d: CORE });
  // crossing paths
  B.quad(mats.concrete, cx, LOT_Y + 0.01, cz, CORE, 3, 3);
  B.quad(mats.concrete, cx, LOT_Y + 0.01, cz, 3, CORE, 3);
  const step = 9 * preset.propStep;
  for (let x = -HALF_CORE + 5; x <= HALF_CORE - 5; x += step) {
    for (let z = -HALF_CORE + 5; z <= HALF_CORE - 5; z += step) {
      if (Math.abs(x) < 4 || Math.abs(z) < 4) continue;
      if (chance(rng, 0.55)) tree(B, phys, rng, cx + x + rr(rng, -1.5, 1.5), cz + z + rr(rng, -1.5, 1.5), rr(rng, 1, 1.7));
    }
  }
  for (const [ox, oz, ry] of [[-8, -8, 0], [8, 8, Math.PI], [-8, 8, Math.PI / 2], [8, -8, -Math.PI / 2]] as [number, number, number][]) {
    bench(B, phys, cx + ox, cz + oz, ry);
  }
  // pond
  B.cyl(mats.dirt, cx + 14, LOT_Y + 0.02, cz - 14, 7.4, 7.8, 0.16, 18);
  B.cyl(mats.water, cx + 14, LOT_Y + 0.12, cz - 14, 7, 7, 0.12, 18);
  minimap.water.push({ x: cx + 14, z: cz - 14, w: 14, d: 14 });
  // cricket pitch strip — the local sport
  B.quad(mats.dirt, cx - 12, LOT_Y + 0.012, cz + 12, 4, 20, 4);
  for (const off of [-9, 9]) {
    for (let s = -1; s <= 1; s++) B.cyl(mats.wood, cx - 12 + s * 0.35, LOT_Y + 0.45, cz + 12 + off, 0.035, 0.035, 0.9, 5);
  }
  pois.push({ name: 'PARK', x: cx, z: cz, kind: 'park' });
  itemSpots.push({ x: cx - 6, y: LOT_Y + 0.2, z: cz - 4 });
}

function mosque(
  B: Builder, phys: Physics, mats: Mats, cx: number, cz: number,
  minimap: MinimapData, pois: Poi[], signMeshes: THREE.Mesh[], itemSpots: { x: number; y: number; z: number }[],
): void {
  B.quad(mats.concrete, cx, LOT_Y, cz, CORE, CORE, 4);
  // courtyard wall with an arched gate gap on the south side
  const half = HALF_CORE - 1;
  for (let s = 0; s < 4; s++) {
    const sx = s === 1 ? 1 : s === 3 ? -1 : 0;
    const sz = s === 0 ? -1 : s === 2 ? 1 : 0;
    if (sz === -1) {
      for (const off of [-15, 15]) {
        B.box(mats.plaster[2], cx + off, LOT_Y + 1.3, cz - half, 26, 2.6, 0.5, 0, 3);
        phys.addCentered(cx + off, cz - half, 13, 0.25, 0, LOT_Y + 2.6, KIND.Fence);
      }
      B.box(mats.plaster[2], cx, LOT_Y + 3.4, cz - half, 4.6, 1.4, 0.6, 0, 3);
      continue;
    }
    B.box(mats.plaster[2], cx + sx * half, LOT_Y + 1.3, cz + sz * half, sx ? 0.5 : half * 2, 2.6, sz ? 0.5 : half * 2, 0, 3);
    phys.addCentered(cx + sx * half, cz + sz * half, sx ? 0.25 : half, sz ? 0.25 : half, 0, LOT_Y + 2.6, KIND.Fence);
  }
  // prayer hall
  const hw = 24, hd = 18, hh = 8;
  B.box(mats.plaster[5], cx, LOT_Y + hh / 2, cz + 6, hw, hh, hd, 0, 5);
  B.box(mats.concrete, cx, LOT_Y + hh + 0.4, cz + 6, hw + 1, 0.8, hd + 1, 0, 3);
  phys.addCentered(cx, cz + 6, hw / 2, hd / 2, 0, LOT_Y + hh, KIND.Building);
  minimap.buildings.push({ x: cx, z: cz + 6, w: hw, d: hd });
  // dome
  B.cyl(mats.plaster[5], cx, LOT_Y + hh + 1.4, cz + 6, 6.4, 7, 1.6, 16);
  B.sphere(mats.paint, cx, LOT_Y + hh + 4.6, cz + 6, 6.2, 18, 12, 1.15);
  B.cyl(mats.metal, cx, LOT_Y + hh + 11.4, cz + 6, 0.08, 0.08, 1.6, 6);
  B.sphere(mats.metal, cx, LOT_Y + hh + 12.4, cz + 6, 0.4, 8, 6);
  // minarets
  for (const ox of [-13.5, 13.5]) {
    B.cyl(mats.plaster[5], cx + ox, LOT_Y + 9, cz - 4, 1.1, 1.4, 18, 12);
    B.cyl(mats.plaster[2], cx + ox, LOT_Y + 18.4, cz - 4, 1.7, 1.7, 0.8, 12);
    B.sphere(mats.paint, cx + ox, LOT_Y + 19.8, cz - 4, 1.5, 12, 8, 1.2);
    B.cyl(mats.metal, cx + ox, LOT_Y + 21.6, cz - 4, 0.06, 0.06, 1.4, 6);
    phys.addCentered(cx + ox, cz - 4, 1.4, 1.4, 0, LOT_Y + 18, KIND.Building);
  }
  // arched entrance + sign
  B.box(mats.plaster[2], cx, LOT_Y + 3, cz + 6 - hd / 2 - 0.3, 8, 6, 0.6, 0, 4);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 1.5),
    new THREE.MeshBasicMaterial({ map: signTexture('JAMIA MASJID RAHIM GARDEN', '#1f6b45', '#ffffff', 512, 84), side: THREE.DoubleSide }),
  );
  sign.position.set(cx, LOT_Y + 6.8, cz - half + 0.4);
  sign.rotation.y = Math.PI;
  signMeshes.push(sign);
  pois.push({ name: 'MASJID', x: cx, z: cz - half - 4, kind: 'mosque' });
  itemSpots.push({ x: cx + 10, y: LOT_Y + 0.2, z: cz - 12 });
}

function market(
  B: Builder, phys: Physics, mats: Mats, cx: number, cz: number,
  minimap: MinimapData, pois: Poi[], shops: Shop[], signMeshes: THREE.Mesh[],
  parkSpots: { x: number; z: number; yaw: number }[],
): void {
  B.quad(mats.asphalt, cx, LOT_Y, cz, CORE, CORE, 6);
  // store block at the back
  const w = 44, d = 22, h = 9;
  const bz = cz + 14;
  B.box(mats.plaster[0], cx, LOT_Y + h / 2, bz, w, h, d, 0, 6);
  B.box(mats.metal, cx, LOT_Y + h + 0.5, bz, w + 1.4, 1, d + 1.4, 0, 3);
  B.box(mats.glass, cx, LOT_Y + 2.2, bz - d / 2 - 0.1, w * 0.8, 3.6, 0.12, 0, 0);
  B.box(mats.metal, cx, LOT_Y + 4.6, bz - d / 2 - 1.6, w * 0.85, 0.16, 3.2, 0, 3);
  phys.addCentered(cx, bz, w / 2, d / 2, 0, LOT_Y + h, KIND.Building);
  minimap.buildings.push({ x: cx, z: bz, w, d });
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 3),
    new THREE.MeshBasicMaterial({ map: signTexture('AL-MADINA SUPERMARKET', '#1f4f9c', '#ffffff', 1024, 140), side: THREE.DoubleSide }),
  );
  sign.position.set(cx, LOT_Y + 6.9, bz - d / 2 - 0.25);
  sign.rotation.y = Math.PI;
  signMeshes.push(sign);
  shops.push({ x: cx, z: bz - d / 2 - 3, yaw: 0, name: 'AL-MADINA SUPERMARKET', kind: 'health' });
  shops.push({ x: cx + 12, z: bz - d / 2 - 3, yaw: 0, name: 'AMMU-NATION COUNTER', kind: 'ammo' });
  pois.push({ name: 'SUPERMARKET', x: cx, z: bz - d / 2 - 4, kind: 'market' });
  // car park with painted bays
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 7; i++) {
      const px = cx - 21 + i * 7, pz = cz - 6 - row * 13;
      B.quad(mats.paint, px - 3.2, LOT_Y + 0.02, pz, 0.16, 5.6, 0);
      B.quad(mats.paint, px + 3.2, LOT_Y + 0.02, pz, 0.16, 5.6, 0);
      B.quad(mats.paint, px, LOT_Y + 0.02, pz + (row ? 2.8 : -2.8), 6.4, 0.16, 0);
      if (i % 2 === 0) parkSpots.push({ x: px, z: pz, yaw: row ? Math.PI : 0 });
    }
  }
  // trolleys
  for (let i = 0; i < 4; i++) B.box(mats.metal, cx - 18 + i * 1.1, LOT_Y + 0.5, cz - 20, 0.7, 0.9, 1, 0, 2);
}

function policeBlock(
  B: Builder, phys: Physics, mats: Mats, cx: number, cz: number,
  minimap: MinimapData, pois: Poi[], signMeshes: THREE.Mesh[],
  parkSpots: { x: number; z: number; yaw: number }[],
): { x: number; z: number } {
  B.quad(mats.concrete, cx, LOT_Y, cz, CORE, CORE, 4);
  const w = 34, d = 20, h = 10;
  B.box(mats.plaster[4], cx, LOT_Y + h / 2, cz + 12, w, h, d, 0, 6);
  B.box(mats.concrete, cx, LOT_Y + h + 0.4, cz + 12, w + 1.2, 0.8, d + 1.2, 0, 3);
  B.box(mats.glass, cx, LOT_Y + 2, cz + 12 - d / 2 - 0.08, w * 0.5, 2.8, 0.12, 0, 0);
  B.box(mats.concrete, cx, LOT_Y + 3, cz + 12 - d / 2 - 1.2, 9, 0.5, 2.4, 0, 3);
  for (const ox of [-4, 4]) B.cyl(mats.concrete, cx + ox, LOT_Y + 1.5, cz + 12 - d / 2 - 2.2, 0.4, 0.45, 3, 10);
  phys.addCentered(cx, cz + 12, w / 2, d / 2, 0, LOT_Y + h, KIND.Building);
  minimap.buildings.push({ x: cx, z: cz + 12, w, d });
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 2.2),
    new THREE.MeshBasicMaterial({ map: signTexture('POLICE STATION', '#12325e', '#ffffff', 768, 110), side: THREE.DoubleSide }),
  );
  sign.position.set(cx, LOT_Y + 7, cz + 12 - d / 2 - 0.3);
  sign.rotation.y = Math.PI;
  signMeshes.push(sign);
  for (let i = 0; i < 4; i++) parkSpots.push({ x: cx - 12 + i * 8, z: cz - 12, yaw: Math.PI });
  pois.push({ name: 'POLICE', x: cx, z: cz + 12 - d / 2 - 4, kind: 'police' });
  return { x: cx, z: cz - 4 };
}

function parking(
  B: Builder, phys: Physics, mats: Mats, rng: Rng, cx: number, cz: number,
  minimap: MinimapData, parkSpots: { x: number; z: number; yaw: number }[],
  pickupSpots: { x: number; z: number }[],
): void {
  B.quad(mats.asphalt, cx, LOT_Y, cz, CORE, CORE, 6);
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 8; i++) {
      const px = cx - 24.5 + i * 7, pz = cz - 21 + row * 14;
      B.quad(mats.paint, px - 3.2, LOT_Y + 0.02, pz, 0.16, 5.4, 0);
      B.quad(mats.paint, px + 3.2, LOT_Y + 0.02, pz, 0.16, 5.4, 0);
      if ((i + row) % 3 === 0) parkSpots.push({ x: px, z: pz, yaw: row % 2 ? Math.PI : 0 });
    }
  }
  // attendant hut + a couple of skips
  B.box(mats.plaster[1], cx - HALF_CORE + 4, LOT_Y + 1.4, cz - HALF_CORE + 4, 3.4, 2.8, 3.4, 0, 3);
  B.box(mats.glass, cx - HALF_CORE + 4, LOT_Y + 1.7, cz - HALF_CORE + 5.8, 2.2, 1.2, 0.1, 0, 0);
  phys.addCentered(cx - HALF_CORE + 4, cz - HALF_CORE + 4, 1.7, 1.7, 0, LOT_Y + 2.8, KIND.Building);
  for (let i = 0; i < 2; i++) {
    const bx = cx + HALF_CORE - 6, bz = cz - 8 + i * 12;
    B.box(mats.metal, bx, LOT_Y + 1, bz, 2.4, 2, 5, 0, 3);
    phys.addCentered(bx, bz, 1.2, 2.5, 0, LOT_Y + 2, KIND.Prop);
    pickupSpots.push({ x: bx - 2.6, z: bz });
  }
  minimap.buildings.push({ x: cx - HALF_CORE + 4, z: cz - HALF_CORE + 4, w: 3.4, d: 3.4 });
  if (chance(rng, 1)) pickupSpots.push({ x: cx, z: cz });
}

/** Called by buildCity before any block work so prop helpers can reach the shared materials. */

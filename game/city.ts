import * as THREE from 'three';
import { glowTexture, Mats, signTexture, uvScale } from './materials';
import { KIND, Physics } from './physics';
import { chance, mulberry32, pick, ri, rr, Rng } from './mathx';
import { QualityPreset } from './settings';
import {
  bench, bindProps, Builder, cart, chaiStall, charpai, City, Collect, connect, lamp, LANE_OFF,
  LEFT_HAND_TRAFFIC, LOT_Y, MinimapData, newCollect, PAINT_Y, plant, Poi, powerLine, RoadNode,
  ROAD_Y, Shop, tandoor, WALK_Y, WorldBounds,
} from './layout';
import { buildScheme } from './scheme';
import {
  BlockType, CITY_SOUTH_EDGE, DEFAULT_THEME, SOUTH_TOP, surface, Theme,
} from './theme';
import { AoGrid } from './ao';

/* The geometry batcher, street furniture and shared types live in layout.ts. They are
   re-exported here so the rest of the game can keep importing "the map" from one place. */
export type { City, MinimapData, Poi, RoadNode, Shop, WaterZone } from './layout';
export { LANE_OFF, LEFT_HAND_TRAFFIC, LOT_Y, PAINT_Y, ROAD_Y, WALK_Y } from './layout';
export type { BlockType, Theme } from './theme';
export { DEFAULT_THEME, THEMES, themeById } from './theme';

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

/** Size of the southern grid district on the themed maps (3x3 blocks). */
const SOUTH_N = 4;
/** Centre Z of that district, so its north road line lands just past the canal. */
const SOUTH_CZ = SOUTH_TOP + 8 + ((SOUTH_N - 1) / 2) * PITCH;

/* ----------------------------------------------------------------------------
   Theme binding.

   The block builders below all read the current theme through these module
   locals rather than taking six extra arguments each. Same trick layout.ts uses
   for the shared materials, and for the same reason: buildCity is the only thing
   that ever sets them, once, before any geometry exists.
   ---------------------------------------------------------------------------- */
let TH: Theme = DEFAULT_THEME;
let LOT_MAT: THREE.Material;
let GREEN_MAT: THREE.Material;
let ROAD_MAT: THREE.Material;

export function buildCity(
  scene: THREE.Scene, phys: Physics, mats: Mats, preset: QualityPreset,
  seed = 20260805, theme: Theme = DEFAULT_THEME,
): City {
  bindProps(mats);
  TH = theme;
  LOT_MAT = surface(mats, theme.lot);
  GREEN_MAT = surface(mats, theme.green);
  ROAD_MAT = surface(mats, theme.road);
  const rng = mulberry32(seed);
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  scene.add(root);
  const B = new Builder();

  // One collector shared by every district, destructured for brevity (the fields are
  // arrays, so pushing through either name hits the same storage).
  const C = newCollect();
  const { minimap, roadSpawns, pois, lampPts, signs: signMeshes, nodes } = C;

  const water = theme.water;
  const wHalf = water.width / 2;

  /* ground -------------------------------------------------------------- */
  // Four slabs with a rectangular hole where the channel is dug, instead of one big
  // quad. Without the hole the terrain would roof the canal over and the water would
  // never be visible from above — which is exactly what "fake water" looks like.
  const terrain = surface(mats, theme.terrain);
  const GX = 1100, GZ0 = -700, GZ1 = 900;
  const groundSlab = (cx: number, cz: number, w: number, d: number) => {
    const g = new THREE.PlaneGeometry(w, d, Math.min(48, Math.max(1, Math.round(w / 40))), Math.min(48, Math.max(1, Math.round(d / 40))));
    uvScale(g, w / 6, d / 6);
    const m = new THREE.Mesh(g, terrain);
    m.rotation.x = -Math.PI / 2;
    m.position.set(cx, 0, cz);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    root.add(m);
  };
  groundSlab(0, (GZ0 + (water.z - wHalf)) / 2, GX * 2, water.z - wHalf - GZ0);
  groundSlab(0, ((water.z + wHalf) + GZ1) / 2, GX * 2, GZ1 - (water.z + wHalf));

  /* ── the two halves of the world ─────────────────────────────────────── */
  const north = district(B, phys, mats, rng, C, preset, 0, N, seed);
  let policeStation = north.police;
  let hospital = north.hospital;
  let playerStart = north.home;
  let southEdge: number;
  /** the node each crossing has to reach on the far bank */
  const southLinks: { x: number; w: number; node: RoadNode }[] = [];

  if (theme.south === 'scheme') {
    // The real society, built from its own layout plan, hanging off the canal.
    const scheme = buildScheme(B, phys, mats, preset, rng, C);
    southEdge = scheme.south + 18;
    for (const e of scheme.entrances) southLinks.push(e);
    // The player lives on plot 34, off the boulevard.
    playerStart = scheme.home;
    pois.push({ name: 'HOME', x: scheme.home.x, z: scheme.home.z, kind: 'home' });
  } else {
    const south = district(B, phys, mats, rng, C, preset, SOUTH_CZ, SOUTH_N, seed ^ 0x5bd1);
    southEdge = SOUTH_CZ + ((SOUTH_N - 1) / 2) * PITCH + ROADW / 2 + 26;
    for (const x of water.crossings) {
      const n = south.nodes.find((k) => Math.abs(k.x - x) < 0.5 && k.z === gridZ(SOUTH_CZ, SOUTH_N, 0));
      if (n) southLinks.push({ x, w: ROADW, node: n });
    }
    pois.push({ name: 'HOME', x: playerStart.x, z: playerStart.z, kind: 'home' });
  }

  /* ── the channel and the bridges over it ─────────────────────────────── */
  buildWaterway(B, phys, mats, C, preset, north.nodes, southLinks);

  /* ── world edge ──────────────────────────────────────────────────────── */
  const bounds: WorldBounds = {
    minX: CITY_MIN, maxX: CITY_MAX,
    minZ: CITY_MIN, maxZ: southEdge,
  };

  // Verge planting between the last road and the world edge. On the pine map this is
  // what turns a grid town into a town in a forest; on the desert map it is almost bare.
  if (TH.wild > 0.01) {
    const step = 11 / Math.max(0.25, TH.wild);
    for (let x = bounds.minX + 4; x < bounds.maxX - 4; x += step) {
      for (let z = bounds.minZ + 4; z < bounds.maxZ - 4; z += step) {
        const inGrid = Math.abs(x) < CITY_MAX - 24 && z > CITY_MIN + 24 && z < CITY_MAX - 24;
        const inSouth = theme.south === 'grid'
          && Math.abs(x) < 190 && z > SOUTH_CZ - 190 && z < SOUTH_CZ + 190;
        const inChannel = z > water.z - wHalf - 10 && z < water.z + wHalf + 10;
        if (inGrid || inSouth || inChannel) continue;
        if (!chance(rng, TH.wild * 0.55)) continue;
        plant(B, phys, rng, x + rr(rng, -3, 3), z + rr(rng, -3, 3), rr(rng, 0.9, 1.8), TH.species, 0);
      }
    }
  }

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
    // the side walls stop short of the channel so they never wall the water off mid-air
    if (z > water.z - wHalf - 2 && z < water.z + wHalf + 2) continue;
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
    root, nodes, pedLoops: C.pedLoops, parkSpots: C.parkSpots, roadSpawns, shops: C.shops,
    pois, minimap, itemSpots: C.itemSpots, pickupSpots: C.pickupSpots, playerStart,
    policeStation, hospital, lampGlow, bounds, waterZones: C.waterZones,
    mapId: theme.id, mapName: theme.name,
    triangles: B.triangles,
    setNight(n: number) {
      (lampGlow.material as THREE.PointsMaterial).opacity = n * 0.85;
      for (const f of mats.facade) f.emissiveIntensity = n * 0.9;
    },
  };
}

/* ── one grid district ────────────────────────────────────────────────────── */

/** Road line i of an n-line grid centred on cz. */
function gridZ(cz: number, n: number, j: number): number {
  return cz + (j - (n - 1) / 2) * PITCH;
}

interface DistrictResult {
  nodes: RoadNode[];
  home: { x: number; z: number; yaw: number };
  police: { x: number; z: number };
  hospital: { x: number; z: number };
}

/**
 * The city grid: roads, junctions and one themed block in every square.
 *
 * Pitch and carriageway width are fixed for every district on every map, which is what
 * lets the block builders keep using the BLOCK/CORE constants and what makes a bridge
 * built for one map line up on all four.
 */
function district(
  B: Builder, phys: Physics, mats: Mats, rng: Rng, C: Collect, preset: QualityPreset,
  cz: number, n: number, seed: number,
): DistrictResult {
  const { minimap, pedLoops, roadSpawns, shops, pois, itemSpots, pickupSpots, lampPts, signs: signMeshes, nodes } = C;
  const drng = mulberry32(seed);
  const X = (i: number) => gridZ(0, n, i);
  const Z = (j: number) => gridZ(cz, n, j);
  const blockX = (b: number) => (X(b) + X(b + 1)) / 2;
  const blockZ = (b: number) => (Z(b) + Z(b + 1)) / 2;
  const HR = ROADW / 2;

  /* roads --------------------------------------------------------------- */
  for (let i = 0; i < n; i++) {
    const x = X(i);
    for (let j = 0; j < n - 1; j++) {
      const z1 = Z(j) + HR, z2 = Z(j + 1) - HR;
      B.quad(ROAD_MAT, x, ROAD_Y, (z1 + z2) / 2, ROADW, z2 - z1, 8);
      for (let z = z1 + 3; z < z2 - 3; z += 7) B.quad(mats.paint, x, PAINT_Y, z, 0.22, 3, 0);
      B.quad(mats.paint, x - HR + 0.55, PAINT_Y, (z1 + z2) / 2, 0.16, z2 - z1, 0);
      B.quad(mats.paint, x + HR - 0.55, PAINT_Y, (z1 + z2) / 2, 0.16, z2 - z1, 0);
    }
    minimap.roads.push({ x1: x, z1: Z(0), x2: x, z2: Z(n - 1), w: ROADW });
  }
  for (let j = 0; j < n; j++) {
    const z = Z(j);
    for (let i = 0; i < n - 1; i++) {
      const x1 = X(i) + HR, x2 = X(i + 1) - HR;
      B.quad(ROAD_MAT, (x1 + x2) / 2, ROAD_Y, z, x2 - x1, ROADW, 8);
      for (let x = x1 + 3; x < x2 - 3; x += 7) B.quad(mats.paint, x, PAINT_Y, z, 3, 0.22, 0);
      B.quad(mats.paint, (x1 + x2) / 2, PAINT_Y, z - HR + 0.55, x2 - x1, 0.16, 0);
      B.quad(mats.paint, (x1 + x2) / 2, PAINT_Y, z + HR - 0.55, x2 - x1, 0.16, 0);
    }
    minimap.roads.push({ x1: X(0), z1: z, x2: X(n - 1), z2: z, w: ROADW });
  }

  /* intersections + crosswalks ------------------------------------------ */
  const nodeGrid: (RoadNode | undefined)[] = new Array(n * n).fill(undefined);
  const localNodes: RoadNode[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = X(i), z = Z(j);
      B.quad(ROAD_MAT, x, ROAD_Y, z, ROADW, ROADW, 8);
      const approaches: [number, number][] = [];
      if (j > 0) approaches.push([0, -1]);
      if (j < n - 1) approaches.push([0, 1]);
      if (i > 0) approaches.push([-1, 0]);
      if (i < n - 1) approaches.push([1, 0]);
      for (const [ax, az] of approaches) {
        const cx2 = x + ax * (HR - 1.6), cz2 = z + az * (HR - 1.6);
        for (let k = -3; k <= 3; k++) {
          if (ax !== 0) B.quad(mats.paint, cx2, PAINT_Y, cz2 + k * 2, 2.6, 0.85, 0);
          else B.quad(mats.paint, cx2 + k * 2, PAINT_Y, cz2, 0.85, 2.6, 0);
        }
        // Stop line just before the crossing, on the lane the incoming traffic uses.
        const sx = x + ax * (HR - 3.6), sz = z + az * (HR - 3.6);
        const side = LEFT_HAND_TRAFFIC ? 1 : -1;
        if (ax !== 0) B.quad(mats.paint, sx, PAINT_Y, sz + side * ax * LANE_OFF, 0.3, 7, 0);
        else B.quad(mats.paint, sx - side * az * LANE_OFF, PAINT_Y, sz, 7, 0.3, 0);
      }
      const nd: RoadNode = { x, z, nb: [], nbWidth: [] };
      nodes.push(nd);
      localNodes.push(nd);
      nodeGrid[i * n + j] = nd;
      // traffic light poles on the two safe corners (inside the block slab, never on tarmac)
      if (preset.detail && (i + j) % 2 === 0) {
        for (const [sx2, sz2] of [[1, 1], [-1, -1]] as [number, number][]) {
          const px = x + sx2 * (HR + 1.4), pz = z + sz2 * (HR + 1.4);
          if (i + sx2 < 0 || i + sx2 >= n || j + sz2 < 0 || j + sz2 >= n) continue;
          B.cyl(mats.metal, px, WALK_Y + 2.6, pz, 0.11, 0.13, 5.2, 6);
          B.box(mats.metal, px, WALK_Y + 5.1, pz, 0.24, 0.24, 2.4, 0, 2);
          B.box(mats.metal, px, WALK_Y + 4.5, pz + sz2 * -1.1, 0.34, 0.9, 0.3, 0, 2);
          phys.addCentered(px, pz, 0.28, 0.28, 0, 5.2, KIND.Prop);
        }
      }
    }
  }
  const node = (i: number, j: number) => (i < 0 || j < 0 || i >= n || j >= n ? undefined : nodeGrid[i * n + j]);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = node(i, j)!;
      const right = node(i + 1, j);
      const down = node(i, j + 1);
      if (right) connect(a, right, ROADW);
      if (down) connect(a, down, ROADW);
    }
  }

  /* block layout -------------------------------------------------------- */
  const nb = n - 1;
  const mid = (nb - 1) / 2;
  const layout: BlockType[][] = [];
  for (let bi = 0; bi < nb; bi++) {
    layout[bi] = [];
    for (let bj = 0; bj < nb; bj++) {
      const ring = Math.max(Math.abs(bi - mid), Math.abs(bj - mid));
      layout[bi][bj] = ring < 0.6 ? TH.centre : ring < 1.6 ? pick(drng, TH.ringMix) : pick(drng, TH.outerMix);
    }
  }
  // Landmarks get fixed slots so the map always reads the same way. Only the full-size
  // district has them; the satellite district is ordinary streets by design.
  if (nb === 5) for (const [bi, bj, t] of TH.fixed) layout[bi][bj] = t;
  else {
    layout[0][0] = 'shops';
    layout[nb - 1][nb - 1] = 'park';
  }

  let police = { x: X(0), z: Z(0) };
  let hospital = { x: X(0), z: Z(0) };
  let home: { x: number; z: number; yaw: number } | null = null;

  for (let bi = 0; bi < nb; bi++) {
    for (let bj = 0; bj < nb; bj++) {
      const cx = blockX(bi), cz2 = blockZ(bj);
      const type = layout[bi][bj];

      // pavement slab + kerb (a 16cm step the player walks up, cars can mount)
      B.box(mats.concrete, cx, WALK_Y / 2, cz2, BLOCK, WALK_Y, BLOCK, 0, 3);
      phys.addCentered(cx, cz2, HALF_BLOCK, HALF_BLOCK, 0, WALK_Y, KIND.Ground);
      minimap.blocks.push({ x: cx, z: cz2, s: BLOCK });

      // pedestrian loop around the block, on the pavement mid-line
      const loopR = HALF_BLOCK - SIDEWALK / 2;
      pedLoops.push([
        { x: cx - loopR, z: cz2 - loopR }, { x: cx + loopR, z: cz2 - loopR },
        { x: cx + loopR, z: cz2 + loopR }, { x: cx - loopR, z: cz2 + loopR },
      ]);

      streetFurniture(B, phys, mats, rng, cx, cz2, preset, lampPts, pickupSpots);
      // overhead cables down the north pavement of every block
      const cableZ = cz2 - HALF_BLOCK + SIDEWALK * 0.42;
      powerLine(B, phys, cx - HALF_BLOCK + 11, cableZ, cx + HALF_BLOCK - 11, cableZ, 26);

      switch (type) {
        case 'plaza': plaza(B, phys, mats, rng, cx, cz2, itemSpots, pois, minimap); break;
        case 'tower': towers(B, phys, mats, rng, cx, cz2, minimap, preset, itemSpots); break;
        case 'shops': shopRow(B, phys, mats, rng, cx, cz2, shops, minimap, signMeshes, pois); break;
        case 'houses': {
          const h = houses(B, phys, mats, rng, cx, cz2, minimap, preset, C.parkSpots, itemSpots);
          if (!home) home = h;
          break;
        }
        case 'park': park(B, phys, mats, rng, cx, cz2, minimap, pois, itemSpots, preset); break;
        case 'mosque': mosque(B, phys, mats, cx, cz2, minimap, pois, signMeshes, itemSpots); break;
        case 'market': {
          market(B, phys, mats, cx, cz2, minimap, pois, shops, signMeshes, C.parkSpots);
          hospital = { x: cx, z: cz2 - 6 };
          break;
        }
        case 'police': police = policeBlock(B, phys, mats, cx, cz2, minimap, pois, signMeshes, C.parkSpots); break;
        case 'parking': parking(B, phys, mats, rng, cx, cz2, minimap, C.parkSpots, pickupSpots); break;
      }
    }
  }

  /* on-street parking spots -------------------------------------------- */
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n - 1; j++) {
      const x = X(i), z = (Z(j) + Z(j + 1)) / 2;
      roadSpawns.push({ x: x + (LEFT_HAND_TRAFFIC ? -LANE_OFF : LANE_OFF), z, yaw: 0 });
      roadSpawns.push({ x: x + (LEFT_HAND_TRAFFIC ? LANE_OFF : -LANE_OFF), z: z + 12, yaw: Math.PI });
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n - 1; i++) {
      const z = Z(j), x = (X(i) + X(i + 1)) / 2;
      roadSpawns.push({ x, z: z + (LEFT_HAND_TRAFFIC ? LANE_OFF : -LANE_OFF), yaw: Math.PI / 2 });
      roadSpawns.push({ x: x + 12, z: z + (LEFT_HAND_TRAFFIC ? -LANE_OFF : LANE_OFF), yaw: -Math.PI / 2 });
    }
  }

  // never fall back to a block centre — that is inside a building. Use the pavement.
  const fallback = { x: blockX(nb - 1), z: blockZ(nb - 1) - (HALF_BLOCK - SIDEWALK / 2), yaw: Math.PI };
  return { nodes: localNodes, home: home ?? fallback, police, hospital };
}

/* ── the channel, its embankments and the bridges over it ─────────────────── */

/**
 * The one piece of the map that has to be right or the game is unplayable.
 *
 * Three rules it obeys, all of which the previous attempt broke:
 *
 *  1. Every bridge deck is at ROAD_Y — the *same* height as the road that leads onto it.
 *     A deck 23cm proud of the tarmac is a kerb you have to jump a car over, which is
 *     what "I have to jump a little to cross" meant.
 *  2. The deck is as wide as the carriageway feeding it and is one unbroken Ground
 *     collider from bank to bank, so there is no seam for a wheel to catch on.
 *  3. The channel is a real hole in the world (phys.addPit), not a blue quad painted on
 *     the grass. A wet channel is lined and railed everywhere except at a crossing, so
 *     you cannot wander in by accident — though a stunt ramp will still put you in it,
 *     and then you drown. A dry one (the desert wadi) is terraced instead, in steps
 *     shallow enough to drive down.
 */
function buildWaterway(
  B: Builder, phys: Physics, mats: Mats, C: Collect, preset: QualityPreset,
  northNodes: RoadNode[], southLinks: { x: number; w: number; node: RoadNode }[],
): void {
  const { minimap, pois } = C;
  const w = TH.water;
  const half = w.width / 2;
  const z0 = w.z - half, z1 = w.z + half;   // waterline banks
  const bed = -w.depth;
  const surfaceY = w.dry ? bed : -0.55;
  const WALL_TOP = LOT_Y + 0.18;
  const SPAN = 1000;                        // the channel runs past the world edge

  /* the hole itself ------------------------------------------------------ */
  phys.addPit(-SPAN, z0, SPAN, z1, bed);
  B.quad(surface(mats, w.bed), 0, bed, w.z, SPAN * 2, w.width, 8);

  if (!w.dry) {
    B.quad(mats.water, 0, surfaceY, w.z, SPAN * 2, w.width, 12);
    // Only a wet channel drowns you; the wadi is terrain with a dip in it.
    C.waterZones.push({ minX: -SPAN, maxX: SPAN, minZ: z0, maxZ: z1, surface: surfaceY });
  }
  // The channel is on the map either way, so the bridges have something to cross.
  minimap.water.push({ x: 0, z: w.z, w: 1200, d: w.width });

  /* embankments ---------------------------------------------------------- */
  // A lined channel: a vertical concrete wall from the bed up to the kerb, then a rail.
  // Both are split around each crossing so the bridge decks meet open ground.
  const gaps: [number, number][] = TH.water.crossings
    .map((x) => [x - ROADW / 2 - 1.2, x + ROADW / 2 + 1.2] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const runs: [number, number][] = [];
  {
    let cursor = -SPAN;
    for (const [a, b] of gaps) {
      if (a > cursor) runs.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < SPAN) runs.push([cursor, SPAN]);
  }

  for (const bank of [z0, z1] as const) {
    const inward = bank === z0 ? 1 : -1;   // +1 = towards the middle of the channel

    if (w.dry) {
      // A wadi has no walls: the sand just falls away. Terraced so the step between
      // levels stays under a car's 0.3m ride-up, which is what makes it drivable rather
      // than a cliff you bounce off — the desert map's whole party trick.
      const SLOPE = 16, STEPS = 14;
      for (let i = 0; i < STEPS; i++) {
        const zA = bank + inward * ((i * SLOPE) / STEPS);
        const zB = bank + inward * (((i + 1) * SLOPE) / STEPS);
        const top = WALL_TOP + (bed - WALL_TOP) * ((i + 1) / STEPS);
        // One box per terrace, not a box plus a capping quad: two coplanar surfaces at
        // the same height is a z-fighting shimmer that reads as a rendering fault.
        B.box(surface(mats, w.bed), 0, (top + bed) / 2, (zA + zB) / 2,
          SPAN * 2, Math.max(0.05, top - bed), Math.abs(zB - zA), 0, 6);
        phys.addBox(-SPAN, Math.min(zA, zB), SPAN, Math.max(zA, zB), 0, top, KIND.Ground);
      }
      continue;
    }

    for (const [a, b] of runs) {
      const len = b - a, cx = (a + b) / 2;
      const face = bank + inward * 0.5;    // the wall lines the channel side of the bank
      // retaining wall: its face is the channel side, its top is the towpath kerb
      const wallH = WALL_TOP - bed;
      B.box(mats.concrete, cx, bed + wallH / 2, face, len, wallH, 1.0, 0, 3);
      // railing along the top so a car cannot roll in by accident
      B.box(mats.metal, cx, WALL_TOP + 0.95, face, len, 0.14, 0.14, 0, 2);
      B.box(mats.metal, cx, WALL_TOP + 0.5, face, len, 0.1, 0.1, 0, 2);
      const rail0 = Math.min(bank, bank + inward * 1.1), rail1 = Math.max(bank, bank + inward * 1.1);
      phys.addBox(a, rail0, b, rail1, 0, WALL_TOP + 1.1, KIND.Fence);
      if (preset.detail) {
        for (let x = a + 3; x < b - 3; x += 4.5) {
          B.cyl(mats.metal, x, WALL_TOP + 0.55, face, 0.07, 0.07, 1.1, 6);
        }
      }
      // The towpath is a raised strip on the land side. It is cut at the crossings too:
      // a 14cm lip left across a bridge approach is exactly the bump that made the old
      // bridges undrivable.
      const pathC = bank - inward * 4.6;
      const p0 = Math.min(bank - inward * 0.6, bank - inward * 8.6);
      const p1 = Math.max(bank - inward * 0.6, bank - inward * 8.6);
      B.quad(LOT_MAT, cx, WALK_Y, pathC, len, 8, 4);
      phys.addBox(a, p0, b, p1, 0, WALK_Y, KIND.Ground);
      for (let x = Math.ceil((a + 8) / 30) * 30; x < b - 8; x += 30) {
        if (Math.abs(x) > 240) continue;
        lamp(B, phys, x, pathC, 0, inward, C.lampPts);
      }
    }
  }

  /* the crossings -------------------------------------------------------- */
  for (const x of TH.water.crossings) {
    const grand = x === -40;
    bridge(B, phys, mats, C, preset, x, grand);
  }

  /* wire the road graph across ------------------------------------------- */
  // The bridges are the only way over, so the traffic AI has to see them as edges.
  for (const link of southLinks) {
    const northNode = northNodes.find((k) => Math.abs(k.x - link.x) < 0.5 && k.z === gridZ(0, N, N - 1));
    if (northNode) connect(northNode, link.node, Math.min(link.w, ROADW));
  }

  pois.push({ name: w.bridgeName, x: -40, z: w.z, kind: 'plaza' });
  minimap.labels.push({ t: w.name, x: 150, z: w.z });
}

/**
 * One crossing: causeway, deck, parapets — and, on the boulevard, the suspension towers
 * and stay cables that make the thing a landmark instead of a slab.
 */
function bridge(
  B: Builder, phys: Physics, mats: Mats, C: Collect, preset: QualityPreset,
  x: number, grand: boolean,
): void {
  const w = TH.water;
  const half = w.width / 2;
  const zStart = CITY_SOUTH_EDGE;          // the city kerb the causeway leaves from
  const zEnd = SOUTH_TOP;                  // where the far district's own roads begin
  const len = zEnd - zStart;
  const cz = (zStart + zEnd) / 2;
  const deckW = grand ? ROADW : ROADW - 2;
  const hw = deckW / 2;

  /* deck — one flat Ground collider at road height, bank to bank ---------- */
  C.minimap.roads.push({ x1: x, z1: zStart, x2: x, z2: zEnd, w: deckW });
  B.quad(ROAD_MAT, x, ROAD_Y, cz, deckW, len, 8);
  phys.addCentered(x, cz, hw, len / 2, 0, ROAD_Y, KIND.Ground);
  // centre line and lane edges, exactly as on any other road
  for (let z = zStart + 3; z < zEnd - 3; z += 7) B.quad(mats.paint, x, PAINT_Y, z, 0.22, 3, 0);
  B.quad(mats.paint, x - hw + 0.55, PAINT_Y, cz, 0.16, len, 0);
  B.quad(mats.paint, x + hw - 0.55, PAINT_Y, cz, 0.16, len, 0);

  /* the box girder under the deck, and the piers holding it up ----------- */
  // Its top face must finish *below* ROAD_Y or it paints over the tarmac and the lane
  // markings, and the bridge stops looking like a road at all.
  B.box(mats.concrete, x, ROAD_Y - 0.03 - 0.55, cz, deckW + 1.4, 1.1, len, 0, 3);
  for (let z = w.z - half + 8; z <= w.z + half - 8; z += 16) {
    B.box(mats.concrete, x, (-w.depth - 1) / 2, z, 3.2, w.depth + 1, 3.2, 0, 3);
  }

  /* parapets — solid enough to stop a car, low enough to see the water over */
  for (const side of [-1, 1]) {
    const px = x + side * (hw + 0.45);
    B.box(mats.concrete, px, LOT_Y + 0.35, cz, 0.7, 1.0, len, 0, 3);
    B.box(mats.metal, px, LOT_Y + 1.05, cz, 0.5, 0.16, len, 0, 2);
    phys.addCentered(px, cz, 0.42, len / 2, 0, LOT_Y + 1.1, KIND.Fence);
    if (preset.detail) {
      for (let z = zStart + 5; z < zEnd - 5; z += 10) {
        B.cyl(mats.metal, px, LOT_Y + 1.9, z, 0.06, 0.08, 3.2, 6);
        B.box(mats.metal, px, LOT_Y + 3.5, z, 0.34, 0.16, 0.5, 0, 2);
        C.lampPts.push(px, LOT_Y + 3.5, z);
      }
    }
  }

  if (!grand) return;

  /* ── the Big Pul: two portal towers and a fan of stay cables ─────────── */
  const towerH = 34;
  const towerZ = [w.z - half + 6, w.z + half - 6];
  for (const tz of towerZ) {
    for (const side of [-1, 1]) {
      const tx = x + side * (hw + 2.6);
      B.cyl(mats.concrete, tx, towerH / 2, tz, 1.0, 1.9, towerH, 10);
      phys.addCentered(tx, tz, 1.6, 1.6, 0, towerH, KIND.Building);
      // red aviation beacon
      B.sphere(mats.paint, tx, towerH + 0.7, tz, 0.55, 8, 6);
    }
    // portal cross-beams between the legs
    B.box(mats.concrete, x, towerH - 3.5, tz, deckW + 7, 2.0, 2.2, 0, 3);
    B.box(mats.concrete, x, towerH * 0.62, tz, deckW + 6.4, 1.4, 1.6, 0, 3);
  }

  // stay cables: a fan from each tower crown down to the deck on both sides of it
  for (const tz of towerZ) {
    const dir = tz < w.z ? 1 : -1;
    for (const side of [-1, 1]) {
      const tx = x + side * (hw + 2.6);
      for (let k = 1; k <= 6; k++) {
        for (const sgn of [1, -1]) {
          const anchorZ = tz + dir * sgn * k * 4.2;
          if (Math.abs(anchorZ - CITY_SOUTH_EDGE) < 4 || Math.abs(anchorZ - SOUTH_TOP) < 4) continue;
          const dz = anchorZ - tz, dy = towerH - 2 - (LOT_Y + 1.2);
          const cLen = Math.hypot(dz, dy);
          B.box(mats.metal, tx, (towerH - 2 + LOT_Y + 1.2) / 2, (tz + anchorZ) / 2,
            0.1, cLen, 0.1, 0, Math.atan2(dz, dy));
        }
      }
    }
  }

  // gateway sign on the northern portal
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(15, 2.4),
    new THREE.MeshBasicMaterial({
      map: signTexture(`${w.bridgeName} · ${w.name}`, '#123f24', '#ffffff', 1024, 120),
      side: THREE.DoubleSide,
    }),
  );
  sign.position.set(x, towerH - 3.5, towerZ[0] - 1.3);
  sign.rotation.y = Math.PI;
  C.signs.push(sign);

  // a stunt ramp on the towpath, because a canal you cannot land a car in is wasted
  const rx = x + 46, rz = CITY_SOUTH_EDGE + 12;
  for (let i = 0; i < 7; i++) {
    const h = 0.35 + i * 0.34;
    B.box(mats.metal, rx, h / 2, rz + i * 1.5, 7, h, 1.5, 0, 2);
    phys.addCentered(rx, rz + i * 1.5, 3.5, 0.75, 0, h, KIND.Ground);
  }
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
      if (isTree) plant(B, phys, rng, x, z, 0.9 + rng() * 0.5, TH.species);
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
  B.quad(LOT_MAT, cx, LOT_Y, cz, CORE, CORE, 4);
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
    plant(B, phys, rng, cx + Math.cos(an + 0.4) * 20, cz + Math.sin(an + 0.4) * 20, 1.2, TH.species);
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
  minimap: MinimapData, preset: QualityPreset, itemSpots: { x: number; y: number; z: number }[],
): void {
  B.quad(LOT_MAT, cx, LOT_Y, cz, CORE, CORE, 4);
  const cells = 2;
  const size = CORE / cells;
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const x = cx - CORE / 2 + size * (i + 0.5), z = cz - CORE / 2 + size * (j + 0.5);
      const w = size - rr(rng, 6, 10), d = size - rr(rng, 6, 10);
      const floors = ri(rng, TH.towerFloors[0], TH.towerFloors[1]);
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
  // The service courtyard where the four blocks meet. It is the only clear ground on a
  // tower block, and on the all-towers map it is where most of Mom's list ends up.
  itemSpots.push({ x: cx, y: LOT_Y + 0.2, z: cz });
}

function shopRow(
  B: Builder, phys: Physics, mats: Mats, rng: Rng, cx: number, cz: number,
  shops: Shop[], minimap: MinimapData, signMeshes: THREE.Mesh[], pois: Poi[],
): void {
  B.quad(LOT_MAT, cx, LOT_Y, cz, CORE, CORE, 4);
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

      B.quad(chance(rng, 0.5) ? GREEN_MAT : mats.dirt, lx, LOT_Y + 0.005, lz, half * 2, half * 2, 4);

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
      const storeys = chance(rng, TH.storeyChance) ? 2 : 1;
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
        plant(B, phys, rng, lx + (alongX ? half - 2.2 : fx * (half - 2.6)), lz + (alongX ? fz * (half - 2.6) : half - 2.2), 0.85, TH.species);
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
  B.quad(GREEN_MAT, cx, LOT_Y, cz, CORE, CORE, 5);
  minimap.parks.push({ x: cx, z: cz, w: CORE, d: CORE });
  // crossing paths
  B.quad(mats.concrete, cx, LOT_Y + 0.01, cz, CORE, 3, 3);
  B.quad(mats.concrete, cx, LOT_Y + 0.01, cz, 3, CORE, 3);
  const step = 9 * preset.propStep;
  for (let x = -HALF_CORE + 5; x <= HALF_CORE - 5; x += step) {
    for (let z = -HALF_CORE + 5; z <= HALF_CORE - 5; z += step) {
      if (Math.abs(x) < 4 || Math.abs(z) < 4) continue;
      if (chance(rng, 0.55)) plant(B, phys, rng, cx + x + rr(rng, -1.5, 1.5), cz + z + rr(rng, -1.5, 1.5), rr(rng, 1, 1.7), TH.species);
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
  B.quad(LOT_MAT, cx, LOT_Y, cz, CORE, CORE, 4);
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
  B.quad(ROAD_MAT, cx, LOT_Y, cz, CORE, CORE, 6);
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
  B.quad(LOT_MAT, cx, LOT_Y, cz, CORE, CORE, 4);
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
  B.quad(ROAD_MAT, cx, LOT_Y, cz, CORE, CORE, 6);
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

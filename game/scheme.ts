import * as THREE from 'three';
import { chance, ri, rr, Rng } from './mathx';
import { Mats, signTexture } from './materials';
import { KIND, Physics } from './physics';
import { QualityPreset } from './settings';
import {
  bench, Builder, chaiStall, charpai, Collect, connect, FT, lamp, laundryLine, LOT_Y,
  numberPlate, PAINT_Y, powerLine, RoadNode, ROAD_Y, satelliteDish, tandoor, tree, WALK_Y,
} from './layout';

/**
 * RAHIM GARDEN HOUSING SCHEME, near Gulshan-e-Iqbal Scheme No. 3, Rahim Yar Khan.
 *
 * Authored from the society's own layout plan, so the dimensions are the plan's dimensions:
 *
 *   plots        50' × 103'      roads   30' / 40' / 50' wide
 *   central park 70' wide        scale   1 metre = 1 metre (no compression)
 *
 * Structure, north to south: entrance off the city arterial on the 50' boulevard, four
 * bands of back-to-back plot rows, the 70' park strip through the middle with the masjid
 * on its east end and the community/parking area on its west end, then two more bands.
 * Gate posts carry the real plot numbers, and roughly one plot in seven is still vacant —
 * "encircled plots are available", as the banner says.
 */

/* ── dimensions from the plan ─────────────────────────────────────────────── */
const R30 = 30 * FT;      // 9.14 m — internal streets
const R40 = 40 * FT;      // 12.19 m — west road
const R50 = 50 * FT;      // 15.24 m — main boulevard
const PARK_W = 70 * FT;   // 21.34 m — central park strip
const PLOT_D = 95 * FT;   // 28.96 m — plot depth (plan shows 103' incl. the kerb strip)
const PLOT_W = 50 * FT;   // 15.24 m — nominal plot frontage
const KERB = 1.7;         // raised strip between carriageway and boundary wall

/** World placement: shares the city's road lines so traffic flows straight in. */
export const SCHEME_WEST = -120;    // 40' road (city grid line)
export const SCHEME_EAST = 200;     // Link Rd — the plan's "existing road"
export const SCHEME_BLVD = -40;     // 50' boulevard (city grid line)
export const SCHEME_MID = 120;      // 30' street (city grid line)
/**
 * North edge of the scheme.
 *
 * It used to butt straight onto the city's z = 200 arterial. The Grand Canal now runs
 * through the gap, so the whole society sits 100 m further south and the four streets
 * reach the city over the bridges instead of a kerb line.
 */
export const SCHEME_TOP = 308;

type Band =
  | { kind: 'road'; w: number; centre: number }
  | { kind: 'plots'; face: -1 | 1; z0: number }
  | { kind: 'park'; z0: number };

export interface SchemeResult {
  home: { x: number; z: number; yaw: number };
  parkCentre: { x: number; z: number };
  south: number;
  plots: number;
  /** the scheme's four entrances, for wiring into the city grid at the right width */
  entrances: { x: number; w: number; node: RoadNode }[];
}

export function buildScheme(
  B: Builder, phys: Physics, mats: Mats, preset: QualityPreset, rng: Rng, C: Collect,
): SchemeResult {
  const verticals: { x: number; w: number }[] = [
    { x: SCHEME_WEST, w: R40 },
    { x: SCHEME_BLVD, w: R50 },
    { x: SCHEME_MID, w: R30 },
    { x: SCHEME_EAST, w: R30 },
  ];

  /* ── walk the bands north → south ─────────────────────────────────────── */
  const bands: Band[] = [];
  let z = SCHEME_TOP + 6;
  const layout: ('road' | 'plotsN' | 'plotsS' | 'park')[] = [
    'road', 'plotsN', 'plotsS',
    'road', 'plotsN', 'plotsS',
    'road', 'park',
    'road', 'plotsN', 'plotsS',
    'road', 'plotsN', 'plotsS',
    'road',
  ];
  for (const kind of layout) {
    if (kind === 'road') {
      bands.push({ kind: 'road', w: R30, centre: z + R30 / 2 });
      z += R30;
    } else if (kind === 'park') {
      bands.push({ kind: 'park', z0: z });
      z += PARK_W;
    } else {
      bands.push({ kind: 'plots', face: kind === 'plotsN' ? -1 : 1, z0: z });
      z += PLOT_D;
    }
  }
  const south = z;
  const roads = bands.filter((b): b is Extract<Band, { kind: 'road' }> => b.kind === 'road');
  const parkBand = bands.find((b): b is Extract<Band, { kind: 'park' }> => b.kind === 'park')!;
  const parkZ = parkBand.z0 + PARK_W / 2;

  /* ── carriageways ─────────────────────────────────────────────────────── */
  // Horizontals at ROAD_Y, verticals 4 mm higher: they cross at junctions and this avoids
  // z-fighting without having to split every street into segments.
  for (const r of roads) {
    B.quad(mats.asphalt, (SCHEME_WEST + SCHEME_EAST) / 2, ROAD_Y, r.centre, SCHEME_EAST - SCHEME_WEST, r.w, 8);
    C.minimap.roads.push({ x1: SCHEME_WEST, z1: r.centre, x2: SCHEME_EAST, z2: r.centre, w: r.w });
  }
  for (const v of verticals) {
    const z0 = SCHEME_TOP, z1 = south;
    B.quad(mats.asphalt, v.x, ROAD_Y + 0.004, (z0 + z1) / 2, v.w, z1 - z0, 8);
    C.minimap.roads.push({ x1: v.x, z1: z0, x2: v.x, z2: z1, w: v.w });
    // the boulevard is the only street wide enough for a centre line
    if (v.w >= R50) {
      for (let zz = z0 + 4; zz < z1 - 4; zz += 7) B.quad(mats.paint, v.x, PAINT_Y, zz, 0.2, 3, 0);
    }
  }

  /* ── road graph ───────────────────────────────────────────────────────── */
  const grid: RoadNode[][] = [];
  for (let vi = 0; vi < verticals.length; vi++) {
    grid[vi] = [];
    for (let ri2 = 0; ri2 < roads.length; ri2++) {
      const n: RoadNode = { x: verticals[vi].x, z: roads[ri2].centre, nb: [], nbWidth: [] };
      grid[vi][ri2] = n;
      C.nodes.push(n);
    }
  }
  for (let vi = 0; vi < verticals.length; vi++) {
    for (let ri2 = 0; ri2 < roads.length; ri2++) {
      if (ri2 > 0) connect(grid[vi][ri2 - 1], grid[vi][ri2], verticals[vi].w);
      if (vi > 0) connect(grid[vi - 1][ri2], grid[vi][ri2], roads[ri2].w);
    }
  }
  const entrances = verticals.map((v, vi) => ({ x: v.x, w: v.w, node: grid[vi][0] }));

  /* ── plot rows ────────────────────────────────────────────────────────── */
  // Frontages are split by the vertical streets, then divided evenly — exactly how a real
  // subdivision fills a block, and it guarantees plots never sit in a carriageway.
  const segments: { x0: number; x1: number }[] = [];
  for (let i = 0; i < verticals.length - 1; i++) {
    const a = verticals[i], b = verticals[i + 1];
    segments.push({ x0: a.x + a.w / 2 + 0.6, x1: b.x - b.w / 2 - 0.6 });
  }

  const boardMat = new THREE.MeshBasicMaterial({
    map: signTexture('PLOT AVAILABLE', '#0f5f3a', '#ffffff', 384, 128),
    side: THREE.DoubleSide,
  });

  let plotNo = 1;
  let home: SchemeResult['home'] | null = null;
  const homeTarget = 34;   // the plot the player calls theirs

  for (const band of bands) {
    if (band.kind !== 'plots') continue;
    const frontZ = band.face < 0 ? band.z0 : band.z0 + PLOT_D;          // street edge
    const backZ = band.face < 0 ? band.z0 + PLOT_D : band.z0;           // rear edge
    // `into` points from the street towards the rear of the plot — the direction every
    // piece of the plot is laid out along. Getting this backwards puts houses in the road.
    const into = -band.face;
    // raised kerb strip, taken out of the plot band so it never eats the carriageway
    const kerbZ = frontZ + into * (KERB / 2);
    B.box(mats.concrete, (SCHEME_WEST + SCHEME_EAST) / 2, LOT_Y / 2, kerbZ, SCHEME_EAST - SCHEME_WEST, LOT_Y, KERB, 0, 3);
    // One ground slab for the whole band. Without it the plots would have visual ground at
    // LOT_Y and collision ground at 0, and you would walk around ankle-deep in your garden.
    phys.addBox(
      SCHEME_WEST, Math.min(band.z0, band.z0 + PLOT_D),
      SCHEME_EAST, Math.max(band.z0, band.z0 + PLOT_D), 0, LOT_Y, KIND.Ground,
    );
    // Overhead power lines down the kerb, one run per block face so no pole lands in a
    // junction. This is the detail that makes a street read as Pakistani more than any
    // single building does.
    for (const seg of segments) {
      powerLine(B, phys, seg.x0 + 2, kerbZ, seg.x1 - 2, kerbZ, 27, LOT_Y);
    }
    // pedestrians walk the kerb, never the tarmac
    C.pedLoops.push([
      { x: SCHEME_WEST + 8, z: kerbZ },
      { x: SCHEME_EAST - 8, z: kerbZ },
    ]);

    for (const seg of segments) {
      const len = seg.x1 - seg.x0;
      const n = Math.max(1, Math.round(len / PLOT_W));
      const w = len / n;
      for (let i = 0; i < n; i++) {
        const cx = seg.x0 + w * (i + 0.5);
        const no = plotNo++;
        const vacant = no % 7 === 3;
        const front = frontZ + into * KERB;
        const res = plot(B, phys, mats, rng, C, {
          cx, w, front, back: backZ, face: band.face, no, vacant, boardMat, preset,
        });
        if (no === homeTarget) home = res;
      }
    }
  }

  /* ── the 70 ft central park ───────────────────────────────────────────── */
  {
    // ground slab covering the park band, the masjid plot and the community area
    phys.addBox(SCHEME_WEST, parkBand.z0, SCHEME_EAST, parkBand.z0 + PARK_W, 0, LOT_Y, KIND.Ground);
    const px0 = -30, px1 = 150;
    const capR = PARK_W / 2;
    const midX = (px0 + px1) / 2;
    B.quad(mats.grass, midX, LOT_Y, parkZ, px1 - px0 - capR * 2, PARK_W, 5);
    B.cyl(mats.grass, px0 + capR, LOT_Y - 0.045, parkZ, capR, capR, 0.1, 18);
    B.cyl(mats.grass, px1 - capR, LOT_Y - 0.045, parkZ, capR, capR, 0.1, 18);
    C.minimap.parks.push({ x: midX, z: parkZ, w: px1 - px0, d: PARK_W });
    // kerb: a step you can walk over, not a wall
    for (const side of [-1, 1]) {
      B.box(mats.curb, midX, WALK_Y / 2, parkZ + side * (PARK_W / 2 + 0.2), px1 - px0, WALK_Y, 0.4, 0, 3);
    }
    // walking path down the spine
    B.quad(mats.concrete, midX, LOT_Y + 0.01, parkZ, px1 - px0 - 6, 2.6, 3);
    const step = 14 * preset.propStep;
    for (let x = px0 + 8; x < px1 - 6; x += step) {
      tree(B, phys, rng, x, parkZ - PARK_W / 2 + 2.6, rr(rng, 1.1, 1.7), LOT_Y);
      tree(B, phys, rng, x + step / 2, parkZ + PARK_W / 2 - 2.6, rr(rng, 1.1, 1.7), LOT_Y);
      if ((x | 0) % 3 === 0) bench(B, phys, x, parkZ - 2.2, 0, LOT_Y);
      else bench(B, phys, x, parkZ + 2.2, Math.PI, LOT_Y);
    }
    for (let x = px0 + 20; x < px1 - 10; x += 42) lamp(B, phys, x, parkZ, 0, 0, C.lampPts, LOT_Y, 4.6);
    // children's play corner at the west end
    playground(B, phys, mats, px0 + 12, parkZ);
    C.pois.push({ name: 'RAHIM GARDEN PARK', x: midX, z: parkZ, kind: 'park' });
    C.pedLoops.push([
      { x: px0 + 12, z: parkZ }, { x: px1 - 12, z: parkZ },
    ]);
    C.itemSpots.push({ x: px1 - 24, y: LOT_Y + 0.25, z: parkZ + 6 });
    C.pickupSpots.push({ x: px0 + 26, z: parkZ - 6 }, { x: midX + 30, z: parkZ + 7 });
  }

  /* ── masjid on the east end of the park band ──────────────────────────── */
  {
    const mx = 176, mz = parkZ;
    B.quad(mats.concrete, mx, LOT_Y, mz, 42, PARK_W, 4);
    const hw = 20, hd = 14, hh = 7;
    B.box(mats.plaster[5], mx, LOT_Y + hh / 2, mz + 1.5, hw, hh, hd, 0, 5);
    B.box(mats.concrete, mx, LOT_Y + hh + 0.4, mz + 1.5, hw + 1, 0.8, hd + 1, 0, 3);
    phys.addCentered(mx, mz + 1.5, hw / 2, hd / 2, 0, LOT_Y + hh, KIND.Building);
    C.minimap.buildings.push({ x: mx, z: mz + 1.5, w: hw, d: hd });
    B.cyl(mats.plaster[5], mx, LOT_Y + hh + 1.3, mz + 1.5, 5, 5.6, 1.4, 16);
    B.sphere(mats.paint, mx, LOT_Y + hh + 4, mz + 1.5, 4.9, 18, 12, 1.15);
    B.cyl(mats.metal, mx, LOT_Y + hh + 9.6, mz + 1.5, 0.07, 0.07, 1.4, 6);
    B.sphere(mats.metal, mx, LOT_Y + hh + 10.5, mz + 1.5, 0.34, 8, 6);
    // single minaret on the street corner
    const nx = mx - hw / 2 - 2.4;
    B.cyl(mats.plaster[5], nx, LOT_Y + 8, mz - 4, 0.95, 1.2, 16, 12);
    B.cyl(mats.plaster[2], nx, LOT_Y + 16.4, mz - 4, 1.5, 1.5, 0.7, 12);
    B.sphere(mats.paint, nx, LOT_Y + 17.6, mz - 4, 1.3, 12, 8, 1.2);
    phys.addCentered(nx, mz - 4, 1.2, 1.2, 0, LOT_Y + 16, KIND.Building);
    // courtyard wall with a gap facing the street
    for (const side of [-1, 1]) {
      B.box(mats.plaster[2], mx + side * 15, LOT_Y + 1.2, mz - PARK_W / 2 + 0.5, 12, 2.4, 0.4, 0, 3);
      phys.addCentered(mx + side * 15, mz - PARK_W / 2 + 0.5, 6, 0.2, 0, LOT_Y + 2.4, KIND.Fence);
    }
    C.pois.push({ name: 'MASJID', x: mx, z: mz - PARK_W / 2 - 3, kind: 'mosque' });
    C.itemSpots.push({ x: mx + 14, y: LOT_Y + 0.25, z: mz + 8 });
    sign(B, C, mats, 'JAMIA MASJID RAHIM GARDEN', '#1f6b45', mx, LOT_Y + 4.4, mz - PARK_W / 2 + 0.85, 0, 11, 1.4);
  }

  /* ── community hall + parking on the west end of the park band ────────── */
  {
    const cx = -78, cz = parkZ;
    B.quad(mats.asphalt, cx, LOT_Y, cz, 78, PARK_W, 6);
    B.box(mats.plaster[1], cx - 22, LOT_Y + 2.6, cz, 20, 5.2, 12, 0, 5);
    B.box(mats.concrete, cx - 22, LOT_Y + 5.4, cz, 21, 0.6, 13, 0, 3);
    B.box(mats.glass, cx - 22, LOT_Y + 1.9, cz - 6.1, 12, 2.6, 0.12, 0, 0);
    phys.addCentered(cx - 22, cz, 10, 6, 0, LOT_Y + 5.2, KIND.Building);
    C.minimap.buildings.push({ x: cx - 22, z: cz, w: 20, d: 12 });
    sign(B, C, mats, 'COMMUNITY CENTRE', '#8a4a2a', cx - 22, LOT_Y + 4.2, cz - 6.25, 0, 11, 1.3);
    // parking bays
    for (let i = 0; i < 6; i++) {
      const bx = cx + 2 + i * 6.4;
      B.quad(mats.paint, bx - 3.1, LOT_Y + 0.02, cz, 0.16, 5.2, 0);
      B.quad(mats.paint, bx + 3.1, LOT_Y + 0.02, cz, 0.16, 5.2, 0);
      if (i % 2 === 0) C.parkSpots.push({ x: bx, z: cz, yaw: 0 });
    }
    C.pickupSpots.push({ x: cx - 8, z: cz + 7 });
    // the corner where the neighbourhood actually gathers
    tandoor(B, phys, cx - 6, cz - 6);
    chaiStall(B, phys, cx + 2, cz + 6, 0);
    charpai(B, phys, cx - 2, cz - 7, 0);
    charpai(B, phys, cx + 8, cz - 7, 1);
  }

  /* ── entrance gate on the boulevard ───────────────────────────────────── */
  {
    const gx = SCHEME_BLVD, gz = SCHEME_TOP + 1.5;
    for (const side of [-1, 1]) {
      const px = gx + side * (R50 / 2 + 1.6);
      B.box(mats.plaster[2], px, LOT_Y + 3.2, gz, 2.2, 6.4, 2.2, 0, 4);
      B.box(mats.concrete, px, LOT_Y + 6.7, gz, 2.8, 0.6, 2.8, 0, 3);
      B.cone(mats.roof, px, LOT_Y + 7.6, gz, 1.7, 1.6, 8);
      phys.addCentered(px, gz, 1.1, 1.1, 0, LOT_Y + 6.4, KIND.Building);
    }
    B.box(mats.plaster[2], gx, LOT_Y + 6.9, gz, R50 + 3.2, 1.9, 1.1, 0, 4);
    sign(B, C, mats, 'RAHIM GARDEN HOUSING SCHEME', '#b8342a', gx, LOT_Y + 7.2, gz - 0.6, Math.PI, R50 + 2, 1.25);
    sign(B, C, mats, 'NEAR GULSHAN-E-IQBAL SCHEME NO. 3', '#14335e', gx, LOT_Y + 5.6, gz - 1.2, Math.PI, R50, 0.85);
    C.pois.push({ name: 'RAHIM GARDEN', x: gx, z: gz + 6, kind: 'gate' });
  }

  /* ── street signs + lamps along the boulevard ─────────────────────────── */
  sign(B, C, mats, "MAIN BOULEVARD 50'", '#14335e', SCHEME_BLVD + R50 / 2 + 2.6, LOT_Y + 2.4, SCHEME_TOP + 26, Math.PI / 2, 5, 0.8, true);
  sign(B, C, mats, 'LINK RD', '#14335e', SCHEME_EAST - R30 / 2 - 2.4, LOT_Y + 2.4, SCHEME_TOP + 30, -Math.PI / 2, 4, 0.8, true);
  for (const r of roads) {
    for (const v of verticals) {
      if (v.x === SCHEME_EAST) continue;
      lamp(B, phys, v.x + v.w / 2 + 1.1, r.centre + r.w / 2 + 1.1, -1, 0, C.lampPts);
    }
  }

  /* ── south boundary hedge so the district reads as finished ───────────── */
  for (let x = SCHEME_WEST; x <= SCHEME_EAST; x += 8) {
    B.box(mats.foliage, x, WALK_Y + 0.9, south + 2, 8, 1.8, 1.6, 0, 3);
  }

  return {
    home: home ?? { x: SCHEME_BLVD + 12, z: parkZ - 40, yaw: 0 },
    parkCentre: { x: 60, z: parkZ },
    south,
    plots: plotNo - 1,
    entrances,
  };
}

/* ── one plot ─────────────────────────────────────────────────────────────── */

interface PlotOpts {
  cx: number;
  w: number;
  /** z of the plot's street-facing boundary */
  front: number;
  /** z of the plot's rear boundary */
  back: number;
  face: -1 | 1;
  no: number;
  vacant: boolean;
  boardMat: THREE.Material;
  preset: QualityPreset;
}

function plot(
  B: Builder, phys: Physics, mats: Mats, rng: Rng, C: Collect, o: PlotOpts,
): { x: number; z: number; yaw: number } {
  const { cx, face, no } = o;
  const into = -face;                          // street → rear of plot
  const halfW = o.w / 2 - 0.35;
  const depth = Math.abs(o.back - o.front);
  const centreZ = (o.front + o.back) / 2;
  const yaw = face < 0 ? Math.PI : 0;          // face out towards the street
  const gate = 3.6;
  const wallH = 1.9;

  // plot ground
  B.quad(chance(rng, 0.35) ? mats.dirt : mats.grass, cx, LOT_Y, centreZ, halfW * 2, depth - 0.5, 4);

  // boundary wall: sides, rear, and a front wall split by the gate
  for (const side of [-1, 1]) {
    B.box(mats.plaster[3], cx + side * halfW, LOT_Y + wallH / 2, centreZ, 0.3, wallH, depth - 0.4, 0, 3);
    phys.addCentered(cx + side * halfW, centreZ, 0.15, (depth - 0.4) / 2, 0, LOT_Y + wallH, KIND.Fence);
  }
  B.box(mats.plaster[3], cx, LOT_Y + wallH / 2, o.back, halfW * 2, wallH, 0.3, 0, 3);
  phys.addCentered(cx, o.back, halfW, 0.15, 0, LOT_Y + wallH, KIND.Fence);
  const segW = (halfW * 2 - gate) / 2;
  for (const side of [-1, 1]) {
    const sx = cx + side * (gate / 2 + segW / 2);
    B.box(mats.plaster[3], sx, LOT_Y + wallH / 2, o.front, segW, wallH, 0.3, 0, 3);
    phys.addCentered(sx, o.front, segW / 2, 0.15, 0, LOT_Y + wallH, KIND.Fence);
    // gate pillars
    B.box(mats.concrete, cx + side * gate / 2, LOT_Y + 1.2, o.front, 0.42, 2.4, 0.42, 0, 2);
  }
  // plot number on the left-hand pillar, facing the street
  numberPlate(B, no, cx - gate / 2, LOT_Y + 1.75, o.front + face * 0.24, face < 0 ? Math.PI : 0);

  if (o.vacant) {
    // "encircled plots are available" — a for-sale board and nothing else
    B.cyl(mats.metal, cx, LOT_Y + 1.1, o.front + face * -3, 0.05, 0.05, 2.2, 6);
    B.push(o.boardMat, new THREE.PlaneGeometry(2.2, 0.74), cx, LOT_Y + 2.1, o.front + face * -3.03, face < 0 ? Math.PI : 0);
    if (chance(rng, 0.4)) C.pickupSpots.push({ x: cx, z: centreZ });
    return { x: cx, z: o.front + into * 3, yaw };
  }

  // house: fills most of the frontage, set back to leave a courtyard, flat roof + parapet
  const hw = Math.min(halfW * 2 - 1.4, 13.5);
  const hd = Math.min(depth - 12, 15);
  const storeys = chance(rng, 0.42) ? 2 : 1;
  const h = storeys * 3.35;
  const hz = o.front + into * (depth - hd / 2 - 1.2);
  const wall = mats.plaster[ri(rng, 0, 5)];
  B.box(wall, cx, LOT_Y + h / 2, hz, hw, h, hd, 0, 5);
  B.box(mats.concrete, cx, LOT_Y + h + 0.28, hz, hw + 0.5, 0.55, hd + 0.5, 0, 3);   // parapet
  phys.addCentered(cx, hz, hw / 2, hd / 2, 0, LOT_Y + h, KIND.Building);
  C.minimap.buildings.push({ x: cx, z: hz, w: hw, d: hd });

  // street elevation: door, grille windows, sunshade, and a first-floor balcony
  const fz = hz - into * (hd / 2 + 0.07);      // the elevation that faces the street
  B.box(mats.wood, cx - hw / 2 + 1.6, LOT_Y + 1.15, fz, 1.15, 2.3, 0.14, 0, 2);
  for (const ox of [1.2, 4]) {
    B.box(mats.glass, cx - hw / 2 + 1.6 + ox + 1.4, LOT_Y + 1.8, fz, 1.5, 1.4, 0.1, 0, 0);
  }
  if (o.preset.detail) {
    B.box(mats.concrete, cx, LOT_Y + 2.65, fz + face * 0.45, hw * 0.92, 0.18, 1.1, 0, 3);
  }
  if (storeys === 2) {
    for (const ox of [-3.4, 0, 3.4]) {
      B.box(mats.glass, cx + ox, LOT_Y + 4.95, fz, 1.4, 1.3, 0.1, 0, 0);
    }
    B.box(mats.concrete, cx, LOT_Y + 3.5, fz + face * 0.7, hw * 0.8, 0.2, 1.6, 0, 3);
    for (let i = 0; i < 7; i++) {
      B.box(mats.metal, cx - hw * 0.36 + i * (hw * 0.72 / 6), LOT_Y + 4, fz + face * 1.4, 0.06, 0.9, 0.06, 0, 2);
    }
  }
  // rooftop water tank + stair enclosure
  B.box(mats.plaster[1], cx + hw / 2 - 1.8, LOT_Y + h + 1.4, hz + into * (hd / 2 - 1.8), 3, 2.2, 3, 0, 4);
  B.cyl(mats.metal, cx - hw / 2 + 1.6, LOT_Y + h + 1.2, hz, 0.62, 0.62, 1.25, 10);
  // rooftop life: a dish and the washing out to dry
  if (no % 2 === 0) satelliteDish(B, cx - hw / 2 + 0.9, LOT_Y + h + 0.55, hz - into * (hd / 2 - 1.2), (no % 4) * 0.7);
  if (no % 3 === 0) laundryLine(B, cx + 1.2, LOT_Y + h + 0.55, hz, Math.min(hd - 2, 5), Math.PI / 2);
  // a charpai out in the courtyard
  if (no % 5 === 1) charpai(B, phys, cx + halfW * 0.45, o.front + into * 4.6, no % 2);

  // driveway from the gate to the house
  const dz = (o.front + hz) / 2;
  B.quad(mats.concrete, cx, LOT_Y + 0.012, dz, 4.6, Math.abs(hz - o.front) - hd / 2, 3);
  if (chance(rng, 0.35)) C.parkSpots.push({ x: cx, z: o.front + into * 4.2, yaw });
  if (chance(rng, 0.3)) tree(B, phys, rng, cx + halfW - 1.6, o.front + into * 5, 0.8, LOT_Y);
  if (no % 23 === 0) C.itemSpots.push({ x: cx, y: LOT_Y + 0.25, z: o.front + into * 4 });

  return { x: cx, z: o.front + into * 3.2, yaw };
}

/* ── bits and pieces ──────────────────────────────────────────────────────── */

function playground(B: Builder, phys: Physics, mats: Mats, x: number, z: number): void {
  // swing frame
  for (const side of [-1, 1]) {
    B.box(mats.metal, x + side * 1.6, LOT_Y + 1.1, z - 1, 0.12, 2.2, 0.12, 0, 2);
    B.box(mats.metal, x + side * 1.6, LOT_Y + 1.1, z + 1, 0.12, 2.2, 0.12, 0, 2);
  }
  B.box(mats.metal, x, LOT_Y + 2.2, z, 3.4, 0.12, 0.12, 0, 2);
  for (const ox of [-0.8, 0.8]) {
    B.box(mats.metal, x + ox, LOT_Y + 1.6, z, 0.05, 1.1, 0.05, 0, 2);
    B.box(mats.wood, x + ox, LOT_Y + 1.05, z, 0.5, 0.07, 0.24, 0, 2);
  }
  // slide
  B.box(mats.metal, x + 5, LOT_Y + 1, z, 1.2, 2, 1.2, 0, 2);
  B.push(mats.metal, new THREE.BoxGeometry(0.9, 0.1, 3.4), x + 6.6, LOT_Y + 1.1, z, 0, -0.55);
  phys.addCentered(x + 5, z, 0.7, 0.7, 0, LOT_Y + 2, KIND.Prop);
  // sand pit
  B.quad(mats.dirt, x + 2.4, LOT_Y + 0.012, z + 5, 6, 4, 3);
}

function sign(
  B: Builder, C: Collect, mats: Mats, text: string, bg: string,
  x: number, y: number, z: number, rotY: number, w: number, h: number, post = false,
): void {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      map: signTexture(text, bg, '#ffffff', 768, Math.round((768 * h) / w)),
      side: THREE.DoubleSide,
    }),
  );
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  C.signs.push(mesh);
  if (post) B.cyl(mats.metal, x, (y + LOT_Y) / 2, z, 0.055, 0.07, y - LOT_Y, 6);
}

/** The plan's own dimensions, exported so the tests can check we built to them. */
export const PLAN = { R30, R40, R50, PARK_W, PLOT_D, PLOT_W, KERB } as const;

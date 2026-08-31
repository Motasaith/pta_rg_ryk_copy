import { Mats } from './materials';
import { Species } from './layout';

/**
 * What makes one map look like a different place from another.
 *
 * Every map in maps.ts is the *same* proven generator (city.ts) driven by one of these.
 * That is deliberate: a from-scratch generator per theme would take four times the code
 * and look a quarter as finished. What actually reads as "a different place" is the
 * ground you walk on, the trees, the height and mix of what is built on each block, and
 * the water running through the middle — so those are the knobs, and nothing else.
 */

export type BlockType =
  | 'plaza' | 'tower' | 'shops' | 'houses' | 'park' | 'mosque' | 'market' | 'police' | 'parking';

/** Which member of Mats a themed surface resolves to. */
export type SurfaceId =
  | 'asphalt' | 'concrete' | 'grass' | 'dirt' | 'sand' | 'forestFloor' | 'cobble';

export function surface(mats: Mats, id: SurfaceId) {
  return mats[id];
}

/** The channel that splits every map into a north and a south half. */
export interface WaterPlan {
  /** centre line, world Z */
  z: number;
  /** water surface width across the channel */
  width: number;
  /** how far the bed sits below y = 0 */
  depth: number;
  /** a dry bed (desert wadi): no water, no drowning, and you can drive down into it */
  dry: boolean;
  /** bed covering */
  bed: SurfaceId;
  name: string;
  bridgeName: string;
  /** road lines that cross it; the boulevard at x = -40 always carries the big bridge */
  crossings: number[];
}

export interface Theme {
  id: string;
  name: string;
  region: string;
  blurb: string;
  /** two hex strings for the map-picker card's gradient */
  swatch: [string, string];
  /** hour of day the map opens on */
  hour: number;

  /** the endless terrain the whole map sits on */
  terrain: SurfaceId;
  /** carriageways */
  road: SurfaceId;
  /** block slabs, plaza and forecourt floors */
  lot: SurfaceId;
  /** lawns, verges, park interiors */
  green: SurfaceId;
  species: Species;

  /** block pools: ring 1 hugs the centre, ring 2+ is everything outward */
  ringMix: BlockType[];
  outerMix: BlockType[];
  /** the middle block */
  centre: BlockType;
  /**
   * Landmark slots, [bi, bj, type] — applied after the random pass.
   *
   * Every theme pins a `parking` block, because that is where the Pay 'n' Spray goes and
   * a map where you cannot lose the police by respraying is a map missing a mechanic.
   */
  fixed: [number, number, BlockType][];

  /** storeys per tower block */
  towerFloors: [number, number];
  /** how often a house gets a first floor */
  storeyChance: number;
  /** 0..1 — how thickly trees fill the verge outside the grid */
  wild: number;

  /** the south half of the world */
  south: 'scheme' | 'grid';
  water: WaterPlan;
}

/* The band between the two halves is identical on every map, so a bridge built for one
   fits all of them and the traffic graph always joins up the same way. */
export const CITY_SOUTH_EDGE = 208;   // outer kerb of the city's z = 200 arterial
export const SOUTH_TOP = 308;         // where the southern district starts
export const CANAL_Z = (CITY_SOUTH_EDGE + SOUTH_TOP) / 2;   // 258

const SCHEME_CROSSINGS = [-120, -40, 120, 200];
const GRID_CROSSINGS = [-120, -40, 40, 120];

export const THEMES: Theme[] = [
  {
    id: 'rahim',
    name: 'Rahim Garden City',
    region: 'Rahim Yar Khan · Punjab',
    blurb: 'The original. A Pakistani grid city of bazaars, tandoors and tower blocks, '
      + 'joined to the Rahim Garden housing scheme by the Big Pul.',
    swatch: ['#c9a227', '#3f6d3a'],
    hour: 9.5,
    terrain: 'grass',
    road: 'asphalt',
    lot: 'concrete',
    green: 'grass',
    species: 'broadleaf',
    ringMix: ['tower', 'tower', 'shops'],
    outerMix: ['houses', 'houses', 'houses', 'park', 'shops', 'parking'],
    centre: 'plaza',
    fixed: [
      [1, 1, 'mosque'], [1, 3, 'market'], [3, 1, 'police'], [3, 3, 'tower'],
      [0, 2, 'park'], [4, 2, 'houses'], [2, 0, 'shops'], [2, 4, 'park'], [3, 4, 'houses'],
      [4, 0, 'parking'],
    ],
    towerFloors: [4, 13],
    storeyChance: 0.45,
    wild: 0.18,
    south: 'scheme',
    water: {
      z: CANAL_Z, width: 56, depth: 3.2, dry: false, bed: 'dirt',
      name: 'THE GRAND CANAL',
      bridgeName: 'BIG PUL',
      crossings: SCHEME_CROSSINGS,
    },
  },
  {
    id: 'thal',
    name: 'Thal Desert Outpost',
    region: 'Thal Desert · Punjab',
    blurb: 'Sand to the horizon, flat-roofed compounds, date palms and a fuel-depot town. '
      + 'The canal is a dry wadi — you can drive straight down into the bed.',
    swatch: ['#dcb26a', '#8a5a2b'],
    hour: 16.5,
    terrain: 'sand',
    road: 'asphalt',
    lot: 'sand',
    green: 'sand',
    species: 'palm',
    ringMix: ['shops', 'houses', 'parking'],
    outerMix: ['houses', 'houses', 'parking', 'shops', 'houses', 'park'],
    centre: 'plaza',
    fixed: [
      [1, 1, 'mosque'], [1, 3, 'market'], [3, 1, 'police'], [3, 3, 'parking'],
      [0, 2, 'houses'], [2, 0, 'shops'], [2, 4, 'houses'], [3, 4, 'houses'],
      [4, 0, 'parking'],
    ],
    towerFloors: [2, 5],
    storeyChance: 0.15,
    wild: 0.07,
    south: 'grid',
    water: {
      z: CANAL_Z, width: 56, depth: 3.4, dry: true, bed: 'sand',
      name: 'THE DRY WADI',
      bridgeName: 'WADI CROSSING',
      crossings: GRID_CROSSINGS,
    },
  },
  {
    id: 'pine',
    name: 'Murree Pine Valley',
    region: 'Murree Hills · Punjab',
    blurb: 'A hill town buried in conifers, with cobbled forecourts, timber houses and a '
      + 'cold green river cutting the valley in two.',
    swatch: ['#2f5d3a', '#7d5a3c'],
    hour: 7.5,
    terrain: 'forestFloor',
    road: 'asphalt',
    lot: 'cobble',
    green: 'grass',
    species: 'pine',
    ringMix: ['shops', 'houses', 'houses'],
    outerMix: ['houses', 'park', 'park', 'houses', 'shops', 'houses'],
    centre: 'park',
    fixed: [
      [1, 1, 'market'], [1, 3, 'park'], [3, 1, 'police'], [3, 3, 'park'],
      [0, 2, 'park'], [2, 0, 'shops'], [2, 4, 'houses'], [3, 4, 'houses'],
      [4, 0, 'parking'],
    ],
    towerFloors: [2, 4],
    storeyChance: 0.6,
    wild: 0.95,
    south: 'grid',
    water: {
      z: CANAL_Z, width: 56, depth: 3.6, dry: false, bed: 'dirt',
      name: 'THE PINE RIVER',
      bridgeName: 'VALLEY BRIDGE',
      crossings: GRID_CROSSINGS,
    },
  },
  {
    id: 'metro',
    name: 'Karachi Metro',
    region: 'Karachi · Sindh',
    blurb: 'Nothing but glass and concrete. Towers on every block, eight lanes of traffic '
      + 'and a shipping channel running through the middle of downtown.',
    swatch: ['#5a6b80', '#1d2530'],
    hour: 19.5,
    terrain: 'concrete',
    road: 'asphalt',
    lot: 'concrete',
    green: 'grass',
    species: 'broadleaf',
    ringMix: ['tower', 'tower', 'tower'],
    outerMix: ['tower', 'tower', 'shops', 'parking', 'tower', 'plaza'],
    centre: 'plaza',
    fixed: [
      [1, 1, 'tower'], [1, 3, 'market'], [3, 1, 'police'], [3, 3, 'tower'],
      [0, 2, 'park'], [2, 0, 'shops'], [2, 4, 'tower'], [3, 4, 'houses'],
      [4, 0, 'parking'],
    ],
    towerFloors: [9, 26],
    storeyChance: 0.9,
    wild: 0.05,
    south: 'grid',
    water: {
      z: CANAL_Z, width: 56, depth: 4.0, dry: false, bed: 'dirt',
      name: 'THE SHIPPING CHANNEL',
      bridgeName: 'PORT QASIM BRIDGE',
      crossings: GRID_CROSSINGS,
    },
  },
];

export const DEFAULT_THEME = THEMES[0];

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? DEFAULT_THEME;
}

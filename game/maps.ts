import * as THREE from 'three';
import { buildCity } from './city';
import { City } from './layout';
import { Mats } from './materials';
import { Physics } from './physics';
import { QualityPreset } from './settings';
import { THEMES } from './theme';

/**
 * The map roster.
 *
 * The point of this file is what it does *not* do: it never builds anything up front. A
 * map is a description plus a builder you call later, so only the map you picked ever
 * has geometry, colliders, peds or traffic in memory. That is the whole reason the world
 * build moved out of Game.init() and into Game.startMap() — before, the one map was
 * generated during the loading screen whether you wanted it or not.
 *
 * All four maps share one generator (city.ts) driven by a Theme; see theme.ts for why.
 */

export interface GameMap {
  id: string;
  name: string;
  region: string;
  blurb: string;
  /** two hex colours for the picker card's gradient */
  swatch: [string, string];
  /** clock hour the map opens on */
  hour: number;
  /** what the southern half of the world is, for the card */
  south: string;
  water: string;
  bridge: string;
  build(scene: THREE.Scene, phys: Physics, mats: Mats, preset: QualityPreset, seed?: number): City;
}

export const MAPS: GameMap[] = THEMES.map((theme) => ({
  id: theme.id,
  name: theme.name,
  region: theme.region,
  blurb: theme.blurb,
  swatch: theme.swatch,
  hour: theme.hour,
  south: theme.south === 'scheme' ? 'Rahim Garden housing scheme' : 'a satellite town',
  water: theme.water.name,
  bridge: theme.water.bridgeName,
  build: (scene, phys, mats, preset, seed = 20260805) =>
    buildCity(scene, phys, mats, preset, seed, theme),
}));

export const DEFAULT_MAP_ID = MAPS[0].id;

export function mapById(id: string): GameMap {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}

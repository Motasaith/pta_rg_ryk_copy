import { WeaponId } from './weapons';
import { KillEvent } from './netclient';

export interface HudState {
  phase: 'loading' | 'title' | 'playing' | 'paused' | 'dead' | 'won';
  loadPct: number;
  loadMsg: string;
  health: number;
  armour: number;
  money: number;
  wanted: number;
  weapon: WeaponId;
  mag: number;
  reserve: number;
  reloading: boolean;
  inVehicle: boolean;
  vehicleName: string;
  vehicleClass: string;
  speed: number;
  /** 0..1 nitrous remaining */
  boost: number;
  boosting: boolean;
  prompt: string;
  toast: string;
  objective: string;
  found: number;
  total: number;
  clock: string;
  hour: number;
  fps: number;
  triangles: number;
  drawCalls: number;
  aiming: boolean;
  hitMarker: number;
  crosshairHot: boolean;
  busted: boolean;
  mapOpen: boolean;
  shopOpen: boolean;
  shopName: string;
  /** transient "CHEAT ACTIVATED" banner */
  cheatMessage: string | null;
  /** the cheat prompt is up: gameplay input is off and the mouse is free */
  cheatConsoleOpen: boolean;
  /** name of the map currently loaded, for the pause screen */
  mapName: string;
  /** 0..1 how far under water we are; the HUD tints and warns */
  drowning: number;
  /** '', 'DRIZZLE', 'HEAVY RAIN' or 'DUST HAZE' */
  weather: string;
  /** 0..1, decaying: the last lightning strike */
  lightning: number;
  /** the police have lost sight of you and the stars are ticking down */
  wantedFading: boolean;
  /** the search helicopter has you in its beam */
  spotted: boolean;
  /* side jobs */
  jobName: string;
  jobTimer: number;
  jobStreak: number;
  jobEarned: number;
  /* multiplayer */
  /** false when a downloaded asset failed to arrive and the game fell back to procedural */
  assetsOk: boolean;
  /** wire version, so two players can check they are on the same build */
  netVersion: number;
  netStatus: 'offline' | 'connecting' | 'online' | 'error';
  netRoom: string;
  /** The map the room settled on — not necessarily the one you picked. */
  netMap: string;
  netError: string;
  netPeers: number;
  netNames: string[];
  /** our side: 0 free-roam, 1 or 2 in a match */
  netTeam: number;
  /** true when this client owns the ambient traffic; shown so a laggy host is explicable */
  netHost: boolean;
  netMode: number;
  netMatch: number;
  netScoreA: number;
  netScoreB: number;
  netTarget: number;
  netRoster: { id: number; name: string; team: number; kills: number; deaths: number; you: boolean }[];
  netFeed: KillEvent[];
}

const initial: HudState = {
  phase: 'loading', loadPct: 0, loadMsg: 'starting up…',
  health: 100, armour: 0, money: 500, wanted: 0,
  weapon: 'fists', mag: 0, reserve: 0, reloading: false,
  inVehicle: false, vehicleName: '', vehicleClass: '', speed: 0, boost: 1, boosting: false,
  prompt: '', toast: '', objective: '', found: 0, total: 8,
  clock: '00:00', hour: 11, fps: 0, triangles: 0, drawCalls: 0,
  aiming: false, hitMarker: 0, crosshairHot: false, busted: false, mapOpen: false,
  shopOpen: false, shopName: '', cheatMessage: null, cheatConsoleOpen: false,
  mapName: '', drowning: 0, weather: '', lightning: 0,
  wantedFading: false, spotted: false,
  jobName: '', jobTimer: 0, jobStreak: 0, jobEarned: 0,
  assetsOk: true, netVersion: 0,
  netStatus: 'offline', netRoom: '', netMap: '', netError: '', netPeers: 0, netNames: [],
  netTeam: 0, netHost: false, netMode: 0, netMatch: 0,
  netScoreA: 0, netScoreB: 0, netTarget: 0, netRoster: [], netFeed: [],
};

let state: HudState = initial;
const subs = new Set<() => void>();

export function getHud(): HudState {
  return state;
}

export function subscribeHud(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** Shallow-diffs before notifying, so a 60Hz game loop does not re-render React 60 times. */
export function setHud(patch: Partial<HudState>): void {
  let changed = false;
  for (const k in patch) {
    const key = k as keyof HudState;
    if (state[key] !== patch[key]) { changed = true; break; }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

export function resetHud(): void {
  state = initial;
  for (const cb of subs) cb();
}

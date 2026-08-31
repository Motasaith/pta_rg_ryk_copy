/**
 * Wire protocol, shared verbatim by the browser client and the Cloudflare Worker.
 *
 * Binary, not JSON. A player's state is 14 bytes, so a full 8-player snapshot is under
 * 128 bytes — at 20 Hz that is about 2.4 KB/s down per client. The same state as JSON would
 * be roughly ten times that, and JSON.parse on every frame is real main-thread work.
 *
 * Positions are quantised to 2 cm in an int16, which covers ±655 m — comfortably more than
 * the world (x ±216, z −216…560). Yaw is an int16 over −π…π, giving ~0.01° steps.
 *
 * Every decoder is written to be hostile-input safe: a truncated or malformed frame returns
 * null rather than throwing, because these bytes arrive from the network.
 */

/**
 * Bumped to 3 when maps became selectable.
 *
 * A version 2 client has exactly one world and no idea another exists, so it would join
 * a room happily and then play a completely different city from everyone else — which is
 * indistinguishable from "the other player got a broken game". Rejecting it outright and
 * telling them to reload is the only honest outcome.
 */
export const PROTOCOL_VERSION = 3;

/** Free-roam room cap. Bandwidth is linear in this, so it is deliberately modest. */
export const MAX_PLAYERS = 8;

/** How often a client reports its own state. */
export const SEND_HZ = 20;

/**
 * How far in the past remote players are rendered. Interpolating between two snapshots we
 * already have looks smooth; extrapolating into the future looks like teleporting.
 */
export const INTERP_DELAY_MS = 110;

const POS_STEP = 0.02;
const POS_MIN = -655;
const POS_MAX = 655;
const YAW_SCALE = 32767 / Math.PI;

/* ── message ids ──────────────────────────────────────────────────────────── */
export const C_HELLO = 0x01;
export const C_STATE = 0x02;
/** "I shot player N." The victim decides what it costs them — see room.ts. */
export const C_HIT = 0x03;
/** "I died, and player N did it." Only ever sent by the victim. */
export const C_KILL = 0x04;
export const C_TEAM = 0x05;
export const C_MATCH = 0x06;
/** Ambient traffic, sent only by the client the server named host. */
export const C_TRAFFIC = 0x07;
/** "I am driving ambient car N" / "I have got out of it". */
export const C_CLAIM = 0x08;

export const S_WELCOME = 0x81;
export const S_SNAPSHOT = 0x82;
export const S_JOIN = 0x83;
export const S_LEAVE = 0x84;
export const S_REJECT = 0x85;
export const S_HIT = 0x86;
export const S_KILL = 0x87;
export const S_TEAM = 0x88;
export const S_MATCH = 0x89;
export const S_TRAFFIC = 0x8a;
export const S_HOST = 0x8b;
export const S_CLAIM = 0x8c;

/* ── state flags ──────────────────────────────────────────────────────────── */
export const F_SPRINT = 1 << 0;
export const F_AIMING = 1 << 1;
export const F_VEHICLE = 1 << 2;
export const F_DEAD = 1 << 3;
export const F_GROUNDED = 1 << 4;
export const F_FIRING = 1 << 5;
export const F_CROUCH = 1 << 6;

export const REJECT_FULL = 1;
export const REJECT_VERSION = 2;
export const REJECT_BANNED = 3;

/* ── teams ────────────────────────────────────────────────────────────────── */
/**
 * Team 0 means "no team". In free-roam everyone is team 0 and nobody can hurt anybody;
 * in a match everyone is 1 or 2 and only the other number is a valid target. Keeping
 * "no team" as a real value is what lets one room serve both modes.
 */
export const TEAM_NONE = 0;
export const TEAM_A = 1;
export const TEAM_B = 2;
export type TeamId = 0 | 1 | 2;

export const TEAM_NAMES = ['NEUTRAL', 'GREEN', 'ORANGE'] as const;
/** Nameplate / marker colours. Deliberately not red-vs-green — that is the common colour-blind pair. */
export const TEAM_COLOURS = [0x7df3ff, 0x53e07a, 0xffa63d] as const;

/* ── modes ────────────────────────────────────────────────────────────────── */
export const MODE_FREEROAM = 0;
export const MODE_TDM = 1;
export const MODE_NAMES = ['freeroam', 'tdm'] as const;

export const MATCH_LOBBY = 0;
export const MATCH_LIVE = 1;
export const MATCH_OVER = 2;

/** Kills needed to win a team deathmatch. */
export const TDM_TARGET = 25;

/* ── hit flags ────────────────────────────────────────────────────────────── */
export const HIT_HEAD = 1 << 0;
export const HIT_MELEE = 1 << 1;
export const HIT_VEHICLE = 1 << 2;

/* ── traffic ──────────────────────────────────────────────────────────────── */
/**
 * Ambient cars the host streams to everyone. Capped so a full traffic frame stays
 * around 600 bytes: at TRAFFIC_HZ that is ~5 KB/s down, the price of a shared world.
 */
export const MAX_SYNC_CARS = 48;
export const TRAFFIC_HZ = 10;
export const CAR_BYTES = 12;

export const TF_SIREN = 1 << 0;
export const TF_BRAKE = 1 << 1;
export const TF_PARKED = 1 << 2;

export interface PlayerState {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  flags: number;
  /** horizontal speed in m/s, quantised to 0.1 */
  speed: number;
  /** weapon index into WEAPON_ORDER */
  weapon: number;
  /** 0 = no team (free-roam), 1 = A, 2 = B */
  team: number;
  /** 0..100; drawn as a bar over a teammate and used to grey out a corpse */
  health: number;
  /** index into VEH_KINDS when F_VEHICLE is set, else ignored */
  vkind: number;
  /** index into CAR_COLOURS when F_VEHICLE is set, else ignored */
  vcolour: number;
}

/**
 * Kind order for the wire. Appending is safe; reordering is not, because an old client
 * would draw everyone the wrong car. Four bits, so there is room for six more.
 */
export const VEH_KINDS = [
  'sedan', 'hatch', 'suv', 'van', 'sports', 'police', 'rickshaw', 'muscle', 'hyper', 'truck',
] as const;

export interface CarState {
  id: number;
  kind: number;
  colour: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  flags: number;
}

export interface Peer {
  id: number;
  name: string;
  /** assigned by the server on join, so both sides always agree who is on which side */
  team: number;
}

/**
 * 14 bytes with the id. Team, health, vehicle kind and vehicle colour all fit in three
 * bytes because none of them needs eight bits: weapon and colour share one byte (4+4),
 * team and vehicle kind share another (2+4). That packing is why a full 8-player snapshot
 * is still 118 bytes after growing four fields.
 */
export const STATE_BYTES = 14;

const enc = new TextEncoder();
const dec = new TextDecoder();

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** NaN and Infinity must never reach the wire — they decode to garbage positions. */
function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function quantPos(v: number): number {
  return Math.round(clamp(finite(v), POS_MIN, POS_MAX) / POS_STEP);
}

function quantYaw(v: number): number {
  let a = finite(v);
  // wrap into −π…π before scaling, otherwise a drifting yaw overflows the int16
  a = ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return Math.round(a * YAW_SCALE);
}

function writeState(dv: DataView, o: number, s: PlayerState, withId: boolean): number {
  if (withId) dv.setUint8(o++, s.id & 0xff);
  dv.setInt16(o, quantPos(s.x), true); o += 2;
  dv.setInt16(o, quantPos(s.y), true); o += 2;
  dv.setInt16(o, quantPos(s.z), true); o += 2;
  dv.setInt16(o, quantYaw(s.yaw), true); o += 2;
  dv.setUint8(o++, s.flags & 0xff);
  dv.setUint8(o++, clamp(Math.round(finite(s.speed) * 10), 0, 255));
  // weapon (4 bits) + vehicle colour index (4 bits) — neither needs more
  dv.setUint8(o++, (s.weapon & 0x0f) | ((s.vcolour & 0x0f) << 4));
  // team (2 bits) + vehicle kind index (4 bits), 2 bits spare
  dv.setUint8(o++, (s.team & 0x03) | ((s.vkind & 0x0f) << 2));
  dv.setUint8(o++, clamp(Math.round(finite(s.health)), 0, 255));
  return o;
}

function readState(dv: DataView, o: number, id: number, withId: boolean): [PlayerState, number] {
  let pid = id;
  if (withId) pid = dv.getUint8(o++);
  const x = dv.getInt16(o, true) * POS_STEP; o += 2;
  const y = dv.getInt16(o, true) * POS_STEP; o += 2;
  const z = dv.getInt16(o, true) * POS_STEP; o += 2;
  const yaw = dv.getInt16(o, true) / YAW_SCALE; o += 2;
  const flags = dv.getUint8(o++);
  const speed = dv.getUint8(o++) / 10;
  const wv = dv.getUint8(o++);
  const tk = dv.getUint8(o++);
  const health = dv.getUint8(o++);
  return [{
    id: pid, x, y, z, yaw, flags, speed,
    weapon: wv & 0x0f,
    vcolour: (wv >> 4) & 0x0f,
    team: tk & 0x03,
    vkind: (tk >> 2) & 0x0f,
    health,
  }, o];
}

/**
 * Fill in the fields a caller did not supply. Every encoder runs its input through this,
 * so a partial state can never write undefined into a DataView (which silently becomes 0
 * for ints but NaN for floats) and older call sites keep working.
 */
type PartialState = Omit<PlayerState, 'id' | 'team' | 'health' | 'vkind' | 'vcolour'>
  & Partial<Pick<PlayerState, 'id' | 'team' | 'health' | 'vkind' | 'vcolour'>>;

function fill(s: PartialState): PlayerState {
  return {
    id: s.id ?? 0,
    x: s.x, y: s.y, z: s.z, yaw: s.yaw,
    flags: s.flags, speed: s.speed, weapon: s.weapon,
    team: s.team ?? TEAM_NONE,
    health: s.health ?? 100,
    vkind: s.vkind ?? 0,
    vcolour: s.vcolour ?? 0,
  };
}

/* ── client → server ──────────────────────────────────────────────────────── */

/** `map` is an index into the map roster; the first client to arrive sets the room's. */
export function encodeHello(name: string, map: number): ArrayBuffer {
  const bytes = enc.encode(name.slice(0, 24));
  const buf = new ArrayBuffer(4 + bytes.length);
  const dv = new DataView(buf);
  dv.setUint8(0, C_HELLO);
  dv.setUint8(1, PROTOCOL_VERSION);
  dv.setUint8(2, map & 0xff);
  dv.setUint8(3, bytes.length);
  new Uint8Array(buf, 4).set(bytes);
  return buf;
}

export function decodeHello(buf: ArrayBuffer): { version: number; map: number; name: string } | null {
  if (buf.byteLength < 4) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== C_HELLO) return null;
  const version = dv.getUint8(1);
  const map = dv.getUint8(2);
  const len = dv.getUint8(3);
  if (buf.byteLength < 4 + len) return null;
  return { version, map, name: dec.decode(new Uint8Array(buf, 4, len)) };
}

/** `seq` lets the server drop out-of-order frames without a full ack scheme. */
export function encodeState(seq: number, s: PartialState): ArrayBuffer {
  const buf = new ArrayBuffer(3 + STATE_BYTES - 1);
  const dv = new DataView(buf);
  dv.setUint8(0, C_STATE);
  dv.setUint16(1, seq & 0xffff, true);
  writeState(dv, 3, fill(s), false);
  return buf;
}

export function decodeState(buf: ArrayBuffer): { seq: number; state: PlayerState } | null {
  if (buf.byteLength < 3 + STATE_BYTES - 1) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== C_STATE) return null;
  const seq = dv.getUint16(1, true);
  const [state] = readState(dv, 3, 0, false);
  return { seq, state };
}

/* ── server → client ──────────────────────────────────────────────────────── */

export interface Welcome {
  version: number;
  yourId: number;
  yourTeam: number;
  /** id of the client the server has made traffic host; 0 while nobody holds it */
  hostId: number;
  /** the map this room is playing, as an index into the roster. Not negotiable. */
  map: number;
  peers: Peer[];
}

export function encodeWelcome(
  yourId: number, yourTeam: number, hostId: number, map: number, peers: Peer[],
): ArrayBuffer {
  const names = peers.map((p) => enc.encode(p.name.slice(0, 24)));
  let size = 7;
  for (const n of names) size += 3 + n.length;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint8(0, S_WELCOME);
  dv.setUint8(1, PROTOCOL_VERSION);
  dv.setUint8(2, yourId);
  dv.setUint8(3, yourTeam & 0x03);
  dv.setUint8(4, hostId & 0xff);
  dv.setUint8(5, map & 0xff);
  dv.setUint8(6, peers.length);
  let o = 7;
  for (let i = 0; i < peers.length; i++) {
    dv.setUint8(o++, peers[i].id);
    dv.setUint8(o++, peers[i].team & 0x03);
    dv.setUint8(o++, names[i].length);
    u8.set(names[i], o);
    o += names[i].length;
  }
  return buf;
}

export function decodeWelcome(buf: ArrayBuffer): Welcome | null {
  if (buf.byteLength < 7) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== S_WELCOME) return null;
  const version = dv.getUint8(1);
  const yourId = dv.getUint8(2);
  const yourTeam = dv.getUint8(3) & 0x03;
  const hostId = dv.getUint8(4);
  const map = dv.getUint8(5);
  const count = dv.getUint8(6);
  const peers: Peer[] = [];
  let o = 7;
  for (let i = 0; i < count; i++) {
    if (o + 3 > buf.byteLength) return null;
    const id = dv.getUint8(o++);
    const team = dv.getUint8(o++) & 0x03;
    const len = dv.getUint8(o++);
    if (o + len > buf.byteLength) return null;
    peers.push({ id, team, name: dec.decode(new Uint8Array(buf, o, len)) });
    o += len;
  }
  return { version, yourId, yourTeam, hostId, map, peers };
}

export function encodeSnapshot(tick: number, states: PartialState[]): ArrayBuffer {
  const n = Math.min(states.length, MAX_PLAYERS);
  const buf = new ArrayBuffer(6 + n * STATE_BYTES);
  const dv = new DataView(buf);
  dv.setUint8(0, S_SNAPSHOT);
  dv.setUint32(1, tick >>> 0, true);
  dv.setUint8(5, n);
  let o = 6;
  for (let i = 0; i < n; i++) o = writeState(dv, o, fill(states[i]), true);
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): { tick: number; states: PlayerState[] } | null {
  if (buf.byteLength < 6) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== S_SNAPSHOT) return null;
  const tick = dv.getUint32(1, true);
  const n = dv.getUint8(5);
  if (buf.byteLength < 6 + n * STATE_BYTES) return null;
  const states: PlayerState[] = [];
  let o = 6;
  for (let i = 0; i < n; i++) {
    const [s, next] = readState(dv, o, 0, true);
    states.push(s);
    o = next;
  }
  return { tick, states };
}

export function encodeJoin(p: Peer): ArrayBuffer {
  const bytes = enc.encode(p.name.slice(0, 24));
  const buf = new ArrayBuffer(4 + bytes.length);
  const dv = new DataView(buf);
  dv.setUint8(0, S_JOIN);
  dv.setUint8(1, p.id);
  dv.setUint8(2, p.team & 0x03);
  dv.setUint8(3, bytes.length);
  new Uint8Array(buf, 4).set(bytes);
  return buf;
}

export function decodeJoin(buf: ArrayBuffer): Peer | null {
  if (buf.byteLength < 4) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== S_JOIN) return null;
  const id = dv.getUint8(1);
  const team = dv.getUint8(2) & 0x03;
  const len = dv.getUint8(3);
  if (buf.byteLength < 4 + len) return null;
  return { id, team, name: dec.decode(new Uint8Array(buf, 4, len)) };
}

export function encodeLeave(id: number): ArrayBuffer {
  const buf = new ArrayBuffer(2);
  const dv = new DataView(buf);
  dv.setUint8(0, S_LEAVE);
  dv.setUint8(1, id);
  return buf;
}

export function decodeLeave(buf: ArrayBuffer): number | null {
  if (buf.byteLength < 2) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== S_LEAVE) return null;
  return dv.getUint8(1);
}

export function encodeReject(reason: number): ArrayBuffer {
  const buf = new ArrayBuffer(2);
  const dv = new DataView(buf);
  dv.setUint8(0, S_REJECT);
  dv.setUint8(1, reason);
  return buf;
}

export function decodeReject(buf: ArrayBuffer): number | null {
  if (buf.byteLength < 2) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== S_REJECT) return null;
  return dv.getUint8(1);
}

/* -- combat --------------------------------------------------------------- */

/**
 * A hit is reported by the *shooter* and applied by the *victim*.
 *
 * The alternative - the shooter also deciding the victim's health - needs both clients to
 * agree on a value they each mutate, and they never do: two shooters firing at once each
 * subtract from their own stale copy and the victim dies twice. Letting exactly one machine
 * own a player's health removes that whole class of bug, at the cost of trusting the victim
 * not to ignore damage. For a friends-and-a-room-code game that is the right side of the
 * trade, and it is the same trust we already extend on position.
 */
export interface Hit {
  /** filled in by the server from the socket, so it cannot be spoofed */
  shooter: number;
  target: number;
  /** 0..255 */
  damage: number;
  flags: number;
}

export function encodeHit(target: number, damage: number, flags: number): ArrayBuffer {
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  dv.setUint8(0, C_HIT);
  dv.setUint8(1, target & 0xff);
  dv.setUint8(2, clamp(Math.round(finite(damage)), 0, 255));
  dv.setUint8(3, flags & 0xff);
  return buf;
}

export function decodeHit(buf: ArrayBuffer): Omit<Hit, 'shooter'> | null {
  if (buf.byteLength < 4) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== C_HIT) return null;
  return { target: dv.getUint8(1), damage: dv.getUint8(2), flags: dv.getUint8(3) };
}

export function encodeHitOut(h: Hit): ArrayBuffer {
  const buf = new ArrayBuffer(5);
  const dv = new DataView(buf);
  dv.setUint8(0, S_HIT);
  dv.setUint8(1, h.shooter & 0xff);
  dv.setUint8(2, h.target & 0xff);
  dv.setUint8(3, h.damage & 0xff);
  dv.setUint8(4, h.flags & 0xff);
  return buf;
}

export function decodeHitOut(buf: ArrayBuffer): Hit | null {
  if (buf.byteLength < 5) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== S_HIT) return null;
  return {
    shooter: dv.getUint8(1), target: dv.getUint8(2),
    damage: dv.getUint8(3), flags: dv.getUint8(4),
  };
}

/** Victim to server. The victim is known from the socket, so only the killer travels. */
export function encodeKill(killer: number, flags: number): ArrayBuffer {
  const buf = new ArrayBuffer(3);
  const dv = new DataView(buf);
  dv.setUint8(0, C_KILL);
  dv.setUint8(1, killer & 0xff);
  dv.setUint8(2, flags & 0xff);
  return buf;
}

export function decodeKill(buf: ArrayBuffer): { killer: number; flags: number } | null {
  if (buf.byteLength < 3) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== C_KILL) return null;
  return { killer: dv.getUint8(1), flags: dv.getUint8(2) };
}

export function encodeKillOut(killer: number, victim: number, flags: number): ArrayBuffer {
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  dv.setUint8(0, S_KILL);
  dv.setUint8(1, killer & 0xff);
  dv.setUint8(2, victim & 0xff);
  dv.setUint8(3, flags & 0xff);
  return buf;
}

export function decodeKillOut(buf: ArrayBuffer): { killer: number; victim: number; flags: number } | null {
  if (buf.byteLength < 4) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== S_KILL) return null;
  return { killer: dv.getUint8(1), victim: dv.getUint8(2), flags: dv.getUint8(3) };
}

/* -- teams and match state ------------------------------------------------- */

/** Client asks to switch sides; the server may refuse and answer with the team it kept. */
export function encodeTeam(team: number): ArrayBuffer {
  const buf = new ArrayBuffer(2);
  const dv = new DataView(buf);
  dv.setUint8(0, C_TEAM);
  dv.setUint8(1, team & 0x03);
  return buf;
}

export function decodeTeam(buf: ArrayBuffer): number | null {
  if (buf.byteLength < 2) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== C_TEAM) return null;
  return dv.getUint8(1) & 0x03;
}

export function encodeTeamOut(id: number, team: number): ArrayBuffer {
  const buf = new ArrayBuffer(3);
  const dv = new DataView(buf);
  dv.setUint8(0, S_TEAM);
  dv.setUint8(1, id & 0xff);
  dv.setUint8(2, team & 0x03);
  return buf;
}

export function decodeTeamOut(buf: ArrayBuffer): { id: number; team: number } | null {
  if (buf.byteLength < 3) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== S_TEAM) return null;
  return { id: dv.getUint8(1), team: dv.getUint8(2) & 0x03 };
}

export const MATCH_START = 1;
export const MATCH_RESET = 2;

/** Host-only request. A non-host sending this is ignored, not disconnected. */
export function encodeMatch(action: number, mode: number): ArrayBuffer {
  const buf = new ArrayBuffer(3);
  const dv = new DataView(buf);
  dv.setUint8(0, C_MATCH);
  dv.setUint8(1, action & 0xff);
  dv.setUint8(2, mode & 0xff);
  return buf;
}

export function decodeMatch(buf: ArrayBuffer): { action: number; mode: number } | null {
  if (buf.byteLength < 3) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== C_MATCH) return null;
  return { action: dv.getUint8(1), mode: dv.getUint8(2) };
}

export interface MatchState {
  mode: number;
  state: number;
  scoreA: number;
  scoreB: number;
  target: number;
}

export function encodeMatchOut(m: MatchState): ArrayBuffer {
  const buf = new ArrayBuffer(9);
  const dv = new DataView(buf);
  dv.setUint8(0, S_MATCH);
  dv.setUint8(1, m.mode & 0xff);
  dv.setUint8(2, m.state & 0xff);
  dv.setUint16(3, clamp(Math.round(finite(m.scoreA)), 0, 65535), true);
  dv.setUint16(5, clamp(Math.round(finite(m.scoreB)), 0, 65535), true);
  dv.setUint16(7, clamp(Math.round(finite(m.target)), 0, 65535), true);
  return buf;
}

export function decodeMatchOut(buf: ArrayBuffer): MatchState | null {
  if (buf.byteLength < 9) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== S_MATCH) return null;
  return {
    mode: dv.getUint8(1),
    state: dv.getUint8(2),
    scoreA: dv.getUint16(3, true),
    scoreB: dv.getUint16(5, true),
    target: dv.getUint16(7, true),
  };
}

export function encodeHost(id: number): ArrayBuffer {
  const buf = new ArrayBuffer(2);
  const dv = new DataView(buf);
  dv.setUint8(0, S_HOST);
  dv.setUint8(1, id & 0xff);
  return buf;
}

export function decodeHost(buf: ArrayBuffer): number | null {
  if (buf.byteLength < 2) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== S_HOST) return null;
  return dv.getUint8(1);
}

/* -- ambient traffic ------------------------------------------------------- */

/**
 * One client owns the ambient cars and broadcasts them. It has to be one machine: the
 * traffic AI is a chaotic simulation, so two clients running it from the same seed diverge
 * within a second of the first collision. Sending positions is the only way everyone sees
 * the same street.
 */
function writeCar(dv: DataView, o: number, c: CarState): number {
  dv.setUint16(o, c.id & 0xffff, true); o += 2;
  dv.setUint8(o++, (c.kind & 0x0f) | ((c.colour & 0x0f) << 4));
  dv.setInt16(o, quantPos(c.x), true); o += 2;
  dv.setInt16(o, quantPos(c.y), true); o += 2;
  dv.setInt16(o, quantPos(c.z), true); o += 2;
  dv.setInt16(o, quantYaw(c.yaw), true); o += 2;
  dv.setUint8(o++, c.flags & 0xff);
  return o;
}

function readCar(dv: DataView, o: number): [CarState, number] {
  const id = dv.getUint16(o, true); o += 2;
  const kc = dv.getUint8(o++);
  const x = dv.getInt16(o, true) * POS_STEP; o += 2;
  const y = dv.getInt16(o, true) * POS_STEP; o += 2;
  const z = dv.getInt16(o, true) * POS_STEP; o += 2;
  const yaw = dv.getInt16(o, true) / YAW_SCALE; o += 2;
  const flags = dv.getUint8(o++);
  return [{ id, kind: kc & 0x0f, colour: (kc >> 4) & 0x0f, x, y, z, yaw, flags }, o];
}

function encodeCars(msgId: number, cars: CarState[]): ArrayBuffer {
  const n = Math.min(cars.length, MAX_SYNC_CARS);
  const buf = new ArrayBuffer(2 + n * CAR_BYTES);
  const dv = new DataView(buf);
  dv.setUint8(0, msgId);
  dv.setUint8(1, n);
  let o = 2;
  for (let i = 0; i < n; i++) o = writeCar(dv, o, cars[i]);
  return buf;
}

function decodeCars(msgId: number, buf: ArrayBuffer): CarState[] | null {
  if (buf.byteLength < 2) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== msgId) return null;
  const n = dv.getUint8(1);
  if (n > MAX_SYNC_CARS) return null;
  if (buf.byteLength < 2 + n * CAR_BYTES) return null;
  const out: CarState[] = [];
  let o = 2;
  for (let i = 0; i < n; i++) {
    const [c, next] = readCar(dv, o);
    out.push(c);
    o = next;
  }
  return out;
}

/**
 * Car ownership.
 *
 * Without this, driving a taxi out of traffic shows every other player two of it: the one
 * you are steering (drawn from your player state) and the one the host is still simulating
 * in the lane you left. So entering an ambient car claims it — the host stops simulating
 * and sending it, everyone else drops it — and getting out releases it back.
 */
export function encodeClaim(car: number, taken: boolean): ArrayBuffer {
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  dv.setUint8(0, C_CLAIM);
  dv.setUint16(1, car & 0xffff, true);
  dv.setUint8(3, taken ? 1 : 0);
  return buf;
}

export function decodeClaim(buf: ArrayBuffer): { car: number; taken: boolean } | null {
  if (buf.byteLength < 4) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== C_CLAIM) return null;
  return { car: dv.getUint16(1, true), taken: dv.getUint8(3) === 1 };
}

export function encodeClaimOut(by: number, car: number, taken: boolean): ArrayBuffer {
  const buf = new ArrayBuffer(5);
  const dv = new DataView(buf);
  dv.setUint8(0, S_CLAIM);
  dv.setUint8(1, by & 0xff);
  dv.setUint16(2, car & 0xffff, true);
  dv.setUint8(4, taken ? 1 : 0);
  return buf;
}

export function decodeClaimOut(buf: ArrayBuffer): { by: number; car: number; taken: boolean } | null {
  if (buf.byteLength < 5) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== S_CLAIM) return null;
  return { by: dv.getUint8(1), car: dv.getUint16(2, true), taken: dv.getUint8(4) === 1 };
}

export function encodeTraffic(cars: CarState[]): ArrayBuffer {
  return encodeCars(C_TRAFFIC, cars);
}

export function decodeTraffic(buf: ArrayBuffer): CarState[] | null {
  return decodeCars(C_TRAFFIC, buf);
}

export function encodeTrafficOut(cars: CarState[]): ArrayBuffer {
  return encodeCars(S_TRAFFIC, cars);
}

export function decodeTrafficOut(buf: ArrayBuffer): CarState[] | null {
  return decodeCars(S_TRAFFIC, buf);
}

/** First byte of any frame, or −1 if it is not even one byte long. */
export function messageId(buf: ArrayBuffer): number {
  return buf.byteLength ? new DataView(buf).getUint8(0) : -1;
}

/** Room codes are typed by humans, so avoid 0/O and 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

/** Normalise whatever the user typed; returns '' if it cannot be a room code. */
export function normaliseRoomCode(input: string): string {
  const up = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (up.length !== 5) return '';
  for (const ch of up) if (!CODE_ALPHABET.includes(ch)) return '';
  return up;
}

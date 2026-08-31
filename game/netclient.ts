import {
  CarState, Hit, INTERP_DELAY_MS, MATCH_LIVE, MATCH_LOBBY, MATCH_START, MATCH_RESET, MatchState,
  MAX_PLAYERS, MODE_FREEROAM, Peer, PlayerState, REJECT_FULL, REJECT_VERSION, SEND_HZ,
  TDM_TARGET, TEAM_NONE, TRAFFIC_HZ,
  S_CLAIM, S_HIT, S_HOST, S_JOIN, S_KILL, S_LEAVE, S_MATCH, S_REJECT, S_SNAPSHOT, S_TEAM,
  S_TRAFFIC,
  S_WELCOME,
  decodeClaimOut, decodeHitOut, decodeHost, decodeJoin, decodeKillOut, decodeLeave,
  decodeMatchOut,
  decodeReject, decodeSnapshot, decodeTeamOut, decodeTrafficOut, decodeWelcome,
  encodeClaim, encodeHello, encodeHit, encodeKill, encodeMatch, encodeState, encodeTeam,
  encodeTraffic,
  messageId,
} from './protocol';
import { wrapPi } from './mathx';

export type NetStatus = 'offline' | 'connecting' | 'online' | 'error';

interface Sample {
  /** local arrival time — the only honest clock we share with the server */
  t: number;
  s: PlayerState;
}

/**
 * Playback buffer for one remote player.
 *
 * Remote players are rendered ~110 ms in the past, between two snapshots we already hold.
 * Interpolating known samples looks smooth; extrapolating past the newest one produces the
 * rubber-banding and mispredicted corners that make netcode feel bad. So when we run out of
 * future we hold the last known pose instead of guessing.
 */
export class InterpBuffer {
  private samples: Sample[] = [];

  push(s: PlayerState, now: number): void {
    // out-of-order arrival: drop anything older than what we already have
    const last = this.samples[this.samples.length - 1];
    if (last && now < last.t) return;
    this.samples.push({ t: now, s });
    // keep a second of history, no more
    while (this.samples.length > 2 && now - this.samples[0].t > 1000) this.samples.shift();
    if (this.samples.length > 40) this.samples.shift();
  }

  get length(): number {
    return this.samples.length;
  }

  /** Newest sample, ignoring the interpolation delay. */
  latest(): PlayerState | null {
    const s = this.samples[this.samples.length - 1];
    return s ? s.s : null;
  }

  /** Interpolated pose for `now`, or null if we have never heard from this player. */
  sample(now: number): PlayerState | null {
    if (!this.samples.length) return null;
    const target = now - INTERP_DELAY_MS;

    // before our history: hold the oldest pose
    if (target <= this.samples[0].t) return this.samples[0].s;

    for (let i = this.samples.length - 1; i > 0; i--) {
      const b = this.samples[i], a = this.samples[i - 1];
      if (target >= a.t && target <= b.t) {
        const span = b.t - a.t;
        const k = span > 0.001 ? (target - a.t) / span : 1;
        return lerpState(a.s, b.s, k);
      }
    }
    // past the newest: freeze rather than extrapolate
    return this.samples[this.samples.length - 1].s;
  }
}

function lerpState(a: PlayerState, b: PlayerState, k: number): PlayerState {
  return {
    id: b.id,
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
    // shortest way round, or a player turning past π spins the wrong way
    yaw: a.yaw + wrapPi(b.yaw - a.yaw) * k,
    flags: k < 0.5 ? a.flags : b.flags,
    speed: a.speed + (b.speed - a.speed) * k,
    // Discrete fields snap rather than blend — half a weapon is not a weapon, and a car
    // that fades between two colours mid-corner looks like a bug, not like smoothing.
    weapon: k < 0.5 ? a.weapon : b.weapon,
    team: k < 0.5 ? a.team : b.team,
    health: a.health + (b.health - a.health) * k,
    vkind: k < 0.5 ? a.vkind : b.vkind,
    vcolour: k < 0.5 ? a.vcolour : b.vcolour,
  };
}

/**
 * Playback buffer for the ambient traffic the host broadcasts.
 *
 * Same idea as InterpBuffer but keyed by car id, because a car can appear or vanish
 * between frames (the host recycles cars that drive out of the world) and a per-car buffer
 * would leak one entry per recycle. Cars missing from the newest frame are simply dropped.
 */
export class TrafficBuffer {
  private frames: { t: number; cars: Map<number, CarState> }[] = [];

  push(cars: CarState[], now: number): void {
    const last = this.frames[this.frames.length - 1];
    if (last && now < last.t) return;
    const map = new Map<number, CarState>();
    for (const c of cars) map.set(c.id, c);
    this.frames.push({ t: now, cars: map });
    while (this.frames.length > 2 && now - this.frames[0].t > 1000) this.frames.shift();
    if (this.frames.length > 20) this.frames.shift();
  }

  get length(): number {
    return this.frames.length;
  }

  /** Interpolated car set for `now`, rendered at the same delay as players. */
  sample(now: number): CarState[] {
    if (!this.frames.length) return [];
    const target = now - INTERP_DELAY_MS;
    if (target <= this.frames[0].t) return [...this.frames[0].cars.values()];

    for (let i = this.frames.length - 1; i > 0; i--) {
      const b = this.frames[i], a = this.frames[i - 1];
      if (target >= a.t && target <= b.t) {
        const span = b.t - a.t;
        const k = span > 0.001 ? (target - a.t) / span : 1;
        const out: CarState[] = [];
        // Iterate the newer frame: a car that has gone should stop being drawn at once.
        for (const [id, nb] of b.cars) {
          const na = a.cars.get(id);
          out.push(na ? lerpCar(na, nb, k) : nb);
        }
        return out;
      }
    }
    return [...this.frames[this.frames.length - 1].cars.values()];
  }

  clear(): void {
    this.frames.length = 0;
  }
}

function lerpCar(a: CarState, b: CarState, k: number): CarState {
  return {
    id: b.id,
    kind: b.kind,
    colour: b.colour,
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
    yaw: a.yaw + wrapPi(b.yaw - a.yaw) * k,
    flags: k < 0.5 ? a.flags : b.flags,
  };
}

export interface RemotePeer {
  id: number;
  name: string;
  /** 0 in free-roam, else 1 or 2. Server-assigned; a client never states its own. */
  team: number;
  /** kills, tallied locally from the broadcast kill feed */
  kills: number;
  deaths: number;
  buf: InterpBuffer;
}

/** One line of the kill feed. */
export interface KillEvent {
  killer: string;
  killerTeam: number;
  victim: string;
  victimTeam: number;
  flags: number;
  /** local ms, so the HUD can fade it out */
  at: number;
}

export interface ConnectOpts {
  /** advertise the room in the public list so strangers can join */
  isPublic?: boolean;
  mode?: string;
  /** which map we would like to play, as a roster index. Only the first client's counts. */
  map?: number;
  /** override the server origin (tests) */
  origin?: string;
}

export interface OpenRoom {
  code: string;
  mode: string;
  players: number;
  max: number;
}

/**
 * Public rooms with space. Returns [] rather than throwing when the lobby is unreachable —
 * a missing room list must never stop someone playing with a code they already have.
 */
export async function fetchOpenRooms(origin?: string): Promise<OpenRoom[]> {
  const base = origin ?? (typeof location !== 'undefined' ? location.origin : '');
  try {
    const res = await fetch(`${base}/api/lobby/rooms`);
    if (!res.ok) return [];
    const body = await res.json() as { rooms?: OpenRoom[] };
    return Array.isArray(body.rooms) ? body.rooms : [];
  } catch {
    return [];
  }
}

/**
 * WebSocket client. Owns the connection, the peer list and each peer's playback buffer.
 * Knows nothing about three.js — rendering remote players is remoteplayers.ts's job.
 */
export class NetClient {
  status: NetStatus = 'offline';
  roomCode = '';
  /** The map this room is playing, as a roster index. Valid from Welcome onwards. */
  roomMap = 0;
  /** What we asked for. Ignored by the server unless we were first through the door. */
  private wantMap = 0;
  myId = 0;
  error = '';
  peers = new Map<number, RemotePeer>();

  /** Server-assigned. 0 in free-roam; 1 or 2 once a match starts. */
  myTeam = TEAM_NONE;
  myKills = 0;
  myDeaths = 0;
  /** Whoever the server named traffic host. When it is us, we broadcast the ambient cars. */
  hostId = 0;
  match: MatchState = {
    mode: MODE_FREEROAM, state: MATCH_LOBBY, scoreA: 0, scoreB: 0, target: TDM_TARGET,
  };
  traffic = new TrafficBuffer();
  /** Most recent kill feed lines, newest last. Trimmed to five — it is a HUD, not a log. */
  feed: KillEvent[] = [];

  onChange: (() => void) | null = null;
  /** Someone shot us. The engine applies it, because we own our own health. */
  onHit: ((h: Hit) => void) | null = null;
  /** A player took or gave back an ambient car; the engine tells Traffic to stop drawing it. */
  onClaim: ((car: number, taken: boolean) => void) | null = null;
  /** Anyone died, us included. Fired after the feed and tallies are updated. */
  onKill: ((e: KillEvent, killerId: number, victimId: number) => void) | null = null;
  /** Match state changed — start, score, or a side winning. */
  onMatch: ((m: MatchState, prev: MatchState) => void) | null = null;

  private ws: WebSocket | null = null;
  private seq = 1;
  private lastSend = 0;
  private lastPing = 0;
  private lastTraffic = 0;
  private name = 'Player';

  get online(): boolean {
    return this.status === 'online';
  }

  get peerCount(): number {
    return this.peers.size;
  }

  /** True when this client owns the ambient traffic everyone else is watching. */
  get isHost(): boolean {
    return this.online && this.myId !== 0 && this.myId === this.hostId;
  }

  /** True when shooting another player does anything at all. */
  get pvp(): boolean {
    return this.online && this.match.state === MATCH_LIVE && this.myTeam !== TEAM_NONE;
  }

  /** Everyone in the room including us, for the scoreboard. */
  roster(): { id: number; name: string; team: number; kills: number; deaths: number; you: boolean }[] {
    const out = [{
      id: this.myId, name: this.name, team: this.myTeam,
      kills: this.myKills, deaths: this.myDeaths, you: true,
    }];
    for (const p of this.peers.values()) {
      out.push({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, you: false });
    }
    return out.sort((a, b) => (a.team - b.team) || (b.kills - a.kills) || (a.id - b.id));
  }

  nameOf(id: number): string {
    if (id === this.myId) return this.name;
    return this.peers.get(id)?.name ?? '';
  }

  teamOf(id: number): number {
    if (id === this.myId) return this.myTeam;
    return this.peers.get(id)?.team ?? TEAM_NONE;
  }

  connect(code: string, name: string, opts: ConnectOpts = {}): void {
    this.disconnect();
    this.roomCode = code;
    this.name = name;
    this.wantMap = opts.map ?? 0;
    this.status = 'connecting';
    this.error = '';
    this.notify();

    const base = opts.origin ?? (typeof location !== 'undefined' ? location.origin : '');
    const q = `?mode=${encodeURIComponent(opts.mode ?? 'freeroam')}${opts.isPublic ? '&public=1' : ''}`;
    const url = base.replace(/^http/, 'ws') + `/api/room/${encodeURIComponent(code)}/ws` + q;

    try {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => ws.send(encodeHello(this.name, this.wantMap));
      ws.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as ArrayBuffer);
      ws.onerror = () => this.fail('connection failed');
      ws.onclose = (ev: CloseEvent) => {
        if (this.status !== 'error') {
          this.status = 'offline';
          this.error = ev.code === 1013 ? 'room is full' : '';
          this.reset();
          this.notify();
        }
      };
    } catch {
      this.fail('could not open a connection');
    }
  }

  disconnect(): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch { /* already closed */ }
    }
    this.status = 'offline';
    this.reset();
    this.notify();
  }

  /** Called every frame; throttles itself to SEND_HZ. */
  sendState(now: number, s: Omit<PlayerState, 'id'>): void {
    if (!this.online || !this.ws) return;
    if (now - this.lastSend < 1000 / SEND_HZ) return;
    this.lastSend = now;
    try {
      this.ws.send(encodeState(this.seq++, s));
    } catch { /* closing */ }

    // The room auto-replies to this without waking the Durable Object, so it is a free
    // keepalive through proxies that would otherwise drop an idle socket.
    if (now - this.lastPing > 8000) {
      this.lastPing = now;
      try {
        this.ws.send('ping');
      } catch { /* closing */ }
    }
  }

  /**
   * Ambient traffic, throttled to TRAFFIC_HZ. Silently does nothing unless we are host,
   * so the caller can invoke it every frame without checking first.
   */
  sendTraffic(now: number, cars: CarState[]): void {
    if (!this.isHost || !this.ws) return;
    if (now - this.lastTraffic < 1000 / TRAFFIC_HZ) return;
    this.lastTraffic = now;
    this.send(encodeTraffic(cars));
  }

  /** "I shot player `target`." The server forwards it; the victim decides what it costs. */
  sendHit(target: number, damage: number, flags: number): void {
    if (!this.pvp || target === this.myId) return;
    this.send(encodeHit(target, damage, flags));
  }

  /** "I died." Only ever sent about ourselves — that is what makes the tally exact. */
  sendKill(killer: number, flags: number): void {
    if (!this.online) return;
    this.send(encodeKill(killer, flags));
  }

  /** "I am driving ambient car N" — or, with taken=false, "I have got out of it". */
  sendClaim(car: number, taken: boolean): void {
    if (!this.online || !car) return;
    this.send(encodeClaim(car, taken));
  }

  /** Ask to switch sides. The server answers with the team it actually kept. */
  sendTeam(team: number): void {
    if (!this.online) return;
    this.send(encodeTeam(team));
  }

  /** Start or end a match. Ignored by the server unless we are host. */
  sendMatch(action: number, mode: number): void {
    if (!this.online) return;
    this.send(encodeMatch(action, mode));
  }

  startMatch(mode: number): void {
    this.sendMatch(MATCH_START, mode);
  }

  endMatch(): void {
    this.sendMatch(MATCH_RESET, MODE_FREEROAM);
  }

  private send(buf: ArrayBuffer): void {
    try {
      this.ws?.send(buf);
    } catch { /* closing */ }
  }

  private onMessage(buf: ArrayBuffer): void {
    if (typeof buf === 'string' || !(buf instanceof ArrayBuffer)) return;   // 'pong'
    const now = Date.now();
    switch (messageId(buf)) {
      case S_WELCOME: {
        const w = decodeWelcome(buf);
        if (!w) return;
        this.myId = w.yourId;
        this.myTeam = w.yourTeam;
        this.hostId = w.hostId;
        // The room's map is whatever the first person in chose. It is not a negotiation:
        // two clients in different cities is not a game, it is two games.
        this.roomMap = w.map;
        this.peers.clear();
        for (const p of w.peers) this.addPeer(p);
        this.status = 'online';
        this.notify();
        return;
      }
      case S_HOST: {
        const id = decodeHost(buf);
        if (id === null || id === this.hostId) return;
        this.hostId = id;
        // Whoever held the cars before is gone; drop their stale frames rather than
        // interpolating from them towards whatever the new host sends first.
        if (this.isHost) this.traffic.clear();
        this.notify();
        return;
      }
      case S_TEAM: {
        const t = decodeTeamOut(buf);
        if (!t) return;
        if (t.id === this.myId) this.myTeam = t.team;
        else {
          const peer = this.peers.get(t.id);
          if (peer) peer.team = t.team;
        }
        this.notify();
        return;
      }
      case S_MATCH: {
        const m = decodeMatchOut(buf);
        if (!m) return;
        const prev = this.match;
        this.match = m;
        // A fresh match zeroes the tallies; carrying last round's kills into the new
        // scoreboard is the kind of thing nobody reports but everybody notices.
        if (m.state === MATCH_LIVE && prev.state !== MATCH_LIVE) this.resetScores();
        this.onMatch?.(m, prev);
        this.notify();
        return;
      }
      case S_HIT: {
        const h = decodeHitOut(buf);
        if (!h || h.target !== this.myId) return;
        this.onHit?.(h);
        return;
      }
      case S_KILL: {
        const k = decodeKillOut(buf);
        if (!k) return;
        this.tallyKill(k.killer, k.victim);
        const ev: KillEvent = {
          killer: this.nameOf(k.killer),
          killerTeam: this.teamOf(k.killer),
          victim: this.nameOf(k.victim),
          victimTeam: this.teamOf(k.victim),
          flags: k.flags,
          at: now,
        };
        this.feed.push(ev);
        while (this.feed.length > 5) this.feed.shift();
        this.onKill?.(ev, k.killer, k.victim);
        this.notify();
        return;
      }
      case S_CLAIM: {
        const c = decodeClaimOut(buf);
        if (c) this.onClaim?.(c.car, c.taken);
        return;
      }
      case S_TRAFFIC: {
        // Our own cars are authoritative for us; the echo of a frame we sent would only
        // fight with them. The server does not send it back, but a host handover can race.
        if (this.isHost) return;
        const cars = decodeTrafficOut(buf);
        if (cars) this.traffic.push(cars, now);
        return;
      }
      case S_JOIN: {
        const p = decodeJoin(buf);
        if (p) {
          this.addPeer(p);
          this.notify();
        }
        return;
      }
      case S_LEAVE: {
        const id = decodeLeave(buf);
        if (id !== null && this.peers.delete(id)) this.notify();
        return;
      }
      case S_SNAPSHOT: {
        const snap = decodeSnapshot(buf);
        if (!snap) return;
        for (const s of snap.states) {
          if (s.id === this.myId) continue;                 // never rewind ourselves
          const peer = this.peers.get(s.id);
          // A state can arrive a frame before its JOIN; make a placeholder rather than drop it.
          if (peer) peer.buf.push(s, now);
          else if (this.peers.size < MAX_PLAYERS) {
            const fresh = this.addPeer({ id: s.id, name: `Player ${s.id}`, team: s.team });
            fresh.buf.push(s, now);
            this.notify();
          }
        }
        return;
      }
      case S_REJECT: {
        const r = decodeReject(buf);
        this.fail(
          r === REJECT_FULL ? 'room is full'
            : r === REJECT_VERSION ? 'this build is out of date — reload the page'
              : 'the server refused the connection',
        );
        return;
      }
      default:
        return;
    }
  }

  private addPeer(p: Peer): RemotePeer {
    const peer: RemotePeer = {
      id: p.id, name: p.name, team: p.team, kills: 0, deaths: 0, buf: new InterpBuffer(),
    };
    this.peers.set(p.id, peer);
    return peer;
  }

  private tallyKill(killer: number, victim: number): void {
    if (victim === this.myId) this.myDeaths++;
    else {
      const v = this.peers.get(victim);
      if (v) v.deaths++;
    }
    if (!killer || killer === victim) return;
    if (killer === this.myId) this.myKills++;
    else {
      const k = this.peers.get(killer);
      if (k) k.kills++;
    }
  }

  private resetScores(): void {
    this.myKills = 0;
    this.myDeaths = 0;
    this.feed.length = 0;
    for (const p of this.peers.values()) {
      p.kills = 0;
      p.deaths = 0;
    }
  }

  private fail(msg: string): void {
    this.status = 'error';
    this.error = msg;
    this.reset();
    this.notify();
  }

  private reset(): void {
    this.peers.clear();
    this.myId = 0;
    this.myTeam = TEAM_NONE;
    this.hostId = 0;
    this.seq = 1;
    this.traffic.clear();
    this.match = {
      mode: MODE_FREEROAM, state: MATCH_LOBBY, scoreA: 0, scoreB: 0, target: TDM_TARGET,
    };
    this.resetScores();
  }

  private notify(): void {
    this.onChange?.();
  }
}

import { DurableObject } from 'cloudflare:workers';
import {
  C_CLAIM, C_HELLO, C_HIT, C_KILL, C_MATCH, C_STATE, C_TEAM, C_TRAFFIC,
  MATCH_LIVE, MATCH_LOBBY, MATCH_OVER, MATCH_RESET, MATCH_START,
  MAX_PLAYERS, MODE_FREEROAM, MODE_TDM, Peer, PROTOCOL_VERSION, PlayerState,
  REJECT_FULL, REJECT_VERSION, TDM_TARGET, TEAM_A, TEAM_B, TEAM_NONE,
  decodeClaim, decodeHello, decodeHit, decodeKill, decodeMatch, decodeState, decodeTeam,
  decodeTraffic,
  encodeClaimOut, encodeHitOut, encodeHost, encodeJoin, encodeKillOut, encodeLeave,
  encodeMatchOut,
  encodeReject, encodeSnapshot, encodeTeamOut, encodeTrafficOut, encodeWelcome, messageId,
} from '../game/protocol';
import type { Env } from './env';

/**
 * One Durable Object per room. `env.ROOM.getByName(code)` always routes to the same
 * instance worldwide, which is exactly what "a game room" means.
 *
 * ── Why this is a relay and not a 20 Hz authoritative simulation ──
 *
 * Durable Objects are billed for wall-clock time spent *active*, and WebSocket hibernation
 * lets an object sleep while its sockets stay open. A setInterval game loop would pin the
 * object awake for the entire life of the room and throw that away.
 *
 * So we relay: a client reports its own state, we stamp it with the sender's id and fan it
 * out. The object wakes only to forward a frame, then sleeps. Latency is as low as it can
 * be, and an idle lobby costs nothing.
 *
 * ── What the server *does* decide ──
 *
 * Three things, because leaving any of them to a client produces disagreement rather than
 * cheating, and all three are event-driven so none of them costs a tick loop:
 *
 *   · **team assignment** — clients that pick their own side end up 5v1
 *   · **the score** — two clients counting kills independently drift apart immediately
 *   · **who is traffic host** — exactly one client may own the ambient cars
 *
 * Positions and damage stay client-reported. That is an honest trade for a game you enter
 * with a room code you sent to friends, and it is stated in docs/multiplayer.md.
 */

interface Attach {
  id: number;
  name: string;
  team: number;
}

/** Per-connection state that does not need to survive hibernation. */
interface Live {
  seq: number;
  msgs: number;
  windowStart: number;
}

/** Match state, persisted because hibernation may evict the instance mid-match. */
interface Match {
  mode: number;
  state: number;
  scoreA: number;
  scoreB: number;
  target: number;
}

const RATE_LIMIT_MSGS = 140;     // per second, per socket — 20 Hz state + 10 Hz traffic + slack
const NAME_MAX = 24;
/** How often we tell the lobby we are still alive. Must be under the lobby's stale cutoff. */
const HEARTBEAT_MS = 20_000;
/** A single shot can never legitimately take more than this. Caps a lying client's reach. */
const MAX_HIT_DAMAGE = 120;

export class GameRoom extends DurableObject<Env> {
  private live = new WeakMap<WebSocket, Live>();
  private tick = 0;
  private mode = 'freeroam';
  private isPublic = false;
  private hostId = 0;
  /**
   * Which map the room is playing, as a roster index.
   *
   * Set by the first person through the door and then fixed for the life of the room:
   * players in different cities are not in the same game, and letting a joiner pick
   * would silently split the room in two.
   */
  private map = -1;
  private match: Match = { mode: MODE_FREEROAM, state: MATCH_LOBBY, scoreA: 0, scoreB: 0, target: TDM_TARGET };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats are answered by the runtime without waking us up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // Sockets outlive the instance, so a match must be reloaded before we serve any frame.
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Match>('match');
      if (saved) this.match = saved;
      const host = await ctx.storage.get<number>('host');
      if (typeof host === 'number') this.hostId = host;
      const map = await ctx.storage.get<number>('map');
      if (typeof map === 'number') this.map = map;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    // The first connection settles the room's advertised mode and visibility.
    const url = new URL(request.url);
    if (this.ctx.getWebSockets().length === 0) {
      this.mode = (url.searchParams.get('mode') ?? 'freeroam').slice(0, 16);
      this.isPublic = url.searchParams.get('public') === '1';
      this.match = {
        mode: this.mode === 'tdm' ? MODE_TDM : MODE_FREEROAM,
        state: MATCH_LOBBY, scoreA: 0, scoreB: 0, target: TDM_TARGET,
      };
      void this.ctx.storage.put('match', this.match);
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    // acceptWebSocket (not server.accept()) is what enables hibernation.
    this.ctx.acceptWebSocket(server);

    if (this.ctx.getWebSockets().length > MAX_PLAYERS) {
      server.send(encodeReject(REJECT_FULL));
      server.close(1013, 'room full');
    } else {
      // Alarms fire even while hibernating, so the lobby heartbeat costs us no wake time
      // of our own — this is why the room list can be live with no database behind it.
      void this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
      void this.heartbeat();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw === 'string') return;                 // we only speak binary
    if (!this.allow(ws)) return;

    switch (messageId(raw)) {
      case C_HELLO: return this.onHello(ws, raw);
      case C_STATE: return this.onState(ws, raw);
      case C_HIT: return this.onHit(ws, raw);
      case C_KILL: return this.onKill(ws, raw);
      case C_TEAM: return this.onTeam(ws, raw);
      case C_MATCH: return this.onMatch(ws, raw);
      case C_TRAFFIC: return this.onTraffic(ws, raw);
      case C_CLAIM: return this.onClaim(ws, raw);
      default: return;                                    // unknown frame: ignore
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const me = this.attach(ws);
    if (me) {
      const bye = encodeLeave(me.id);
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws) this.trySend(other, bye);
      }
    }
    // getWebSockets() still includes the closing socket here, so 1 means "last one out".
    if (this.ctx.getWebSockets().length <= 1) {
      void this.ctx.storage.deleteAlarm();
      void this.ctx.storage.delete(['match', 'host']);
      const code = this.ctx.id.name;
      if (code) void this.env.LOBBY.getByName('global').drop(code);
    } else {
      // The host may have just left with the ambient traffic. Hand it to someone else
      // before anyone notices the cars have stopped.
      this.electHost(ws);
      void this.heartbeat();
    }
  }

  /** Heartbeat: re-announce to the lobby and re-arm, for as long as anyone is here. */
  override async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    await this.heartbeat();
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  private async heartbeat(): Promise<void> {
    const code = this.ctx.id.name;
    if (!code) return;
    try {
      await this.env.LOBBY.getByName('global').announce({
        code,
        mode: this.match.mode === MODE_TDM ? 'tdm' : 'freeroam',
        players: this.ctx.getWebSockets().length,
        max: MAX_PLAYERS,
        isPublic: this.isPublic,
      });
    } catch { /* the lobby is a convenience, never a hard dependency */ }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /* ── handlers ───────────────────────────────────────────────────────────── */

  private onHello(ws: WebSocket, raw: ArrayBuffer): void {
    if (this.attach(ws)) return;                          // already greeted
    const hello = decodeHello(raw);
    if (!hello) return;
    if (hello.version !== PROTOCOL_VERSION) {
      ws.send(encodeReject(REJECT_VERSION));
      ws.close(1002, 'protocol version');
      return;
    }

    const peers: Peer[] = [];
    const taken = new Set<number>();
    for (const other of this.ctx.getWebSockets()) {
      const a = this.attach(other);
      if (!a || other === ws) continue;
      taken.add(a.id);
      peers.push({ id: a.id, name: a.name, team: a.team });
    }
    if (peers.length >= MAX_PLAYERS) {
      ws.send(encodeReject(REJECT_FULL));
      ws.close(1013, 'room full');
      return;
    }

    let id = 1;
    while (taken.has(id) && id < 255) id++;
    const name = cleanName(hello.name, id);
    // Free-roam has no sides at all, so a joiner is team 0 and nobody can shoot them.
    // In a match they land on whichever side is short — never their own choice, or the
    // first four people in all pick the same team and there is no game.
    const team = this.match.mode === MODE_FREEROAM ? TEAM_NONE : this.thinnerTeam(peers);
    // Attachments survive hibernation, so identity outlives a sleeping object.
    ws.serializeAttachment({ id, name, team } satisfies Attach);

    if (!this.hostId) {
      this.hostId = id;
      void this.ctx.storage.put('host', id);
    }
    // First one in picks the city; everyone after is told what it is.
    if (this.map < 0) {
      this.map = hello.map;
      void this.ctx.storage.put('map', this.map);
    }

    ws.send(encodeWelcome(id, team, this.hostId, Math.max(0, this.map), peers));
    ws.send(encodeMatchOut(this.match));
    const joined = encodeJoin({ id, name, team });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) this.trySend(other, joined);
    }
  }

  private onState(ws: WebSocket, raw: ArrayBuffer): void {
    const me = this.attach(ws);
    if (!me) return;                                      // must say hello first
    const msg = decodeState(raw);
    if (!msg) return;

    // Drop stale/duplicate frames. uint16 wraps, so compare on the short way round.
    const l = this.liveOf(ws);
    const delta = (msg.seq - l.seq) & 0xffff;
    if (l.seq !== 0 && (delta === 0 || delta > 0x8000)) return;
    l.seq = msg.seq;

    // The team is ours to state, not the client's — otherwise anyone can turn friendly
    // fire on by claiming to be on the other side.
    const state: PlayerState = { ...msg.state, id: me.id, team: me.team };
    const frame = encodeSnapshot(++this.tick, [state]);
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) this.trySend(other, frame);
    }
  }

  /**
   * Forward a hit to its victim only. The victim owns its own health, so nobody else needs
   * the frame — and the shooter already drew its own hit marker locally, at zero latency.
   */
  private onHit(ws: WebSocket, raw: ArrayBuffer): void {
    const me = this.attach(ws);
    if (!me) return;
    const hit = decodeHit(raw);
    if (!hit || hit.target === me.id) return;
    if (this.match.state !== MATCH_LIVE) return;          // no damage outside a live match

    const victim = this.socketOf(hit.target);
    if (!victim) return;
    const them = this.attach(victim);
    if (!them) return;
    // Friendly fire is off, and it is off *here* so a modified client cannot turn it on.
    if (me.team !== TEAM_NONE && me.team === them.team) return;

    this.trySend(victim, encodeHitOut({
      shooter: me.id,
      target: hit.target,
      damage: Math.min(hit.damage, MAX_HIT_DAMAGE),
      flags: hit.flags,
    }));
  }

  /**
   * Only the victim reports a death, so a kill is counted exactly once no matter how many
   * people were shooting. The score is ours because two clients tallying independently
   * disagree the first time a frame is dropped.
   */
  private onKill(ws: WebSocket, raw: ArrayBuffer): void {
    const me = this.attach(ws);
    if (!me) return;
    const msg = decodeKill(raw);
    if (!msg) return;

    const killerWs = msg.killer ? this.socketOf(msg.killer) : null;
    const killer = killerWs ? this.attach(killerWs) : null;

    this.broadcast(encodeKillOut(killer ? killer.id : 0, me.id, msg.flags));

    // No point for suicide, for a team kill, or for dying to the city itself.
    const scores = this.match.state === MATCH_LIVE
      && killer !== null
      && killer.id !== me.id
      && killer.team !== me.team
      && killer.team !== TEAM_NONE;
    if (!scores || !killer) return;

    if (killer.team === TEAM_A) this.match.scoreA++;
    else this.match.scoreB++;
    if (this.match.scoreA >= this.match.target || this.match.scoreB >= this.match.target) {
      this.match.state = MATCH_OVER;
    }
    this.saveMatch();
    this.broadcast(encodeMatchOut(this.match));
  }

  /** A side switch is allowed only while it does not make the match lopsided. */
  private onTeam(ws: WebSocket, raw: ArrayBuffer): void {
    const me = this.attach(ws);
    if (!me) return;
    const want = decodeTeam(raw);
    if (want === null || want === me.team) return;
    if (this.match.mode === MODE_FREEROAM || want === TEAM_NONE) return;

    let a = 0, b = 0;
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const t = this.attach(other)?.team;
      if (t === TEAM_A) a++;
      else if (t === TEAM_B) b++;
    }
    // Refuse anything that would leave one side two or more players larger.
    const after = want === TEAM_A ? a + 1 - b : b + 1 - a;
    if (after > 1) {
      this.trySend(ws, encodeTeamOut(me.id, me.team));    // tell them it did not take
      return;
    }

    ws.serializeAttachment({ ...me, team: want } satisfies Attach);
    this.broadcast(encodeTeamOut(me.id, want));
  }

  /** Start or reset a match. Host only — anyone else is ignored, not punished. */
  private onMatch(ws: WebSocket, raw: ArrayBuffer): void {
    const me = this.attach(ws);
    if (!me || me.id !== this.hostId) return;
    const msg = decodeMatch(raw);
    if (!msg) return;

    if (msg.action === MATCH_START) {
      const mode = msg.mode === MODE_TDM ? MODE_TDM : MODE_FREEROAM;
      this.match = {
        mode,
        state: mode === MODE_FREEROAM ? MATCH_LOBBY : MATCH_LIVE,
        scoreA: 0, scoreB: 0, target: TDM_TARGET,
      };
      this.assignTeams(mode === MODE_FREEROAM ? null : undefined);
    } else if (msg.action === MATCH_RESET) {
      this.match = {
        mode: MODE_FREEROAM, state: MATCH_LOBBY, scoreA: 0, scoreB: 0, target: TDM_TARGET,
      };
      this.assignTeams(null);
    } else {
      return;
    }
    this.saveMatch();
    this.broadcast(encodeMatchOut(this.match));
  }

  /**
   * Ambient traffic, accepted from the host and nobody else. Two clients broadcasting cars
   * would fight over every position, so the check is a hard drop rather than a merge.
   */
  private onTraffic(ws: WebSocket, raw: ArrayBuffer): void {
    const me = this.attach(ws);
    if (!me || me.id !== this.hostId) return;
    const cars = decodeTraffic(raw);
    if (!cars) return;
    const frame = encodeTrafficOut(cars);
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) this.trySend(other, frame);
    }
  }

  /**
   * Relay a car claim untouched. The host is the only client that acts on it (it stops
   * simulating the car), but everyone needs it so they stop drawing their own copy.
   */
  private onClaim(ws: WebSocket, raw: ArrayBuffer): void {
    const me = this.attach(ws);
    if (!me) return;
    const c = decodeClaim(raw);
    if (!c) return;
    const frame = encodeClaimOut(me.id, c.car, c.taken);
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) this.trySend(other, frame);
    }
  }

  /* ── teams, host ────────────────────────────────────────────────────────── */

  /**
   * Put everyone on a side, alternating so the split is even and stable. Pass null to
   * clear teams (back to free-roam). Broadcasts one S_TEAM per player — a handful of
   * 3-byte frames, once per match, so it is not worth a bulk message.
   */
  private assignTeams(clear?: null): void {
    const sockets = this.ctx.getWebSockets()
      .map((ws) => ({ ws, a: this.attach(ws) }))
      .filter((e): e is { ws: WebSocket; a: Attach } => e.a !== null)
      .sort((p, q) => p.a.id - q.a.id);

    sockets.forEach((e, i) => {
      const team = clear === null ? TEAM_NONE : (i % 2 === 0 ? TEAM_A : TEAM_B);
      e.ws.serializeAttachment({ ...e.a, team } satisfies Attach);
      this.broadcast(encodeTeamOut(e.a.id, team));
    });
  }

  private thinnerTeam(peers: Peer[]): number {
    let a = 0, b = 0;
    for (const p of peers) {
      if (p.team === TEAM_A) a++;
      else if (p.team === TEAM_B) b++;
    }
    return a <= b ? TEAM_A : TEAM_B;
  }

  /**
   * Lowest connected id owns the traffic. `leaving` is excluded because getWebSockets()
   * still reports a socket that is in the middle of closing.
   */
  private electHost(leaving: WebSocket | null): void {
    let best = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === leaving) continue;
      const a = this.attach(ws);
      if (a && (best === 0 || a.id < best)) best = a.id;
    }
    if (best === this.hostId) return;
    this.hostId = best;
    void this.ctx.storage.put('host', best);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== leaving) this.trySend(ws, encodeHost(best));
    }
  }

  private saveMatch(): void {
    void this.ctx.storage.put('match', this.match);
  }

  /* ── plumbing ───────────────────────────────────────────────────────────── */

  private attach(ws: WebSocket): Attach | null {
    try {
      const a = ws.deserializeAttachment() as Attach | null;
      if (!a || typeof a.id !== 'number') return null;
      // Sockets that greeted us before teams existed decode without one.
      return { id: a.id, name: a.name, team: typeof a.team === 'number' ? a.team : TEAM_NONE };
    } catch {
      return null;
    }
  }

  private socketOf(id: number): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.attach(ws)?.id === id) return ws;
    }
    return null;
  }

  private broadcast(data: ArrayBuffer): void {
    for (const ws of this.ctx.getWebSockets()) this.trySend(ws, data);
  }

  private liveOf(ws: WebSocket): Live {
    let l = this.live.get(ws);
    if (!l) {
      l = { seq: 0, msgs: 0, windowStart: Date.now() };
      this.live.set(ws, l);
    }
    return l;
  }

  /** Simple fixed-window limiter: a flooding client gets disconnected, not served. */
  private allow(ws: WebSocket): boolean {
    const l = this.liveOf(ws);
    const now = Date.now();
    if (now - l.windowStart >= 1000) {
      l.windowStart = now;
      l.msgs = 0;
    }
    if (++l.msgs > RATE_LIMIT_MSGS) {
      try {
        ws.close(1008, 'rate limit');
      } catch { /* already gone */ }
      return false;
    }
    return true;
  }

  /** A socket can die between getWebSockets() and send(); that must not kill the room. */
  private trySend(ws: WebSocket, data: ArrayBuffer): void {
    try {
      ws.send(data);
    } catch { /* closing */ }
  }
}

/** Never trust a client-supplied name: strip controls, cap length, always non-empty. */
function cleanName(raw: string, id: number): string {
  const clean = Array.from(raw)
    .filter((ch) => ch >= ' ' && ch !== '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return clean.length ? clean : `Player ${id}`;
}

/* Wire protocol + interpolation. These run in plain Node — no server, no sockets. */

const { installCanvasStub } = await import('./stub-canvas.mjs');
installCanvasStub();

const P = await import('./protocol.js');
const { InterpBuffer } = await import('./netclient.js');

let fails = 0;
const ok = (c, m, x = '') => { if (c) console.log(`  ok   ${m}`); else { console.log(`  FAIL ${m} ${x}`); fails++; } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* -- round trips ---------------------------------------------------------- */
console.log(`
protocol round trips`);
{
  const hello = P.decodeHello(P.encodeHello('Saith', 2));
  ok(hello && hello.name === 'Saith' && hello.version === P.PROTOCOL_VERSION, 'hello survives a round trip');
  ok(hello.map === 2, 'hello carries the map we want to play');

  const long = 'x'.repeat(200);
  ok(P.decodeHello(P.encodeHello(long, 0)).name.length === 24, 'an over-long name is truncated on the wire');

  const st = {
    x: -123.456, y: 12.34, z: 501.02, yaw: 2.1, flags: P.F_SPRINT | P.F_GROUNDED,
    speed: 6.1, weapon: 2, team: P.TEAM_B, health: 73, vkind: 9, vcolour: 11,
  };
  const back = P.decodeState(P.encodeState(7, st));
  ok(back && back.seq === 7, 'state carries its sequence number');
  ok(near(back.state.x, st.x, 0.01) && near(back.state.y, st.y, 0.01) && near(back.state.z, st.z, 0.01),
    'position survives quantisation to within 1cm',
    `${back.state.x.toFixed(3)} ${back.state.y.toFixed(3)} ${back.state.z.toFixed(3)}`);
  ok(near(back.state.yaw, st.yaw, 0.001), 'yaw survives to within 0.001 rad');
  ok(back.state.flags === st.flags && back.state.weapon === 2, 'flags and weapon are exact');
  ok(near(back.state.speed, 6.1, 0.05), 'speed survives to 0.1 m/s');
  // team+vkind and weapon+vcolour each share a byte; the packing has to survive the top
  // of both ranges or a police truck comes out the other side as a white sedan.
  ok(back.state.team === P.TEAM_B && back.state.health === 73, 'team and health are exact');
  ok(back.state.vkind === 9 && back.state.vcolour === 11,
    'vehicle kind and colour survive the bit packing',
    `${back.state.vkind}/${back.state.vcolour}`);
  ok(P.VEH_KINDS.length <= 16, 'the vehicle kind list still fits in the 4 bits it is packed into');

  const snap = P.decodeSnapshot(P.encodeSnapshot(99, [
    { id: 3, ...st }, { id: 5, x: 1, y: 2, z: 3, yaw: -3.1, flags: 0, speed: 0, weapon: 0 },
  ]));
  ok(snap && snap.tick === 99 && snap.states.length === 2, 'snapshot carries tick and every player');
  ok(snap.states[0].id === 3 && snap.states[1].id === 5, 'player ids are preserved');

  const w = P.decodeWelcome(P.encodeWelcome(4, P.TEAM_B, 1, 3, [
    { id: 1, name: 'Abdul', team: P.TEAM_A }, { id: 2, name: 'Bina', team: P.TEAM_B },
  ]));
  ok(w && w.yourId === 4 && w.peers.length === 2 && w.peers[1].name === 'Bina', 'welcome lists the existing peers');
  ok(w.yourTeam === P.TEAM_B && w.hostId === 1, 'welcome carries our team and the traffic host');
  // The one that matters: two players in different cities is not a game, it is two games.
  ok(w.map === 3, 'welcome tells a joiner which map the room is playing');
  ok(w.peers[0].team === P.TEAM_A && w.peers[1].team === P.TEAM_B, 'welcome carries each peer team');
  const j = P.decodeJoin(P.encodeJoin({ id: 6, name: 'Rauf', team: P.TEAM_A }));
  ok(j.name === 'Rauf' && j.team === P.TEAM_A, 'join round trip carries the team');
  ok(P.decodeLeave(P.encodeLeave(6)) === 6, 'leave round trip');
  ok(P.decodeReject(P.encodeReject(P.REJECT_FULL)) === P.REJECT_FULL, 'reject round trip');
}

/* -- bandwidth ------------------------------------------------------------ */
console.log(`
bandwidth budget`);
{
  const one = P.encodeState(1, { x: 1, y: 1, z: 1, yaw: 1, flags: 0, speed: 1, weapon: 0 });
  ok(one.byteLength <= 16, `a client state frame is ${one.byteLength} bytes`);
  const full = P.encodeSnapshot(1, Array.from({ length: P.MAX_PLAYERS }, (_, i) => (
    { id: i + 1, x: i, y: 0, z: i, yaw: 0, flags: 0, speed: 3, weapon: 1 }
  )));
  ok(full.byteLength < 128, `a full ${P.MAX_PLAYERS}-player snapshot is ${full.byteLength} bytes`);
  const perSec = one.byteLength * P.SEND_HZ;
  ok(perSec < 400, `each client uploads ~${perSec} B/s`);

  // Ambient traffic is the new bandwidth line item, and the only one big enough to matter.
  const cars = Array.from({ length: P.MAX_SYNC_CARS }, (_, i) => (
    { id: i + 1, kind: i % 10, colour: i % 12, x: i, y: 0, z: i, yaw: 0, flags: 0 }
  ));
  const tf = P.encodeTrafficOut(cars);
  ok(tf.byteLength < 700, `a full ${P.MAX_SYNC_CARS}-car traffic frame is ${tf.byteLength} bytes`);
  const trafficPerSec = tf.byteLength * P.TRAFFIC_HZ;
  ok(trafficPerSec < 8000, `the host uploads ~${Math.round(trafficPerSec / 100) / 10} KB/s of traffic`);
}

/* -- hostile input -------------------------------------------------------- */
console.log(`
malformed frames must not throw`);
{
  const cases = [
    new ArrayBuffer(0), new ArrayBuffer(1), new ArrayBuffer(3),
    P.encodeState(1, { x: 0, y: 0, z: 0, yaw: 0, flags: 0, speed: 0, weapon: 0 }).slice(0, 5),
    P.encodeSnapshot(1, [{ id: 1, x: 0, y: 0, z: 0, yaw: 0, flags: 0, speed: 0, weapon: 0 }]).slice(0, 8),
    P.encodeWelcome(1, 0, 0, 0, [{ id: 2, name: 'truncated', team: 0 }]).slice(0, 8),
  ];
  let threw = false;
  for (const buf of cases) {
    for (const fn of [P.decodeHello, P.decodeState, P.decodeSnapshot, P.decodeWelcome, P.decodeJoin, P.decodeLeave, P.decodeReject]) {
      try { fn(buf); } catch { threw = true; }
    }
  }
  ok(!threw, 'every decoder returns null on truncated input instead of throwing');

  // a claimed player count larger than the frame must be rejected, not read past the end
  const lying = P.encodeSnapshot(1, [{ id: 1, x: 0, y: 0, z: 0, yaw: 0, flags: 0, speed: 0, weapon: 0 }]);
  new DataView(lying).setUint8(5, 40);
  ok(P.decodeSnapshot(lying) === null, 'a snapshot claiming more players than it contains is rejected');

  // NaN and Infinity must never reach the wire
  const bad = P.decodeState(P.encodeState(1, { x: NaN, y: Infinity, z: -Infinity, yaw: NaN, flags: 0, speed: NaN, weapon: 0 }));
  ok(Number.isFinite(bad.state.x) && Number.isFinite(bad.state.y) && Number.isFinite(bad.state.yaw),
    'NaN and Infinity are sanitised to finite values');

  // a yaw that has drifted far outside −π…π must still decode sanely
  const spun = P.decodeState(P.encodeState(1, { x: 0, y: 0, z: 0, yaw: 400.5, flags: 0, speed: 0, weapon: 0 }));
  ok(Math.abs(spun.state.yaw) <= Math.PI + 0.01, `a drifting yaw wraps instead of overflowing (${spun.state.yaw.toFixed(2)})`);
}

/* -- room codes ----------------------------------------------------------- */
console.log(`
room codes`);
{
  let rngState = 12345;
  const rand = () => ((rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const codes = new Set();
  for (let i = 0; i < 400; i++) codes.add(P.makeRoomCode(rand));
  ok(codes.size > 390, `${codes.size}/400 generated codes were unique`);
  for (const c of codes) {
    if (c.length !== 5 || /[O0I1L]/.test(c)) { ok(false, 'codes avoid ambiguous characters', c); break; }
  }
  ok(true, 'codes are 5 chars and avoid O/0 and I/1/L');
  ok(P.normaliseRoomCode(' abc23 ') === 'ABC23', 'user input is trimmed and upper-cased');
  ok(P.normaliseRoomCode('ab-c23') === 'ABC23', 'punctuation is stripped');
  ok(P.normaliseRoomCode('ABC2') === '', 'a short code is rejected');
  ok(P.normaliseRoomCode('ABC2O') === '', 'a code with an ambiguous character is rejected');
}

/* -- interpolation -------------------------------------------------------- */
console.log(`
interpolation (remote players must move smoothly)`);
{
  const mk = (x, yaw = 0) => ({ id: 1, x, y: 0, z: 0, yaw, flags: 0, speed: 4, weapon: 0 });
  const b = new InterpBuffer();

  ok(b.sample(1000) === null, 'an empty buffer samples to null');

  // snapshots at 0, 50, 100 ms — a player walking +1 m per 50 ms
  b.push(mk(0), 1000);
  b.push(mk(1), 1050);
  b.push(mk(2), 1100);

  // render time = now − INTERP_DELAY_MS, so at now=1160 we want t=1050 exactly
  const at = b.sample(1050 + P.INTERP_DELAY_MS);
  ok(near(at.x, 1, 0.001), `samples exactly on a snapshot boundary (${at.x.toFixed(3)})`);

  const mid = b.sample(1075 + P.INTERP_DELAY_MS);
  ok(near(mid.x, 1.5, 0.001), `interpolates halfway between two snapshots (${mid.x.toFixed(3)})`);

  // beyond the newest sample it must hold, not extrapolate off into the distance
  const future = b.sample(3000 + P.INTERP_DELAY_MS);
  ok(near(future.x, 2, 0.001), `holds the last pose instead of extrapolating (${future.x.toFixed(3)})`);

  // yaw must take the short way round when crossing ±π
  const y = new InterpBuffer();
  y.push(mk(0, Math.PI - 0.1), 2000);
  y.push(mk(0, -Math.PI + 0.1), 2100);
  const half = y.sample(2050 + P.INTERP_DELAY_MS);
  ok(Math.abs(half.yaw) > Math.PI - 0.15,
    `yaw crossing ±π interpolates the short way (${half.yaw.toFixed(2)})`);

  // out-of-order arrivals are dropped rather than jerking the player backwards
  const o = new InterpBuffer();
  o.push(mk(0), 3000);
  o.push(mk(5), 3100);
  o.push(mk(99), 3050);
  ok(o.latest().x === 5, 'a late-arriving stale frame is ignored');

  // history is bounded, so a long session cannot grow the buffer forever
  const g = new InterpBuffer();
  for (let i = 0; i < 500; i++) g.push(mk(i), 5000 + i * 50);
  ok(g.length <= 40, `buffer stays bounded (${g.length} samples after 500 pushes)`);
}

/* -- teams, match and combat frames --------------------------------------- */
console.log(`
teams, matches and hit reporting`);
{
  const h = P.decodeHit(P.encodeHit(7, 42, P.HIT_HEAD));
  ok(h.target === 7 && h.damage === 42 && h.flags === P.HIT_HEAD, 'a hit report round trips');
  // Damage is a byte; a client claiming more than that must not wrap round to a small number.
  ok(P.decodeHit(P.encodeHit(7, 99999, 0)).damage === 255, 'an absurd damage claim clamps instead of wrapping');

  const ho = P.decodeHitOut(P.encodeHitOut({ shooter: 3, target: 7, damage: 9, flags: 0 }));
  ok(ho.shooter === 3 && ho.target === 7, 'the server-stamped hit carries the shooter');

  const k = P.decodeKill(P.encodeKill(4, 0));
  ok(k.killer === 4, 'a death report round trips');
  const ko = P.decodeKillOut(P.encodeKillOut(4, 6, P.HIT_VEHICLE));
  ok(ko.killer === 4 && ko.victim === 6 && ko.flags === P.HIT_VEHICLE, 'a kill announcement round trips');

  ok(P.decodeTeam(P.encodeTeam(P.TEAM_B)) === P.TEAM_B, 'a team request round trips');
  const to = P.decodeTeamOut(P.encodeTeamOut(5, P.TEAM_A));
  ok(to.id === 5 && to.team === P.TEAM_A, 'a team assignment round trips');
  ok(P.decodeHost(P.encodeHost(3)) === 3, 'the host announcement round trips');

  const m = { mode: P.MODE_TDM, state: P.MATCH_LIVE, scoreA: 17, scoreB: 4, target: P.TDM_TARGET };
  const mo = P.decodeMatchOut(P.encodeMatchOut(m));
  ok(mo.mode === P.MODE_TDM && mo.state === P.MATCH_LIVE && mo.scoreA === 17 && mo.scoreB === 4,
    'match state round trips');
  const mc = P.decodeMatch(P.encodeMatch(P.MATCH_START, P.MODE_TDM));
  ok(mc.action === P.MATCH_START && mc.mode === P.MODE_TDM, 'a match request round trips');

  const cl = P.decodeClaimOut(P.encodeClaimOut(2, 4096, true));
  ok(cl.by === 2 && cl.car === 4096 && cl.taken === true, 'a car claim round trips a 16-bit car id');
}

/* -- traffic sync --------------------------------------------------------- */
console.log(`
ambient traffic`);
{
  const cars = [
    { id: 1, kind: 5, colour: 11, x: -120.5, y: 0.3, z: 88.25, yaw: 1.2, flags: P.TF_SIREN },
    { id: 4097, kind: 9, colour: 0, x: 10, y: 0, z: -10, yaw: -2.9, flags: 0 },
  ];
  const back = P.decodeTrafficOut(P.encodeTrafficOut(cars));
  ok(back && back.length === 2, 'a traffic frame carries every car');
  ok(back[0].kind === 5 && back[0].colour === 11, 'car kind and colour survive the shared byte');
  ok(back[1].id === 4097, 'a car id above 255 survives');
  // 2cm steps means a worst case of exactly 1cm, and 88.25 lands on that boundary —
  // the tolerance has to be the quantisation error plus float slop, not under it.
  ok(near(back[0].x, -120.5, 0.011) && near(back[0].z, 88.25, 0.011),
    'car positions keep 1cm', `${back[0].x} ${back[0].z}`);
  ok(back[0].flags === P.TF_SIREN, 'car flags are exact');

  // hostile input: a count larger than the payload must be refused, not read past the end
  const lying = P.encodeTrafficOut(cars);
  new DataView(lying).setUint8(1, 40);
  ok(P.decodeTrafficOut(lying) === null, 'a traffic frame claiming more cars than it holds is rejected');
  const over = P.encodeTrafficOut(cars);
  new DataView(over).setUint8(1, 200);
  ok(P.decodeTrafficOut(over) === null, 'a car count beyond the cap is rejected');

  let threw = false;
  for (const bad of [new ArrayBuffer(0), new ArrayBuffer(1), lying.slice(0, 5)]) {
    for (const fn of [P.decodeTrafficOut, P.decodeTraffic, P.decodeHitOut, P.decodeKillOut,
      P.decodeMatchOut, P.decodeTeamOut, P.decodeClaimOut, P.decodeHost]) {
      try { fn(bad); } catch { threw = true; }
    }
  }
  ok(!threw, 'the new decoders are hostile-input safe too');
}

/* -- traffic interpolation ------------------------------------------------ */
console.log(`
traffic interpolation`);
{
  const { TrafficBuffer } = await import('./netclient.js');
  const frame = (x, ids = [1]) => ids.map((id) => (
    { id, kind: 0, colour: 0, x, y: 0, z: 0, yaw: 0, flags: 0 }
  ));
  const b = new TrafficBuffer();
  ok(b.sample(1000).length === 0, 'an empty traffic buffer samples to nothing');

  b.push(frame(0), 1000);
  b.push(frame(10), 1100);
  const mid = b.sample(1050 + P.INTERP_DELAY_MS);
  ok(mid.length === 1 && near(mid[0].x, 5, 0.001), `a car interpolates between frames (${mid[0].x})`);

  // A car the host stopped sending must disappear at once, not linger being interpolated.
  b.push(frame(20, []), 1200);
  ok(b.sample(1200 + P.INTERP_DELAY_MS).length === 0, 'a car dropped by the host stops being drawn');

  const g = new TrafficBuffer();
  for (let i = 0; i < 300; i++) g.push(frame(i), 5000 + i * 100);
  ok(g.length <= 20, `the traffic buffer stays bounded (${g.length} frames after 300 pushes)`);
}

/* -- the room agrees on one map ------------------------------------------- */
console.log('\nroom map handshake');
{
  const { NetClient } = await import('./netclient.js');
  const { mapIndex, mapAt, MAPS } = await import('./maps.js');

  // A stand-in socket, so the real NetClient can be driven without a server.
  const sent = [];
  let sock = null;
  class FakeSocket {
    constructor(url) { this.url = url; sock = this; }
    set binaryType(_v) { }
    send(buf) { sent.push(buf); }
    close() { }
  }
  const prev = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;

  const net = new NetClient();
  net.connect('ABCDE', 'Saith', { origin: 'http://x', map: mapIndex('metro') });
  sock.onopen();
  const hello = P.decodeHello(sent[0]);
  ok(hello && hello.map === mapIndex('metro'),
    `the map we picked goes out in the very first frame (index ${hello?.map})`);

  // The server says the room is already playing something else. We do as we are told.
  sock.onmessage({ data: P.encodeWelcome(2, 0, 1, mapIndex('thal'), []) });
  ok(net.status === 'online', 'the welcome puts us online');
  ok(net.roomMap === mapIndex('thal'),
    `a joiner adopts the room's map, not their own (${mapAt(net.roomMap).name})`);
  ok(mapAt(net.roomMap).id !== 'metro', 'and it really is not the one they asked for');

  globalThis.WebSocket = prev;

  // The index is what goes on the wire, so the roster order is load-bearing.
  ok(MAPS.every((m, i) => mapIndex(m.id) === i), 'every map round-trips through its index');
  ok(mapAt(250).id === MAPS[0].id, 'a nonsense index falls back rather than crashing');
  ok(P.PROTOCOL_VERSION >= 3,
    `the wire version was bumped for map selection (v${P.PROTOCOL_VERSION}), so a build `
    + 'without maps is rejected instead of silently joining a different city');
}

console.log(`
${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}
`);
process.exit(fails ? 1 : 0);

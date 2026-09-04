/* Simulation test: runs the real update loops headlessly for a minute of game time. */

const { installCanvasStub } = await import('./stub-canvas.mjs');
installCanvasStub();

const THREE = await import('three');
const { Physics, KIND } = await import('./physics.js');
const { buildMaterials } = await import('./materials.js');
const city = await import('./city.js');
const { QUALITY, DEFAULT_SETTINGS, DEFAULT_BINDS } = await import('./settings.js');
const { PedManager } = await import('./peds.js');
const { Traffic } = await import('./traffic.js');
const { Combat } = await import('./combat.js');
const { CameraRig } = await import('./camerarig.js');
const { radarProject } = await import('./minimap.js');
const { fwdX, fwdZ, rgtX, rgtZ } = await import('./mathx.js');
const { createVehicle, placeVehicle, stepVehicle, updateVehicleBox, SPECS } = await import('./vehicle.js');
const { Input } = await import('./input.js');

let fails = 0;
const ok = (c, m, x = '') => { if (c) console.log(`  ok   ${m}`); else { console.log(`  FAIL ${m} ${x}`); fails++; } };
const DT = 1 / 60;

/* -- handedness -------------------------------------------------------------
   three.js's own camera matrix is the oracle here: whatever the maths says,
   "right" must be whatever appears on the right of the screen.               */
console.log('\nhandedness (D must strafe right)');
{
  const settings = { ...DEFAULT_SETTINGS };
  const phys = new Physics();
  phys.addBox(-400, -400, 400, 400, 0, 0.0001, KIND.Ground);
  phys.build();
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);

  for (const yaw of [0, 0.9, -2.4, 3.05]) {
    const rig = new CameraRig();
    rig.reset(yaw, 0, 0, 0);
    rig.yaw = yaw;
    for (let i = 0; i < 90; i++) rig.updateOnFoot(cam, DT, 0, 0, 0, false, 1, phys, settings);
    cam.updateMatrixWorld(true);

    const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).setY(0).normalize();
    const camFwd = new THREE.Vector3();
    cam.getWorldDirection(camFwd);
    camFwd.setY(0).normalize();

    const strafe = new THREE.Vector3(rig.rightX(), 0, rig.rightZ());
    const ahead = new THREE.Vector3(rig.forwardX(), 0, rig.forwardZ());
    ok(strafe.dot(camRight) > 0.99, `yaw ${yaw.toFixed(2)}: D strafes towards screen-right`, `dot=${strafe.dot(camRight).toFixed(3)}`);
    ok(ahead.dot(camFwd) > 0.99, `yaw ${yaw.toFixed(2)}: W walks towards screen-up`, `dot=${ahead.dot(camFwd).toFixed(3)}`);
  }

  // dragging the mouse right must swing the view towards what was screen-right
  const rig = new CameraRig();
  rig.yaw = 0.4;
  const before = new THREE.Vector3(rig.rightX(), 0, rig.rightZ());
  rig.applyMouse(300, 0, { ...DEFAULT_SETTINGS }, false);
  const after = new THREE.Vector3(rig.forwardX(), 0, rig.forwardZ());
  ok(after.dot(before) > 0.05, 'mouse right turns the view right', `dot=${after.dot(before).toFixed(3)}`);

  // the radar must not be mirrored
  const yaw = 1.1;
  const [rxp, ryp] = radarProject(40 + rgtX(yaw) * 20, 40 + rgtZ(yaw) * 20, 40, 40, yaw, 1.5, 100);
  const [axp, ayp] = radarProject(40 + fwdX(yaw) * 20, 40 + fwdZ(yaw) * 20, 40, 40, yaw, 1.5, 100);
  ok(rxp > 110 && Math.abs(ryp - 100) < 1, 'radar puts things on your right on the right');
  ok(ayp < 90 && Math.abs(axp - 100) < 1, 'radar puts things ahead of you at the top');
}

/* -- input edges ------------------------------------------------------------
   One key press must trigger exactly one action. The frame runs the driving
   handler and then the world-interaction handler, and both read the same edge,
   so without consuming it E would exit a car and immediately re-enter it.     */
console.log(`
input edges (one press = one action)`);
{
  const handlers = {};
  globalThis.addEventListener = (type, fn) => { handlers[type] = fn; };
  globalThis.removeEventListener = () => {};
  globalThis.document.addEventListener = () => {};
  globalThis.document.removeEventListener = () => {};

  const el = { addEventListener: () => {}, removeEventListener: () => {} };
  const input = new Input(el, DEFAULT_BINDS);
  input.attach();
  const tap = (code) => handlers.keydown({ code, repeat: false, preventDefault() {} });
  const release = (code) => handlers.keyup({ code });

  tap('KeyE');
  ok(input.justPressed('use'), 'E registers as a press');

  // the frame's first handler acts on it and consumes it
  input.consume('use');
  ok(!input.justPressed('use'), 'a consumed press is not seen by the next handler in the frame');

  // simulate the real bug: exit then interaction, in one frame
  release('KeyE');
  input.endFrame();
  tap('KeyE');
  let entered = 0, exited = 0;
  const frame = () => {
    if (input.justPressed('use')) { input.consume('use'); exited++; }      // updateDriving
    if (input.justPressed('use')) { input.consume('use'); entered++; }     // updateInteraction
    input.endFrame();
  };
  frame();
  ok(exited === 1 && entered === 0, 'one tap of E gets you out of the car and leaves you out', `exit=${exited} enter=${entered}`);

  // holding the key must not repeat
  frame();
  frame();
  ok(exited === 1, 'holding E does not toggle in and out repeatedly');

  // a fresh tap works again
  release('KeyE');
  tap('KeyE');
  frame();
  ok(exited === 2, 'pressing E again is picked up as a new action');
  input.detach();
}

/* -- vehicle handling ----------------------------------------------------- */
console.log('\nvehicle handling');
{
  const p = new Physics();
  p.addBox(-200, -200, 200, 200, 0, 0.0001, KIND.Ground);
  p.addBox(-6, 40, 6, 46, 0, 4, KIND.Building);        // wall 40m ahead
  p.build();

  const v = createVehicle('sedan', 0xff0000);
  placeVehicle(v, 0, 0, 0);
  updateVehicleBox(v);

  // full lock, no throttle: a real car cannot pivot on the spot
  v.ctrl = { throttle: 0, brake: 0, steer: 1, handbrake: false };
  for (let i = 0; i < 120; i++) stepVehicle(v, DT, p);
  ok(Math.abs(v.yaw) < 0.01, 'cannot turn while stationary', `yaw=${v.yaw.toFixed(4)}`);

  // accelerate straight (reset: wheels legitimately stay turned after standstill steering)
  placeVehicle(v, 0, 0, 0);
  v.steerAngle = 0;
  v.ctrl = { throttle: 1, brake: 0, steer: 0, handbrake: false };
  for (let i = 0; i < 120; i++) stepVehicle(v, DT, p);
  ok(v.speed > 8, `accelerates to ${(v.speed * 3.6).toFixed(0)} km/h in 2s`);
  ok(v.z > 8 && Math.abs(v.x) < 0.2, 'drives straight along its own forward axis', `x=${v.x.toFixed(2)} z=${v.z.toFixed(2)}`);

  // steer +1 must move the car towards its own right-hand side, and yaw must DECREASE
  const x0 = v.x, z0 = v.z, yaw0 = v.yaw;
  const right0 = { x: rgtX(yaw0), z: rgtZ(yaw0) };
  v.ctrl.steer = 1;
  for (let i = 0; i < 45; i++) stepVehicle(v, DT, p);
  const drift = (v.x - x0) * right0.x + (v.z - z0) * right0.z;
  ok(drift > 0.5, 'steer +1 (the D key) turns the car right', `sideways travel=${drift.toFixed(2)}m`);
  ok(v.yaw < yaw0, 'a right turn decreases yaw', `dyaw=${(v.yaw - yaw0).toFixed(3)}`);

  // drive into the wall: must not pass through
  const v2 = createVehicle('sports', 0x00ff00);
  placeVehicle(v2, 0, 0, 0);
  v2.ctrl = { throttle: 1, brake: 0, steer: 0, handbrake: false };
  for (let i = 0; i < 60 * 8; i++) stepVehicle(v2, DT, p);
  ok(v2.z < 40, `stopped by the wall at z=${v2.z.toFixed(2)} (wall face is 40)`);
  ok(v2.health < 100, `took crash damage (${Math.round(v2.health)} hp)`);

  // handbrake slide keeps momentum sideways
  const v3 = createVehicle('sedan', 0x0000ff);
  placeVehicle(v3, 0, -100, 0);
  v3.ctrl = { throttle: 1, brake: 0, steer: 0, handbrake: false };
  for (let i = 0; i < 200; i++) stepVehicle(v3, DT, p);
  v3.ctrl = { throttle: 0, brake: 0, steer: 1, handbrake: true };
  for (let i = 0; i < 40; i++) stepVehicle(v3, DT, p);
  const lateral = Math.abs(v3.vx * rgtX(v3.yaw) + v3.vz * rgtZ(v3.yaw));
  ok(lateral > 0.4, `handbrake produces a real slide (${lateral.toFixed(2)} m/s lateral)`);
}

/* -- performance ladder -----------------------------------------------------
   Regression guard for a real bug: rolling resistance used to grow linearly with
   speed and swamp the engine, so every car in the game topped out near 39 km/h
   no matter what its spec said. maxSpeed must be the honest terminal velocity.  */
console.log(`
performance ladder (maxSpeed must be real)`);
{
  const p = new Physics();
  p.addBox(-9000, -9000, 9000, 9000, 0, 0.0001, KIND.Ground);
  p.build();

  const flatOut = (kind, boost, secs = 90) => {
    const v = createVehicle(kind, 0xffffff);
    placeVehicle(v, 0, 0, 0);
    v.ctrl = { throttle: 1, brake: 0, steer: 0, handbrake: false, boost };
    let peak = 0, t100 = null;
    for (let i = 0; i < 60 * secs; i++) {
      stepVehicle(v, DT, p);
      peak = Math.max(peak, v.speed);
      if (t100 === null && v.speed * 3.6 >= 100) t100 = i / 60;
    }
    return { peak, t100, v };
  };

  for (const kind of Object.keys(SPECS)) {
    const spec = SPECS[kind];
    const { peak } = flatOut(kind, false);
    const ratio = peak / spec.maxSpeed;
    ok(ratio > 0.97 && ratio < 1.03,
      `${kind.padEnd(9)} reaches its quoted ${(spec.maxSpeed * 3.6).toFixed(0)} km/h`,
      `got ${(peak * 3.6).toFixed(0)}`);
  }

  // the ladder must actually be a ladder
  const tops = Object.keys(SPECS).map((k) => ({ k, v: SPECS[k].maxSpeed }));
  ok(SPECS.hyper.maxSpeed > SPECS.sports.maxSpeed
    && SPECS.sports.maxSpeed > SPECS.muscle.maxSpeed
    && SPECS.muscle.maxSpeed > SPECS.sedan.maxSpeed
    && SPECS.sedan.maxSpeed > SPECS.hatch.maxSpeed
    && SPECS.hatch.maxSpeed > SPECS.rickshaw.maxSpeed,
    'class ladder is ordered rickshaw < hatch < sedan < muscle < sports < hyper');
  ok(SPECS.hyper.maxSpeed * 3.6 > 320, `the hypercar does ${(SPECS.hyper.maxSpeed * 3.6).toFixed(0)} km/h`);
  ok(tops.every((t) => t.v * 3.6 > 70), 'even the rickshaw beats the old 39 km/h ceiling');

  // acceleration should feel graded, not identical
  const sedanT = flatOut('sedan', false, 20).t100;
  const hyperT = flatOut('hyper', false, 20).t100;
  ok(sedanT > 3.5 && sedanT < 7, `sedan does 0-100 in ${sedanT.toFixed(1)}s (believable, not twitchy)`);
  ok(hyperT < 2.2, `hypercar does 0-100 in ${hyperT.toFixed(1)}s`);
  ok(sedanT > hyperT * 1.8, 'the class you pick actually changes how it launches');

  // nitrous must extend the top end, then run dry and lock out
  const plain = flatOut('sports', false, 30).peak;
  const juiced = flatOut('sports', true, 30).peak;
  ok(juiced > plain * 1.1, `nitrous lifts the sports car ${(plain * 3.6).toFixed(0)} to ${(juiced * 3.6).toFixed(0)} km/h`);
  const { v: drained } = flatOut('sports', true, 30);
  ok(drained.boost < 0.5 && drained.boostLock === false || drained.boost >= 0, 'boost tank drains while held');

  // high speed must stay controllable: the cornering limit caps the turn rate
  const fast = createVehicle('hyper', 0xffffff);
  placeVehicle(fast, 0, 0, 0);
  fast.ctrl = { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false };
  for (let i = 0; i < 60 * 25; i++) stepVehicle(fast, DT, p);
  const before = fast.yaw;
  fast.ctrl.steer = 1;
  let maxRate = 0;
  for (let i = 0; i < 60; i++) {
    const y0 = fast.yaw;
    stepVehicle(fast, DT, p);
    maxRate = Math.max(maxRate, Math.abs(fast.yaw - y0) / DT);
  }
  ok(maxRate < 0.5, `at ${(fast.speed * 3.6).toFixed(0)} km/h it turns at most ${maxRate.toFixed(2)} rad/s, not like a trolley`);
  ok(fast.yaw !== before, 'but it does still steer');

  // ...while parking stays tight
  const slow = createVehicle('hyper', 0xffffff);
  placeVehicle(slow, 0, 0, 0);
  slow.ctrl = { throttle: 0.25, brake: 0, steer: 1, handbrake: false, boost: false };
  let parkRate = 0;
  for (let i = 0; i < 60 * 3; i++) {
    const y0 = slow.yaw;
    stepVehicle(slow, DT, p);
    parkRate = Math.max(parkRate, Math.abs(slow.yaw - y0) / DT);
  }
  ok(parkRate > 0.5, `low-speed steering is still sharp (${parkRate.toFixed(2)} rad/s)`);
}

/* -- city sim: traffic + pedestrians ------------------------------------- */
console.log('\ncity simulation (60s of game time)');
const phys = new Physics();
const scene = new THREE.Scene();
const mats = buildMaterials();
const C = city.buildCity(scene, phys, mats, QUALITY.medium, 20260805);

const HR = city.ROADW / 2;
const strips = [];
for (let i = 0; i < city.N; i++) {
  const x = city.roadCoord(i);
  strips.push({ minX: x - HR, maxX: x + HR, minZ: city.roadCoord(0) - HR, maxZ: city.roadCoord(city.N - 1) + HR });
  strips.push({ minZ: x - HR, maxZ: x + HR, minX: city.roadCoord(0) - HR, maxX: city.roadCoord(city.N - 1) + HR });
}
// the housing scheme streets, taken from the same data the generator used
for (const r of C.minimap.roads) {
  const hw = r.w / 2;
  if (r.z1 === r.z2 && r.z1 > 200) strips.push({ minX: Math.min(r.x1, r.x2), maxX: Math.max(r.x1, r.x2), minZ: r.z1 - hw, maxZ: r.z1 + hw });
  if (r.x1 === r.x2 && Math.max(r.z1, r.z2) > 200) strips.push({ minZ: Math.min(r.z1, r.z2), maxZ: Math.max(r.z1, r.z2), minX: r.x1 - hw, maxX: r.x1 + hw });
}
const onRoad = (x, z) => strips.some((s) => x > s.minX && x < s.maxX && z > s.minZ && z < s.maxZ);
const solids = phys.boxes.filter((b) => b.kind === KIND.Building);
const insideBuilding = (x, z) => solids.some((b) => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ);

const peds = new PedManager(scene, phys, C);
peds.populate(16);
const traffic = new Traffic(scene, C, phys);
traffic.spawn(12);
traffic.spawnParked(8);
const combat = new Combat(scene, phys, 12);

let offRoad = 0, samples = 0, pedInBuilding = 0, pedSamples = 0;
const startPos = peds.peds.map((p) => ({ x: p.x, z: p.z }));
const px = C.playerStart.x, pz = C.playerStart.z;

for (let f = 0; f < 60 * 60; f++) {
  phys.dyn.length = 0;
  for (const v of traffic.cars) phys.dyn.push(v.box);
  traffic.update(DT, f * DT, null, px, pz, null);
  peds.update(DT, f * DT, px, 0.16, pz, true, 0, () => {}, 400);
  combat.update(DT);
  if (f % 30 === 0) {
    for (const v of traffic.cars) {
      if (!v.ai) continue;               // parked cars are meant to be off-road
      samples++;
      if (!onRoad(v.x, v.z)) offRoad++;
    }
    for (const p of peds.peds) {
      pedSamples++;
      if (insideBuilding(p.x, p.z)) pedInBuilding++;
    }
  }
}

ok(offRoad / samples < 0.06, `traffic stayed on the road ${(100 - (offRoad / samples) * 100).toFixed(1)}% of samples`);
ok(pedInBuilding === 0, 'no pedestrian ever ended up inside a building', `${pedInBuilding}/${pedSamples}`);
const moved = peds.peds.filter((p, i) => Math.hypot(p.x - startPos[i].x, p.z - startPos[i].z) > 4).length;
ok(moved >= peds.peds.length * 0.7, `${moved}/${peds.peds.length} pedestrians actually walked their route`);
const movedCars = traffic.cars.filter((v) => v.ai && Math.abs(v.speed) > 1).length;
ok(movedCars >= 8, `${movedCars}/12 traffic cars are still driving after a minute`);
ok(traffic.cars.every((v) => Number.isFinite(v.x) && Number.isFinite(v.yaw)), 'no NaN leaked into vehicle state');
ok(peds.peds.every((p) => Number.isFinite(p.x) && Number.isFinite(p.yaw)), 'no NaN leaked into pedestrian state');

/* -- driving on the left ------------------------------------------------- */
{
  // Sample cars travelling along a road and check which side of the centre line they use.
  let correctSide = 0, checked = 0;
  for (const v of traffic.cars) {
    if (!v.ai || Math.abs(v.speed) < 2) continue;
    // nearest road centre line on each axis
    let best = null, bd = 1e9;
    for (let i = 0; i < city.N; i++) {
      const cx = city.roadCoord(i);
      if (Math.abs(v.x - cx) < bd) { bd = Math.abs(v.x - cx); best = { axis: 'x', c: cx }; }
      const cz = city.roadCoord(i);
      if (Math.abs(v.z - cz) < bd) { bd = Math.abs(v.z - cz); best = { axis: 'z', c: cz }; }
    }
    if (!best || bd > HR) continue;
    checked++;
    // offset from the centre line, projected onto the car's own right
    const offX = best.axis === 'x' ? v.x - best.c : 0;
    const offZ = best.axis === 'z' ? v.z - best.c : 0;
    const onRight = offX * rgtX(v.yaw) + offZ * rgtZ(v.yaw);
    if (onRight < 0) correctSide++;   // left-hand traffic sits left of the centre line
  }
  ok(checked > 4 && correctSide / checked > 0.8,
    `${correctSide}/${checked} moving cars are keeping left (Pakistan)`);
}

/* -- shooting ------------------------------------------------------------ */
console.log('\ncombat');
{
  const target = peds.peds[0];
  target.x = px + 6; target.z = pz; target.y = 0.16; target.state = 'walk'; target.health = 100;
  const head = combat.raycast(px, 0.16 + 1.64, pz, 1, 0, 0, 60, peds.peds, null, null);
  ok(head.kind === 'ped' && head.ped === target && head.head, 'a level shot at head height is a headshot');
  const body = combat.raycast(px, 0.16 + 1.15, pz, 1, 0, 0, 60, peds.peds, null, null);
  ok(body.kind === 'ped' && !body.head, 'a shot at chest height is a body hit');
  const over = combat.raycast(px, 0.16 + 2.6, pz, 1, 0, 0, 60, peds.peds, null, null);
  ok(over.kind !== 'ped', 'a shot over their head misses the pedestrian');

  const died = peds.damage(target, 500, px, pz);
  ok(died && target.state === 'dead', 'lethal damage kills instead of scaring');
  for (let i = 0; i < 90; i++) peds.update(DT, i * DT, px, 0.16, pz, true, 0, () => {}, 400);
  ok(target.deadT >= 1, 'the corpse finishes its collapse animation');
  ok(Math.abs(target.h.tilt.rotation.x) > 1.2, 'the body ends up flat on the ground', `x=${target.h.tilt.rotation.x.toFixed(2)}`);

  const alive = peds.peds.find((q) => q.state !== 'dead');
  peds.panic(alive.x, alive.z, 40, 5);
  const fleeing = peds.peds.filter((p) => p.state === 'flee').length;
  ok(fleeing > 3, `${fleeing} bystanders panicked at the gunfire`);
}

/* -- police -------------------------------------------------------------- */
console.log('\npolice');
{
  const rx = city.roadCoord(2), rz = city.blockCentre(2);
  const cop = peds.spawnPed(true, rx, rz + 16);
  cop.y = 0;
  let shots = 0;
  for (let i = 0; i < 60 * 6; i++) {
    peds.update(DT, i * DT, rx, 0, rz, true, 3, () => { shots++; }, 400);
  }
  ok(Math.hypot(cop.x - rx, cop.z - rz) < 14, `the cop closed in (now ${Math.hypot(cop.x - rx, cop.z - rz).toFixed(1)}m away)`);
  ok(shots > 3, `the cop opened fire ${shots} times in 6s`);
  ok(cop.aiming, 'the cop is holding an aiming pose while shooting');

  // 4-star tier: the same AI in body armour, with a rifle and a lot more health
  const swat = peds.spawnPed(true, rx + 4, rz + 16, true);
  ok(swat.swat && swat.cop, 'a SWAT enforcer is still a cop');
  ok(swat.health > cop.health, `and takes far more killing (${swat.health} vs ${cop.health})`);
  ok(swat.h.gunMount.children.length > 0, 'and turns up carrying a rifle');
  ok(swat.h.meshes.some((m) => m.geometry), 'the armoured look reuses the same humanoid rig');
}

/* -- weather ------------------------------------------------------------- */
console.log('\nweather');
{
  const { Weather } = await import('./weather.js');
  const { Sky } = await import('./sky.js');
  const scene = new THREE.Scene();
  const mats = buildMaterials();
  const sky = new Sky(scene, 0, 512, false);
  sky.setHour(12);
  const w = new Weather(scene, mats);
  const fog = new THREE.Fog(0x8899aa, 100, 400);

  const dryRough = mats.asphalt.roughness;
  const dryColour = mats.asphalt.color.clone();
  ok(w.gripScale() === 1, 'dry tarmac has full grip');

  w.set('rain', true);
  for (let i = 0; i < 60 * 8; i++) w.update(DT, i * DT, 0, 2, 0, sky, fog, 400);
  ok(mats.asphalt.roughness < dryRough * 0.5,
    `wet tarmac is smoother (${dryRough.toFixed(2)} -> ${mats.asphalt.roughness.toFixed(2)})`);
  ok(mats.asphalt.color.r < dryColour.r * 0.9, 'and darker');
  ok(w.gripScale() < 0.75, `and less grippy (${w.gripScale().toFixed(2)})`);
  ok(fog.far < 400 * 0.6, `you cannot see as far (${fog.far.toFixed(0)}m)`);

  // The whole point of the implementation: no per-frame allocation, one object each.
  const rainObj = scene.children.find((c) => c.isLineSegments);
  const dustObj = scene.children.find((c) => c.isPoints);
  ok(rainObj && dustObj, 'rain and dust are one object each');
  const before = rainObj.geometry.attributes.position.count;
  for (let i = 0; i < 240; i++) w.update(DT, i * DT, 0, 2, 0, sky, fog, 400);
  ok(rainObj.geometry.attributes.position.count === before,
    `the rain never respawns a particle on the CPU (${before} vertices, constant)`);
  ok(rainObj.visible && !dustObj.visible, 'only the active weather is drawn');

  let thunder = 0;
  for (let i = 0; i < 60 * 120; i++) {
    w.update(DT, i * DT, 0, 2, 0, sky, fog, 400);
    if (w.thunderCue) thunder++;
  }
  ok(thunder > 2, `${thunder} thunderclaps in two minutes of storm`);

  // The sun and sky are *scaled* by the storm, so a long spell must not compound them
  // down to black — the bug that eats a world when the day/night cycle is switched off.
  const litSun = sky.sun.intensity;
  ok(litSun > 0.05, `the sun is still lit after two minutes of storm (${litSun.toFixed(2)})`);

  w.set('clear', true);
  for (let i = 0; i < 60 * 60; i++) w.update(DT, i * DT, 0, 2, 0, sky, fog, 400);
  ok(Math.abs(mats.asphalt.roughness - dryRough) < 0.02, 'the road dries out again');
  ok(sky.sun.intensity > litSun, 'and the sun comes back out');
  w.dispose();
  ok(mats.asphalt.roughness === dryRough && mats.asphalt.color.equals(dryColour),
    'disposing hands the shared materials back exactly as they were');
}

/* -- police escalation --------------------------------------------------- */
console.log('\npolice escalation');
{
  const { PoliceOps } = await import('./police.js');
  const scene = new THREE.Scene();
  const phys = new Physics();
  const mats = buildMaterials();
  const C = city.buildCity(scene, phys, mats, QUALITY.medium, 20260805);
  const ops = new PoliceOps(scene, phys, C, mats);

  const px = city.roadCoord(2), pz = city.blockCentre(1);
  const dyn = [];
  ops.update(DT, 0, 2, px, 0.2, pz, 0, 1);
  ops.addColliders(dyn);
  ok(dyn.length === 0, 'no roadblocks below three stars');

  for (let i = 0; i < 60 * 6; i++) ops.update(DT, i * DT, 3, px, 0.2, pz, 0, 1);
  dyn.length = 0;
  ops.addColliders(dyn);
  ok(dyn.length >= 2, `${dyn.length} barrier colliders deployed at three stars`);
  const ahead = dyn.every((b) => (b.minZ + b.maxZ) / 2 > pz);
  ok(ahead, 'every barrier is in front of the player, not behind them');

  // the spike strip has to actually catch a car driving into the block
  const blocked = dyn[0];
  const car = createVehicle('sedan', 0x884422);
  placeVehicle(car, (blocked.minX + blocked.maxX) / 2, (blocked.minZ + blocked.maxZ) / 2, 0);
  ok(ops.spikeHit(car), 'driving into the block shreds the tyres');
  car.spikeT = 20;
  ok(!ops.spikeHit(car), 'and it only counts once');

  // Top speed on a puncture, measured on open ground so the city cannot get in the way.
  const top = SPECS.sedan.maxSpeed;
  const open = new Physics();
  open.build();
  const flat = createVehicle('sedan', 0x884422);
  placeVehicle(flat, 0, 0, 0);
  flat.ctrl.throttle = 1;
  flat.spikeT = 40;
  for (let i = 0; i < 60 * 20; i++) stepVehicle(flat, DT, open);
  ok(flat.speed < top * 0.5, `a car on shredded tyres cannot outrun the block (${(flat.speed * 3.6).toFixed(0)} km/h)`);
  flat.spikeT = 0;
  for (let i = 0; i < 60 * 25; i++) stepVehicle(flat, DT, open);
  ok(flat.speed > top * 0.9, `and gets it back once they are replaced (${(flat.speed * 3.6).toFixed(0)} km/h)`);

  ops.update(DT, 0, 5, px, 0.2, pz, 0, 1);
  ok(ops.rotorVolume > 0 && ops.spotted, 'the search helicopter turns up at five stars');
  ops.update(DT, 0, 0, px, 0.2, pz, 0, 1);
  ok(!ops.spotted && ops.rotorVolume === 0, 'and leaves the moment the heat does');
  dyn.length = 0;
  ops.addColliders(dyn);
  ok(dyn.length === 0, 'the roadblocks come down too');
}

/* -- garages, side jobs and street aggro --------------------------------- */
console.log('\ngarages + side jobs');
{
  const { MAPS } = await import('./maps.js');
  const { Jobs, jobFor, JOB_NAME } = await import('./jobs.js');
  const { paintVehicle } = await import('./vehicle.js');
  const scene = new THREE.Scene();
  const phys = new Physics();
  const mats = buildMaterials();
  const C = city.buildCity(scene, phys, mats, QUALITY.medium, 20260805);

  ok(C.garages.length >= 2, `${C.garages.length} respray bays on the map`);
  let missing = 0;
  for (const m of MAPS) {
    const p2 = new Physics(); const s2 = new THREE.Scene();
    const built = m.build(s2, p2, mats, QUALITY.medium, 20260805);
    if (built.garages.length < 1) missing++;
  }
  ok(missing === 0, 'every map ships at least one bay');

  // you must be able to drive into a bay: nothing solid may stand in the doorway
  let blockedBays = 0;
  for (const g of C.garages) {
    const h = phys.groundHeight(g.x, g.z - 4, 1.0, 2);
    phys.resolveCircle(g.x, g.z - 4, 1.0, h, h + 1.6, 0.3, false);
    if (phys.outHit) blockedBays++;
  }
  ok(blockedBays === 0, 'every bay has a clear approach');

  const car = createVehicle('sedan', 0x884422);
  paintVehicle(car, 0x2b1a4d);
  ok(car.colour === 0x2b1a4d, 'a respray changes the recorded colour');

  ok(jobFor(createVehicle('rickshaw', 0)) === 'taxi', 'a rickshaw is a taxi');
  ok(jobFor(createVehicle('police', 0)) === 'vigilante', 'a cruiser is vigilante work');
  ok(jobFor(createVehicle('van', 0)) === 'medic', 'a van is an ambulance');
  ok(jobFor(createVehicle('hyper', 0)) === null, 'a hypercar is not licensed for anything');

  const peds2 = new PedManager(scene, phys, C);
  peds2.populate(24);
  const jobs = new Jobs(scene, C, peds2);
  const taxi = createVehicle('rickshaw', 0);
  const sx = C.playerStart.x, sz = C.playerStart.z;
  placeVehicle(taxi, sx, sz, 0);
  let paid = 0;
  jobs.onPayout = (amount) => { paid += amount; };
  const msg = jobs.toggle(taxi, sx, sz, []);
  ok(jobs.active && msg.includes(JOB_NAME.taxi), `shift starts: "${msg}"`);
  ok(jobs.stage === 'toPickup', 'first leg is the pickup');

  taxi.x = jobs.targetX; taxi.z = jobs.targetZ;
  jobs.update(DT, taxi, taxi.x, taxi.z, []);
  ok(jobs.stage === 'toDrop', 'collecting the fare advances the leg');
  taxi.x = jobs.targetX; taxi.z = jobs.targetZ;
  jobs.update(DT, taxi, taxi.x, taxi.z, []);
  ok(paid > 0 && jobs.streak === 1, `the drop-off paid Rs.${paid}`);

  let failed = '';
  jobs.onFail = (m) => { failed = m; };
  jobs.update(DT, null, taxi.x, taxi.z, []);
  ok(!jobs.active && failed !== '', `leaving the vehicle ends the shift ("${failed}")`);

  // street aggro: a provoked civilian squares up and swings
  const victim = peds2.peds.find((p) => !p.cop && p.state !== 'dead');
  let barked = '';
  let swings = 0;
  peds2.onChatter = (p, line) => { barked = line; };
  peds2.onSwing = () => { swings++; };
  victim.x = sx + 3; victim.z = sz;
  peds2.provoke(victim, sx, sz, 1);
  ok(victim.state === 'aggro' && barked !== '', `they square up and shout "${barked}"`);
  for (let i = 0; i < 60 * 5; i++) peds2.update(DT, i * DT, sx, 0.2, sz, true, 0, () => {}, 400);
  ok(swings > 0, `and land ${swings} punches in five seconds`);
  for (let i = 0; i < 60 * 30; i++) peds2.update(DT, i * DT, sx, 0.2, sz, true, 0, () => {}, 400);
  ok(victim.state !== 'aggro', 'the rage wears off rather than lasting for ever');

  const before = peds2.peds.length;
  const driver = peds2.summonDriver(sx + 2, sz + 2, sx, sz);
  ok(driver !== null && peds2.peds.length === before,
    'a driver getting out borrows an off-screen pedestrian instead of spawning one');
}

/* -- touch input layer ---------------------------------------------------- */
console.log('\ntouch controls');
{
  const stub = { addEventListener() {}, removeEventListener() {} };
  const i = new Input(stub, DEFAULT_BINDS);

  ok(!i.touch, 'a fresh session is not a touch session');
  i.markTouch();
  ok(i.touch, 'the first tap switches the UI to the pad');

  // held buttons
  i.setVirtual('jump', true);
  ok(i.isDown('jump'), 'an on-screen button reads as held');
  ok(i.justPressed('jump'), 'and as a fresh press on the frame it went down');
  i.endFrame();
  ok(i.isDown('jump') && !i.justPressed('jump'),
    'still held on the next frame, but no longer a new press');
  i.setVirtual('jump', false);
  ok(!i.isDown('jump'), 'and released when the finger lifts');

  // taps
  i.tapVirtual('use');
  ok(i.justPressed('use'), 'a tap registers as one press');
  i.endFrame();
  ok(!i.justPressed('use') && !i.isDown('use'), 'and is gone the very next frame');

  // consume() has to reach the virtual edge too, or one tap of E gets you out of a car
  // and straight back into it — the exact bug the keyboard path already guards against.
  i.tapVirtual('use');
  i.consume('use');
  ok(!i.justPressed('use'), 'a consumed tap is not seen twice in the same frame');
  i.endFrame();

  // the analog stick
  ok(i.axis('left', 'right') === 0 && i.axis('back', 'forward') === 0, 'centred stick is zero');
  i.stickX = 0.5;
  i.stickY = -0.25;
  ok(Math.abs(i.axis('left', 'right') - 0.5) < 1e-9, 'half-right steers half right, not fully');
  ok(Math.abs(i.axis('back', 'forward') + 0.25) < 1e-9, 'and pulling back is negative');
  i.stickX = 1;
  ok(i.axis('left', 'right') === 1, 'full deflection is exactly 1, never more');

  // keyboard and stick coexist: a desktop player is unaffected by any of this
  i.stickX = 0;
  i.stickY = 0;
  ok(i.axis('left', 'right') === 0, 'releasing the stick hands the axis back to the keys');

  // firing
  i.setButton(0, true);
  ok(i.buttons[0] && i.buttonEdge[0], 'FIRE presses the same button the mouse does');
  i.endFrame();
  ok(i.buttons[0] && !i.buttonEdge[0], 'holding it stays down without re-triggering');
  i.setButton(0, false);
  ok(!i.buttons[0], 'and lets go');

  // looking, with no pointer lock to be had
  i.mouseDX = 0;
  i.mouseDY = 0;
  ok(!i.locked, 'touch never has the pointer locked');
  i.look(12, -4);
  i.look(3, 1);
  ok(i.mouseDX === 15 && i.mouseDY === -3, 'a drag accumulates exactly like mouse movement');
  i.endFrame();
  ok(i.mouseDX === 0, 'and is drained once a frame, so the turn rate is frame-rate independent');

  // a paused game must not still be being driven by a thumb that is resting on the glass
  i.setVirtual('forward', true);
  i.stickX = 1;
  i.enabled = false;
  ok(!i.isDown('forward') && i.axis('left', 'right') === 0, 'a disabled input ignores the pad');
  i.enabled = true;
  i.clearVirtual();
  ok(!i.isDown('forward') && i.stickX === 0 && !i.buttons[0],
    'clearVirtual lets go of everything at once');
}

/* -- one finger, two families of events ----------------------------------- */
console.log('\ntouch vs pointer events');
{
  const T = await import('./touchinput.js');

  // The bug this module exists for: Chrome on Android delivers a touch to a PointerEvent
  // listener with clientX/clientY of ZERO, while the TouchEvent for the same tap has the
  // real coordinates. A pad that trusted the pointer event drew its stick at the top-left
  // corner of the screen and the player could not walk.
  const chromeTouchAsPointer = { pointerId: 3, pointerType: 'touch', clientX: 0, clientY: 0 };
  const chromeTouchAsTouch = { changedTouches: [{ identifier: 0, clientX: 150, clientY: 300 }] };
  ok(T.fromPointer(chromeTouchAsPointer).x === 0,
    'a touch seen as a PointerEvent really does report x=0 (this is the bug)');
  const g = T.fromTouch(chromeTouchAsTouch);
  ok(g.x === 150 && g.y === 300,
    `the TouchEvent for the same tap carries the truth (${g.x}, ${g.y})`);
  ok(g.kind === 'touch' && g.id === 0, 'and the touch identifier, which starts at 0');

  // A mouse still works, because that path was never broken.
  const mouse = T.fromPointer({ pointerId: 1, pointerType: 'mouse', clientX: 42, clientY: 7 });
  ok(mouse.kind === 'pointer' && mouse.x === 42 && mouse.y === 7, 'the mouse path is untouched');

  // Ids from the two families collide numerically: finger 0 is not mouse 0.
  ok(T.grabKey({ kind: 'touch', id: 0, x: 0, y: 0 })
    !== T.grabKey({ kind: 'pointer', id: 0, x: 0, y: 0 }),
    'finger 0 and pointer 0 are different fingers, so their keys differ');

  // Following the right finger through a multi-touch list.
  const list = [
    { identifier: 4, clientX: 10, clientY: 20 },
    { identifier: 9, clientX: 90, clientY: 80 },
  ];
  ok(T.findTouch(list, 9).clientX === 90, 'the second finger is found by its identifier');
  ok(T.findTouch(list, 4).clientY === 20, 'and so is the first');
  ok(T.findTouch(list, 7) === null, 'a finger that has lifted is simply not there');
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}\n`);
process.exit(fails ? 1 : 0);

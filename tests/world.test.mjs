/* Headless smoke test: builds the whole city in Node with a stubbed canvas,
   then asserts the things the player complained about are actually true. */

/* ---------------- minimal DOM/canvas stub (three only stores canvases as texture images) ---------------- */
const { installCanvasStub } = await import('./stub-canvas.mjs');
installCanvasStub();
globalThis.window = globalThis;

const THREE = await import('three');
const { Physics, KIND } = await import('./physics.js');
const { buildMaterials, rippleNormal } = await import('./materials.js');
const city = await import('./city.js');
const scheme = await import('./scheme.js');
const { QUALITY } = await import('./settings.js');
const { createHumanoid } = await import('./humanoid.js');
const { createVehicle } = await import('./vehicle.js');
const { createWeaponModel } = await import('./weapons.js');

let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`  ok   ${msg}`);
  else { console.log(`  FAIL ${msg} ${extra}`); fails++; }
};

/* ---------------- 1. physics ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
console.log('\nphysics');
{
  const p = new Physics();
  p.addBox(0, -5, 1, 5, 0, 3, KIND.Building);        // wall
  p.addBox(-10, -10, 10, 10, 0, 0.16, KIND.Ground);  // pavement slab
  p.addBox(4, -1, 5, 1, 0, 0.4, KIND.Prop);          // low ledge
  p.build();

  p.resolveCircle(0.5, 0, 0.34, 0, 1.78, 0.45, false);
  ok(Math.abs(p.outX - -0.34) < 1e-6 || Math.abs(p.outX - 1.34) < 1e-6,
    'a body inside a wall is pushed out of it', `x=${p.outX.toFixed(3)}`);

  p.resolveCircle(-0.5, 0, 0.34, 0, 1.78, 0.45, false);
  ok(p.outX <= -0.34 + 1e-6, 'approaching from the left cannot enter the wall', `x=${p.outX.toFixed(3)}`);

  p.resolveCircle(4.5, 0, 0.34, 0, 1.78, 0.45, false);
  ok(!p.outHit, 'a 0.4m ledge does not block movement (step-up works)');

  ok(Math.abs(p.groundHeight(0, 0, 0.34, 2, false) - 0.16) === 0, 'stands on the pavement slab');
  ok(p.groundHeight(4.5, 0, 0.34, 2, false) === 0.4, 'stands on top of the ledge');
  ok(p.groundHeight(50, 50, 0.34, 2, false) === 0, 'falls back to ground level off-slab');

  const hit = p.raycast(-4, 1.5, 0, 1, 0, 0, 20, false);
  ok(hit && Math.abs(hit.t - 4) < 1e-6, 'ray hits the wall face at the right distance', `t=${hit?.t}`);
  ok(hit && hit.nx === -1, 'hit normal points back along the ray', `n=${hit?.nx}`);
  const miss = p.raycast(-4, 1.5, 20, 1, 0, 0, 20, false);
  ok(miss === null, 'ray past the wall misses');
  ok(p.segmentClear(-4, 1.5, 0, 4, 1.5, 0) < 1, 'line of sight is blocked through a wall');
  ok(p.segmentClear(-4, 1.5, 20, 4, 1.5, 20) === 1, 'line of sight is clear in the open');
}

/* ---------------- 2. characters, cars and guns actually merge ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
console.log('\nmodels');
{
  const h = createHumanoid({ skin: 0xf0c69a, shirt: 0xc94f4f, pants: 0x2f3a4a, hair: 0x24170f, shoes: 0x222222, scale: 1 });
  ok(h.meshes.length >= 10, `humanoid built from ${h.meshes.length} jointed parts`);
  ok(h.meshes.every((m) => m.geometry && m.geometry.attributes.position && m.geometry.attributes.color),
    'every body part merged with vertex colours');
  const joints = ['hips', 'chest', 'head', 'armL', 'armR', 'foreL', 'foreR', 'legL', 'legR', 'shinL', 'shinR'];
  ok(joints.every((j) => h[j] && h[j].isObject3D), 'has hips/chest/head/shoulders/elbows/hips/knees');
  // knees must hang below the hips, feet below the knees
  const kneeY = h.shinL.position.y, hipY = h.hips.position.y;
  ok(hipY > 0.85 && hipY < 1.0, `hip height is human (${hipY.toFixed(2)}m)`);
  ok(kneeY < -0.4, `knee sits below the hip (${kneeY.toFixed(2)}m)`);

  for (const kind of ['sedan', 'suv', 'van', 'sports', 'police', 'rickshaw', 'hatch']) {
    const v = createVehicle(kind, 0xb8342a);
    const body = v.bodyPivot.children[0];
    ok(body.geometry && body.geometry.attributes.position.count > 50, `${kind} body mesh built`);
    ok(v.wheelMeshes.length >= 3, `${kind} has wheels`);
    ok(v.wheelMeshes.filter((w) => w.front).length >= 1, `${kind} has steerable front wheels`);
  }

  for (const id of ['knife', 'sword', 'pistol', 'smg', 'ak47', 'shotgun', 'sniper', 'rpg', 'minigun']) {
    const w = createWeaponModel(id);
    ok(!!w && !!w.muzzle, `${id} model + muzzle point built`);
    const p = new THREE.Vector3();
    w.group.updateMatrixWorld(true);
    w.muzzle.getWorldPosition(p);
    ok(p.length() > 0.05, `${id} muzzle is out in front of the grip (${p.length().toFixed(2)}m)`);
  }
  ok(createWeaponModel('fists') === null, 'fists have no model');
}

/* ---------------- 3. the city -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
console.log('\ncity layout');
const phys = new Physics();
const scene = new THREE.Scene();
const mats = buildMaterials();
const t0 = Date.now();
const C = city.buildCity(scene, phys, mats, QUALITY.medium, 20260805);
console.log(`  (generated in ${Date.now() - t0}ms - ${Math.round(C.triangles / 1000)}k triangles, ${phys.boxes.length} colliders)`);

ok(C.nodes.length === city.N * city.N + 24, `road graph has ${C.nodes.length} intersections (36 city + 24 scheme)`);
ok(C.nodes.every((n) => n.nb.length >= 2), 'every intersection connects to its neighbours');
ok(C.pedLoops.length === (city.N - 1) * (city.N - 1) + 9,
  `${C.pedLoops.length} pedestrian routes (25 city blocks + 8 scheme kerbs + park)`);
ok(C.shops.length >= 6, `${C.shops.length} shop counters`);
ok(C.parkSpots.length >= 20, `${C.parkSpots.length} parking spots`);
ok(C.itemSpots.length >= 8, `${C.itemSpots.length} candidate objective spots`);
ok(C.pickupSpots.length >= 20, `${C.pickupSpots.length} pickup spots`);

// Road strips: the band each grid line owns.
const HR = city.ROADW / 2;
const strips = [];
for (let i = 0; i < city.N; i++) {
  const x = city.roadCoord(i);
  strips.push({ minX: x - HR, maxX: x + HR, minZ: city.roadCoord(0) - HR, maxZ: city.roadCoord(city.N - 1) + HR });
  strips.push({ minZ: x - HR, maxZ: x + HR, minX: city.roadCoord(0) - HR, maxX: city.roadCoord(city.N - 1) + HR });
}
const onRoad = (x, z, r = 0) => strips.some((s) => x + r > s.minX && x - r < s.maxX && z + r > s.minZ && z - r < s.maxZ);
const rectOnRoad = (b) => strips.some((s) => b.maxX > s.minX && b.minX < s.maxX && b.maxZ > s.minZ && b.minZ < s.maxZ);

const solid = phys.boxes.filter((b) => b.kind === KIND.Building || b.kind === KIND.Prop || b.kind === KIND.Fence);
const trespassers = solid.filter(rectOnRoad);
ok(trespassers.length === 0,
  `none of the ${solid.length} buildings/trees/lamps/walls overlap a road`,
  trespassers.length ? `first offender: ${JSON.stringify(trespassers[0])}` : '');

const badLoop = C.pedLoops.flat().filter((p) => onRoad(p.x, p.z, 0.4));
ok(badLoop.length === 0, 'no pedestrian waypoint sits on the tarmac', `${badLoop.length} bad`);

const badShop = C.shops.filter((s) => onRoad(s.x, s.z, 0.5));
ok(badShop.length === 0, 'no shop counter is in the road');

const badItem = C.itemSpots.filter((s) => onRoad(s.x, s.z, 0.4));
ok(badItem.length === 0, 'no objective spawns in the road');

const badPickup = C.pickupSpots.filter((s) => onRoad(s.x, s.z, 0.4));
ok(badPickup.length === 0, 'no pickup spawns in the road');

const badPark = C.parkSpots.filter((s) => onRoad(s.x, s.z, 1.2));
ok(badPark.length === 0, 'every parking spot is off the carriageway');

// traffic spawns, on the other hand, must be ON a road
ok(C.roadSpawns.length > 40 && C.roadSpawns.every((s) => onRoad(s.x, s.z)),
  `all ${C.roadSpawns.length} traffic spawns are on roads`);

// the player must start on solid ground, not inside a wall
const startGround = phys.groundHeight(C.playerStart.x, C.playerStart.z, 0.34, 3);
phys.resolveCircle(C.playerStart.x, C.playerStart.z, 0.34, startGround, startGround + 1.78, 0.45, false);
ok(!phys.outHit, 'player start position is not inside geometry');
ok(startGround > 0.1, `player starts on the pavement (y=${startGround})`);

// nothing should be floating: every collider must start at or below ground level
const floating = phys.boxes.filter((b) => b.bottom > 0.2);
ok(floating.length === 0, 'no collider floats above the ground', `${floating.length} floating`);

/* -- Rahim Garden housing scheme ----------------------------------------- */
console.log(`
rahim garden housing scheme`);
{
  const P = scheme.PLAN;
  ok(Math.abs(P.R30 - 9.144) < 0.01 && Math.abs(P.R50 - 15.24) < 0.01,
    `built to the plan road widths (30ft=${P.R30.toFixed(2)}m, 50ft=${P.R50.toFixed(2)}m)`);
  ok(Math.abs(P.PARK_W - 21.336) < 0.01, `central park is the plan 70ft (${P.PARK_W.toFixed(2)}m)`);
  ok(Math.abs(P.PLOT_W - 15.24) < 0.01, `plot frontage is the plan 50ft (${P.PLOT_W.toFixed(2)}m)`);

  const plots = C.minimap.buildings.filter((o) => o.z > 310);
  ok(plots.length > 110, `${plots.length} plots and civic buildings in the scheme`);

  // The scheme moved 100m south when the Grand Canal was widened to a real river.
  ok(C.bounds.maxZ > 600 && C.bounds.maxZ < 700, `world extends south to z=${C.bounds.maxZ.toFixed(0)}`);
  ok(C.bounds.minZ < -200, 'the city end of the world is unchanged');

  // the scheme has to be reachable: its entrances must link to city intersections
  const cityNodes = C.nodes.filter((n) => n.z <= 200);
  const schemeNodes = C.nodes.filter((n) => n.z > 300);
  const links = schemeNodes.filter((n) => n.nb.some((k) => cityNodes.includes(k)));
  ok(links.length === 4, `${links.length} scheme streets connect through to the city grid`);
  ok(schemeNodes.every((n) => n.nb.length >= 2), 'every scheme junction has at least two exits');

  // flood fill: traffic must be able to drive from the city into the scheme and back
  const seen = new Set([C.nodes[0]]);
  const queue = [C.nodes[0]];
  while (queue.length) {
    const n = queue.pop();
    for (const k of n.nb) if (!seen.has(k)) { seen.add(k); queue.push(k); }
  }
  ok(seen.size === C.nodes.length, `all ${C.nodes.length} junctions reachable from one another`);

  ok(C.playerStart.z > 210, 'the player now lives in Rahim Garden');
  const homeGround = phys.groundHeight(C.playerStart.x, C.playerStart.z, 0.34, 3);
  phys.resolveCircle(C.playerStart.x, C.playerStart.z, 0.34, homeGround, homeGround + 1.78, 0.45, false);
  ok(!phys.outHit, 'the home spawn is clear of walls and gate posts');
  ok(!onRoad(C.playerStart.x, C.playerStart.z), 'the home spawn is not in the street');
  ok(C.pois.some((q) => q.kind === 'gate'), 'the entrance gate is a map landmark');
  ok(C.pois.some((q) => q.name === 'RAHIM GARDEN PARK'), 'the central park is a map landmark');

  // an entry edge must carry the scheme street's width, not the city's 16m
  const entryWidths = [];
  for (const n of cityNodes) {
    for (let i = 0; i < n.nb.length; i++) {
      if (n.nb[i].z > 200) entryWidths.push(n.nbWidth[i]);
    }
  }
  ok(entryWidths.length === 4 && entryWidths.every((w) => w < 16),
    `entry lanes sized to the scheme streets (${entryWidths.map((w) => w.toFixed(1)).join(', ')}m)`);
}

/* -- the grand canal and its bridges -------------------------------------- */
console.log(`
grand canal + big pul`);
{
  const theme = await import('./theme.js');
  const W = theme.DEFAULT_THEME.water;

  ok(W.width >= 50, `the canal is ${W.width}m wide, not a gutter`);
  ok(phys.pits.length === 1 && phys.pits[0].bed <= -3,
    `the channel is a real hole in the world (bed y=${phys.pits[0]?.bed})`);
  ok(C.waterZones.length === 1 && C.waterZones[0].surface < 0,
    'the water surface sits below ground level, so it reads as a river');

  // The bug: bridge decks sat 23cm above the road that fed them, so every crossing was a
  // kerb you had to jump. Walk the ground height along each crossing centre line and
  // assert it never steps by more than a paint stripe.
  // Sampled down both lanes as well as the centre line, because a car drives in a lane.
  let worst = 0, worstAt = 0, worstX = 0;
  let fell = 0;
  for (const cx of W.crossings) {
    for (const lane of [-4, 0, 4]) {
      const x = cx + lane;
      let prev = null;
      for (let z = 180; z <= theme.SOUTH_TOP + 2; z += 0.5) {
        const g = phys.groundHeight(x, z, 0.9, 1.5, false);
        if (g < 0) fell++;
        if (prev !== null && Math.abs(g - prev) > worst) { worst = Math.abs(g - prev); worstAt = z; worstX = x; }
        prev = g;
      }
    }
  }
  ok(worst <= 0.03, `every bridge is flush with its approach road (worst step ${worst.toFixed(3)}m)`,
    worst > 0.03 ? `at x=${worstX}, z=${worstAt}` : '');
  ok(fell === 0, 'no gap in any deck drops a car into the canal');

  // ...but off the deck it very much is a hole.
  const mid = phys.groundHeight(0, W.z, 0.9, 1.5, false);
  ok(mid <= -3, `the channel floor is ${mid.toFixed(1)}m down between the bridges`);

  // and the banks are railed, so you cannot drive in by accident
  const rails = phys.boxes.filter((b) => b.kind === KIND.Fence
    && b.minZ > W.z - W.width / 2 - 3 && b.maxZ < W.z + W.width / 2 + 3
    && b.maxX - b.minX > 40);
  ok(rails.length >= 4, `${rails.length} embankment railings guard the towpaths`);

  // the traffic graph has to cross, or half the map is unreachable by car
  const northSide = C.nodes.filter((n) => n.z <= 200);
  const crossers = northSide.filter((n) => n.nb.some((k) => k.z > 300));
  ok(crossers.length === W.crossings.length,
    `${crossers.length} of the ${W.crossings.length} bridges carry the road graph across`);
}

/* -- every map builds ------------------------------------------------------ */
console.log(`
map roster`);
{
  const { MAPS } = await import('./maps.js');
  ok(MAPS.length === 4, `${MAPS.length} maps on the picker`);
  ok(new Set(MAPS.map((m) => m.id)).size === MAPS.length, 'map ids are unique');

  for (const m of MAPS) {
    const p2 = new Physics();
    const s2 = new THREE.Scene();
    const built = m.build(s2, p2, mats, QUALITY.medium, 20260805);
    const start = p2.groundHeight(built.playerStart.x, built.playerStart.z, 0.34, 3);
    p2.resolveCircle(built.playerStart.x, built.playerStart.z, 0.34, start, start + 1.78, 0.45, false);
    ok(!p2.outHit && start > 0.1 && built.nodes.length > 30 && built.shops.length >= 4
      && built.itemSpots.length >= 8 && built.pickupSpots.length >= 20,
      `${m.name}: ${Math.round(built.triangles / 1000)}k tris, ${built.nodes.length} junctions, `
      + `${built.shops.length} shops, spawn clear at y=${start.toFixed(2)}`);

    // flood fill: no map may ship with an island you cannot drive to
    const seen = new Set([built.nodes[0]]);
    const q = [built.nodes[0]];
    while (q.length) {
      for (const nb of q.pop().nb) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
    }
    ok(seen.size === built.nodes.length,
      `${m.name}: all ${built.nodes.length} junctions reachable from one another`,
      `${built.nodes.length - seen.size} stranded`);
  }
}

/* -- look and feel ------------------------------------------------------------
   The visual pass has to stay free: baked into vertex colours and textures, with
   no extra render passes. These assert it is actually there and actually varies.  */
console.log(`
look and feel (must cost nothing at runtime)`);
{
  // 1. baked ambient occlusion, written into the merged geometry's vertex colours
  let withColour = 0, lo = 1, hi = 0, samples = 0;
  C.root.traverse((o) => {
    const g = o.geometry;
    if (!g || !g.attributes || !g.attributes.color) return;
    withColour++;
    const col = g.attributes.color;
    const step = Math.max(1, Math.floor(col.count / 4000));
    for (let i = 0; i < col.count; i += step) {
      const v = col.getX(i);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      samples++;
    }
  });
  ok(withColour >= 8, `${withColour} merged meshes carry baked AO in vertex colours`);
  ok(hi > 0.93, `open surfaces stay bright (max ${hi.toFixed(2)})`);
  ok(lo < 0.72, `enclosed corners and undersides go dark (min ${lo.toFixed(2)})`);
  ok(samples > 3000, `${samples} vertices sampled`);

  // 2. normal maps derived from the albedo, and not degenerate
  const flatish = (t) => {
    const d = t.image.getContext('2d').getImageData(0, 0, t.image.width, t.image.height).data;
    let maxDev = 0;
    for (let i = 0; i < d.length; i += 4) {
      maxDev = Math.max(maxDev, Math.abs(d[i] - 128), Math.abs(d[i + 1] - 128));
    }
    return maxDev;
  };
  ok(!!mats.brick.normalMap, 'brick has a derived normal map');
  ok(!!mats.concrete.normalMap && !!mats.asphalt.normalMap, 'concrete and asphalt too');
  ok(flatish(mats.brick.normalMap) > 12, `the brick normal map has real relief (deviation ${flatish(mats.brick.normalMap)})`);
  ok(mats.brick.vertexColors === true, 'static materials read the baked AO');

  // 3. water: one pass, two texture samples, no reflection render
  ok(mats.water.type === 'ShaderMaterial', 'water is a single-pass custom shader');
  ok(!!mats.water.uniforms.uRipple.value, 'water has its procedural ripple normal map');
  ok(mats.water.fragmentShader.includes('cameraPosition'), 'water computes a real Fresnel term');
  ok(!mats.water.fragmentShader.includes('reflectionTexture'), 'water does NOT render the scene twice');
  const rip = rippleNormal();
  ok(flatish(rip) > 20, `the ripple map has slope (deviation ${flatish(rip)})`);

  // 4. wind: a vertex-shader hook on the already-merged foliage mesh
  ok(typeof mats.foliage.onBeforeCompile === 'function', 'foliage has a wind hook');
  const fake = { uniforms: {}, vertexShader: '#include <begin_vertex>' };
  mats.foliage.onBeforeCompile(fake);
  ok(!!fake.uniforms.uTime, 'the wind hook installs a time uniform');
  ok(fake.vertexShader.includes('swayAmt'), 'the wind hook injects sway into the vertex shader');
  ok(fake.vertexShader.includes('smoothstep(1.1, 4.2'), 'sway ramps in with height so trunks stay still');
}

/* -- Pakistani character -------------------------------------------------- */
console.log(`
pakistani character`);
{
  const { createVehicle, SPECS } = await import('./vehicle.js');
  const { tex } = await import('./materials.js');

  // the jingle truck
  const truck = createVehicle('truck', 0x1f7ae0);
  ok(SPECS.truck.name === 'BEDFORD TRUCK', 'the Bedford is a vehicle class');
  const wheels = truck.wheelMeshes.length;
  ok(wheels === 6, `the truck runs six wheels, two of them steering (${wheels})`);
  ok(truck.wheelMeshes.filter((w) => w.front).length === 2, 'front axle steers, rear four do not');
  ok(SPECS.truck.halfL * 2 > 8, `it is ${(SPECS.truck.halfL * 2).toFixed(1)}m long`);
  ok(SPECS.truck.maxSpeed * 3.6 < 100, `and slow with it (${(SPECS.truck.maxSpeed * 3.6).toFixed(0)} km/h)`);
  // painted panels use a texture, not a flat colour
  const painted = [];
  truck.group.traverse((o) => { if (o.material && o.material.map) painted.push(o); });
  ok(painted.length >= 5, `${painted.length} painted panels carry truck art`);

  // truck art must actually be colourful, not a grey box
  const art = tex.truckArt();
  const d = art.image.getContext('2d').getImageData(0, 0, art.image.width, art.image.height).data;
  const hues = new Set();
  let saturated = 0;
  for (let k = 0; k < d.length; k += 4 * 97) {
    const r = d[k], g = d[k + 1], b = d[k + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn > 60) { saturated++; hues.add(Math.round(Math.atan2(g - b, r - g) * 4)); }
  }
  ok(saturated > 40, `truck art is genuinely colourful (${saturated} saturated samples)`);
  ok(hues.size >= 4, `and uses ${hues.size} different hue families`);

  // overhead cables and street furniture, and none of it in the carriageway
  const props = phys.boxes.filter((b) => b.kind === KIND.Prop);
  ok(props.length > 700, `${props.length} props including poles, charpais and stalls`);
  const propsOnRoad = props.filter((b) => onRoad((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, 0.3));
  ok(propsOnRoad.length === 0, 'no pole, charpai or tandoor stands in the road', `${propsOnRoad.length} offenders`);

  // shop names should read like a Pakistani bazaar
  const names = C.shops.map((sh) => sh.name).join(' ');
  const local = ['KIRYANA', 'TANDOOR', 'CHAI', 'BIRYANI', 'EASYLOAD', 'PUNCTURE', 'SABZI', 'SWEETS'];
  const found = local.filter((w) => names.includes(w));
  ok(found.length >= 4, `bazaar signage is local: ${found.join(', ')}`);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}\n`);
process.exit(fails ? 1 : 0);



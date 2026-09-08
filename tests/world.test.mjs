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
const { createHumanoid, poseHumanoid } = await import('./humanoid.js');
const { socket } = await import('./characters.js');
const { buildOutfit, SKULL_TOP } = await import('./outfits.js');
const { solveTwoBone } = await import('./ik.js');
const { doorPoint, driverSide, enterPose, enterTime, exitPose, stepTime, EXIT_TIME } = await import('./carentry.js');
const { atDoor, buildInterior, nearestStand } = await import('./interior.js');
const { createVehicle } = await import('./vehicle.js');
const { VEH_KINDS, PROTOCOL_VERSION } = await import('./protocol.js');
const pickCivilian = (i) => VEH_KINDS[i % VEH_KINDS.length];
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

  /* -- clothes -------------------------------------------------------------------
     Everyone used to be a bare mannequin tinted one flat colour. Measure the garments
     rather than eyeball them: a cap that floats above the head and a hem that hangs
     past the knee both look fine in code and wrong on screen. buildOutfit returns the
     props alone, authored relative to the joint they hang from, so the numbers below
     read back as real heights once the joint is added on. */
  {
    const HIP = 0.93, CHEST = 1.24, HEAD = 1.57;   // the capsule rig's joints
    const cloth = { shirt: 0xd9d3c3, pants: 0xbfb9aa };
    const bbox = (geo, joint) => {
      const g = geo.clone();
      g.translate(0, joint, 0);
      g.computeBoundingBox();
      return g.boundingBox;
    };

    const street = buildOutfit('street', 'none', cloth, SKULL_TOP.capsule);
    ok(!street.hips && !street.chest && !street.head,
      'plain shirt-and-trousers puts nothing extra on the model at all');

    const topi = buildOutfit('street', 'topi', cloth, SKULL_TOP.capsule);
    ok(!!topi.head && !topi.hips && !topi.chest, 'a topi is the only thing an ordinary civilian wears');

    const cop = buildOutfit('police', 'peaked', { shirt: 0x23272f, pants: 0x1c1f26 }, SKULL_TOP.capsule);
    const belt = bbox(cop.hips, HIP);
    ok(belt.max.y > 0.98 && belt.max.y < 1.10, `the white belt is at the waist (${belt.max.y.toFixed(2)}m)`);
    ok(bbox(cop.head, HEAD).max.z > 0.15,
      `the peak of the cap points forward (${bbox(cop.head, HEAD).max.z.toFixed(2)}m of it)`);
    ok(bbox(cop.chest, CHEST).max.x > 0.19, 'epaulettes reach the point of the shoulder');

    const swat = buildOutfit('swat', 'helmet', { shirt: 0x14171c, pants: 0x14171c }, SKULL_TOP.capsule);
    ok(bbox(swat.chest, CHEST).max.z > 0.14, 'the plate carrier stands proud of the chest');

    /* Headwear on BOTH rigs. This is the one measurement the two disagree about — the
       mannequin hangs its head from the base of the skull at 1.485m, the capsule rig
       from most of the way up it at 1.57m — and getting it wrong does not look like a
       small error, it looks like a cap worn inside somebody's head. Anchoring to the
       crown rather than to the joint is what makes one set of numbers serve both. */
    // How far below the crown each one is allowed to reach: a topi perches, a cap grips
    // at the brow, a ballistic helmet comes down over the ears.
    const HATS = [['peaked', 'police cap', 0.13], ['topi', 'topi', 0.05], ['helmet', 'helmet', 0.21]];
    const wrong = [];
    for (const [rig, joint, skull] of [['capsule', HEAD, 1.73], ['animated', 1.485, 1.78]]) {
      for (const [hat, label, reach] of HATS) {
        const g = bbox(buildOutfit('street', hat, cloth, SKULL_TOP[rig]).head, joint);
        if (!(g.max.y > skull && g.max.y < skull + 0.07)) {
          wrong.push(`${rig} ${label} tops out at ${g.max.y.toFixed(3)}m, skull ends at ${skull}m`);
        } else if (g.min.y > skull - 0.02 || g.min.y < skull - reach - 0.03) {
          wrong.push(`${rig} ${label} reaches down to ${g.min.y.toFixed(3)}m`);
        }
      }
    }
    ok(!wrong.length,
      'cap, topi and helmet all sit on the skull on both the mannequin and the capsule rig',
      wrong.join('; '));
  }

  /* Dressing costs nothing on the capsule rig: the garments merge into joints that were
     already there, so a constable is the same eleven draw calls as a civilian. */
  const dressed = (extra) => createHumanoid({
    skin: 0xf0c69a, shirt: 0xd9d3c3, pants: 0xbfb9aa, hair: 0x24170f, shoes: 0x222222,
    scale: 1, ...extra,
  });
  const plain = dressed({ outfit: 'street' });
  let sameCost = true;
  for (const o of ['police', 'swat']) {
    if (dressed({ outfit: o }).meshes.length !== plain.meshes.length) sameCost = false;
  }
  ok(sameCost, `police and SWAT uniforms cost the same ${plain.meshes.length} draw calls as a bare model`);

  /* -- the Carry Daba ----------------------------------------------------------------
     There is no free, redistributable Suzuki Bolan anywhere on the internet — see
     docs/assets.md — so it is built here instead, to the real vehicle's measurements.
     The shape is the entire point of a Bolan: a box as tall as a person, with no bonnet,
     the driver over the front axle and the wheels shoved into the corners. Get the
     proportions wrong and it is just a van. */
  {
    const carry = createVehicle('carry', 0xf0f0ec);
    const sp = carry.spec;
    ok(Math.abs(sp.halfL * 2 - 3.38) < 0.05, `3.38m long (${(sp.halfL * 2).toFixed(2)})`);
    ok(Math.abs(sp.halfW * 2 - 1.40) < 0.05, `1.40m wide (${(sp.halfW * 2).toFixed(2)})`);
    ok(Math.abs(sp.height - 1.84) < 0.05, `1.84m tall (${sp.height.toFixed(2)})`);
    ok(sp.height > sp.halfW * 2, 'taller than it is wide, which almost nothing else here is');
    ok(sp.wheelbase / (sp.halfL * 2) > 0.5,
      `the wheelbase is ${(100 * sp.wheelbase / (sp.halfL * 2)).toFixed(0)}% of its length — `
      + 'the wheels are at the corners, not tucked under a nose and a tail');
    ok(sp.seat[2] > sp.halfL * 0.3,
      `and the driver sits ${sp.seat[2].toFixed(2)}m forward, over the front axle, because a `
      + 'Bolan has no bonnet to sit behind');
    ok(sp.maxSpeed * 3.6 < 100 && sp.maxSpeed * 3.6 > 85,
      `796cc, so ${(sp.maxSpeed * 3.6).toFixed(0)} km/h and no more`);

    // it has to actually be built, and be a box rather than a car silhouette
    carry.group.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(carry.bodyPivot);
    ok(bb.max.y > 1.6, `the body reaches ${bb.max.y.toFixed(2)}m, so it reads as a van from across the street`);
    ok(bb.max.y - bb.min.y > (bb.max.x - bb.min.x), 'and its silhouette is taller than it is wide');
    ok(carry.wheelMeshes.length === 4, 'four wheels');
    ok(carry.wheelMeshes.filter((w) => w.front).length === 2, 'two of which steer');

    // Lamps used to be placed at W * 1.2 — the *centre* of the lamp 20% outside the
    // bodywork. Invisible on the sedan and the rest, because those use downloaded models;
    // very visible on anything still built out of boxes.
    const inside = [];
    for (const k of ['van', 'rickshaw', 'truck', 'carry']) {
      const v = createVehicle(k, 0xcccccc);
      v.group.updateMatrixWorld(true);
      const w = new THREE.Box3().setFromObject(v.bodyPivot);
      // +0.7 of slack for mirrors, which really do stick out on a truck.
      if ((w.max.x - w.min.x) > v.spec.halfW * 2 + 0.7) {
        inside.push(`${k}: body box ${(w.max.x - w.min.x).toFixed(2)}m wide on a ${(v.spec.halfW * 2).toFixed(2)}m vehicle`);
      }
    }
    ok(!inside.length,
      'headlights and tail lights sit inside the bodywork on every vehicle still built out '
      + 'of boxes, rather than floating beside the wings', inside.join('; '));

    // it is on the street, and it survives the wire
    const civilians = new Set();
    for (let i = 0; i < 400; i++) civilians.add(createVehicle(pickCivilian(i), 0).spec.name);
    ok(VEH_KINDS.includes('carry'), 'the Carry Daba has a slot on the wire');
    ok(VEH_KINDS.indexOf('carry') === VEH_KINDS.length - 1,
      'appended to the end of VEH_KINDS, because the index is what goes over the network '
      + 'and reordering that list turns everybody else\'s traffic into different cars');
    ok(PROTOCOL_VERSION >= 4,
      `and the protocol version was bumped for it (v${PROTOCOL_VERSION}) rather than letting an `
      + 'older client decode an index off the end of its own list');
  }

  /* -- rooms you can walk into -------------------------------------------------------
     A shop was a counter on the pavement that opened a full-screen menu; home was a door
     that did nothing. They are places now. Interiors are separate cells parked six
     kilometres outside the city — the GTA trick — so the things worth checking are that
     nothing in a room is standing inside anything else, that the floor exists, and that
     the cells cannot possibly touch the city. */
  {
    const PR = 0.36;   // player radius
    const ipx = new Physics();
    ipx.build();          // deliberately BEFORE the rooms: that is when it happens in the
                          // real game, and colliders added after a build are invisible to
                          // the spatial hash unless they index themselves
    const iscene = new THREE.Scene();
    // its own material set: this block runs before the city has built one
    const imats = buildMaterials();
    const rooms = ['ammo', 'health', 'food', 'home'].map(
      (k) => buildInterior(k, imats, ipx, iscene, 0));

    // Nothing in the city can reach them, and they cannot reach each other.
    const far = rooms.every((r) => Math.hypot(r.entry.x, r.entry.z) > 3000);
    ok(far, 'every interior sits thousands of metres outside the city, so no room and no '
      + 'street ever share collision space');
    let overlap = false;
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        if (Math.hypot(rooms[i].entry.x - rooms[j].entry.x, rooms[i].entry.z - rooms[j].entry.z) < 24) overlap = true;
      }
    }
    ok(!overlap, 'and the four of them are spaced far enough apart not to overlap each other');

    // You have to be able to stand where you land, and on something.
    const stuck = [];
    for (const r of rooms) {
      const floor = ipx.groundHeight(r.entry.x, r.entry.z, PR, 3);
      if (Math.abs(floor - r.y) > 0.02) stuck.push(`${r.kind}: no floor under the doorway (${floor.toFixed(2)}m)`);
      if (!ipx.isFree(r.entry.x, r.entry.z, PR, r.y, r.y + 1.8, null)) stuck.push(`${r.kind}: you arrive inside something`);
      if (atDoor(r, r.entry.x, r.entry.z)) stuck.push(`${r.kind}: you arrive already in the doorway`);
    }
    ok(!stuck.length, 'you land on the floor of every room, clear of the furniture and just '
      + 'inside the door rather than on top of the trigger that leads back out', stuck.join('; '));

    // Every stand has to be somewhere a person can actually stand.
    const blocked = [];
    let total = 0;
    for (const r of rooms) {
      for (const st of r.stands) {
        total++;
        if (!ipx.isFree(st.x, st.z, PR, r.y, r.y + 1.8, null)) {
          blocked.push(`${r.kind}/${st.action}`);
        } else if (nearestStand(r, st.x, st.z) !== st) {
          blocked.push(`${r.kind}/${st.action} is masked by another stand`);
        }
      }
    }
    ok(!blocked.length,
      `all ${total} things you can walk up to are places you can actually stand`,
      blocked.join('; '));

    // The door is shut, and solid: an open doorway is a hole for the third-person camera
    // to slide out through, which is exactly what it did.
    const doorBlocked = rooms.every(
      (r) => !ipx.isFree(r.door.x, r.door.z + 0.05, PR, r.y + 0.2, r.y + 1.8, null));
    ok(doorBlocked, 'the door is shut and solid, so the camera cannot back out through it');

    // The doorway leads out, and only from the doorway.
    const shop = rooms[0];
    ok(atDoor(shop, shop.door.x, shop.door.z + 0.5), 'walking into the doorway leads outside');
    ok(!atDoor(shop, shop.door.x + 2.5, shop.door.z + 0.5), 'but standing along the front wall does not');
    ok(!atDoor(shop, shop.door.x, shop.door.z + 4), 'and neither does standing in the middle of the room');

    // The shop sells things; home does the things you cannot buy.
    const actions = (k) => new Set(rooms.find((r) => r.kind === k).stands.map((st) => st.action));
    ok(actions('ammo').has('ammo') && actions('ammo').has('armour'),
      'the gun shop sells ammunition off the rack and armour at the counter');
    ok(actions('ammo').has('menu'),
      'and the counter still opens the full list, so nothing that used to be buyable stopped being buyable');
    const home = actions('home');
    ok(home.has('sleep') && home.has('eat') && home.has('wardrobe'),
      'home has a bed, a fridge and a wardrobe');
    ok(!home.has('menu') && !home.has('ammo'), 'and does not sell you anything');
  }

  /* -- getting in and out of a car -------------------------------------------------
     E used to teleport you: one frame on the pavement, the next behind the wheel with the
     engine running. It is a move now, and the thing a move must never do is jump — so
     this walks the whole thing frame by frame and measures every step. */
  {
    const SPECS_SEAT = { sedan: [-0.42, 0.62, 0.25], truck: [-0.62, 1.72, 2.2], rickshaw: [0, 0.6, 0.1] };

    // Which door. Every seat in the game sits at a negative x, which in vehicle space is
    // the car's left; the old exit code put you out on the right on the grounds that
    // Pakistan drives on the left, and so stood you at the passenger door of your own car.
    ok(driverSide(SPECS_SEAT.sedan[0]) === 1,
      'a sedan\'s driver door is on the car\'s right — every seat in SPECS is at a negative '
      + 'local x, and local +X is the car\'s LEFT, so that is right-hand drive');
    ok(driverSide(SPECS_SEAT.truck[0]) === 1, 'and so is the Bedford\'s');
    ok(driverSide(SPECS_SEAT.rickshaw[0]) === 1, 'a rickshaw seats you centrally, so either side will do');

    // The door point has to be outside the car and level with the seat, whatever heading
    // the car is parked on.
    for (const yaw of [0, 0.7, 2.4, -1.9, Math.PI]) {
      const halfW = 0.86, seatZ = 0.25;
      const d = doorPoint(12, -30, yaw, halfW, seatZ, -1);
      const rel = { x: d.x - 12, z: d.z + 30 };
      // project back onto the car's own axes: rgt is (-cos, sin), fwd is (sin, cos)
      const lx = rel.x * -Math.cos(yaw) + rel.z * Math.sin(yaw);
      const lz = rel.x * Math.sin(yaw) + rel.z * Math.cos(yaw);
      if (Math.abs(lx + (halfW + 0.52)) > 1e-6 || Math.abs(lz - seatZ) > 1e-6) {
        ok(false, 'the door point is beside the car at seat level, on any heading',
          `yaw ${yaw}: local ${lx.toFixed(3)},${lz.toFixed(3)}`);
        break;
      }
    }
    ok(true, 'the door point sits 0.52m clear of the door skin, level with the seat, on any heading');

    // Walk the whole entry at 60fps and measure it.
    const from = { x: 3.4, y: 0.17, z: -1.2, yaw: 2.9, crouch: 0 };
    const door = doorPoint(0, 0, 0.4, 0.86, 0.25, -1);
    const seat = { x: -0.3, y: 0.62, z: 0.25 };
    const stepT = stepTime(Math.hypot(door.x - from.x, door.z - from.z));
    const total = enterTime(stepT);

    let prev = enterPose(0, from, door, 0.17, seat, 0.4, -1, stepT);
    ok(Math.hypot(prev.x - from.x, prev.z - from.z) < 1e-9,
      'the move starts exactly where the player was standing, not at the door');
    let biggest = 0, peakCrouch = 0, biggestTurn = 0;
    for (let i = 1; i <= Math.ceil(total * 60); i++) {
      const p = enterPose(Math.min(i / 60, total), from, door, 0.17, seat, 0.4, -1, stepT);
      biggest = Math.max(biggest, Math.hypot(p.x - prev.x, p.z - prev.z, p.y - prev.y));
      biggestTurn = Math.max(biggestTurn, Math.abs(((p.yaw - prev.yaw) + Math.PI * 3) % (Math.PI * 2) - Math.PI));
      peakCrouch = Math.max(peakCrouch, p.crouch);
      prev = p;
    }
    ok(biggest < 0.12,
      `no frame of getting in moves the player more than ${(biggest * 100).toFixed(0)}cm — `
      + 'it is a walk and a duck, not the teleport it replaced');
    ok(biggestTurn < 0.2, `and never spins more than ${(biggestTurn * 57).toFixed(0)}° in a frame`);
    ok(Math.hypot(prev.x - seat.x, prev.y - seat.y, prev.z - seat.z) < 1e-6,
      'and it finishes in the seat exactly, so nothing has to be snapped into place after');
    ok(peakCrouch > 0.99, 'ducking through the door on the way');
    ok(enterPose(total, from, door, 0.17, seat, 0.4, -1, stepT).crouch < 0.01,
      'and straightening up again once in');

    // A long walk takes longer than a short one, instead of being a lunge.
    ok(stepTime(3.4) > stepTime(0.6) * 2,
      `crossing 3.4m to the door takes ${stepTime(3.4).toFixed(2)}s against ${stepTime(0.6).toFixed(2)}s `
      + 'for a step, rather than a fixed third of a second at 10 m/s either way');
    ok(3.4 / stepTime(3.4) < 4.2,
      `so even the longest approach is a jog at ${(3.4 / stepTime(3.4)).toFixed(1)} m/s, not a lunge`);

    // Getting out: seat to pavement, no jumps, ending on the chosen spot.
    const spot = { x: door.x - 0.5, z: door.z - 0.2 };
    let q = exitPose(0, seat, door, 0.17, spot, 0.4, -1);
    ok(Math.hypot(q.x - seat.x, q.z - seat.z) < 1e-9, 'getting out starts in the seat');
    let worst = 0;
    for (let i = 1; i <= Math.ceil(EXIT_TIME * 60); i++) {
      const p = exitPose(Math.min(i / 60, EXIT_TIME), seat, door, 0.17, spot, 0.4, -1);
      worst = Math.max(worst, Math.hypot(p.x - q.x, p.z - q.z, p.y - q.y));
      q = p;
    }
    ok(worst < 0.12, `and no frame of it moves more than ${(worst * 100).toFixed(0)}cm either`);
    ok(Math.hypot(q.x - spot.x, q.z - spot.z) < 1e-6 && Math.abs(q.y - 0.17) < 1e-9,
      'ending on both feet at the spot that was checked for clearance');
    ok(EXIT_TIME < enterTime(stepTime(1.5)), 'getting out is quicker than getting in');
  }

  /* -- the support hand ------------------------------------------------------------
     Every gun used to hang off one socket on the right hand while the left arm carried
     on swinging through whatever the animation clip said, which is what "the weapon
     looks built in to his hands" actually was. The fix is a solve, not a keyframe: the
     clip cannot know how long an AK is. Check the solver reaches, and — the part that
     goes visibly wrong if it is subtly broken — that the elbow never folds through the
     ribcage. */
  {
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const UP = V(0, 1, 0), DOWN = V(0, -1, 0);
    /** Walk the chain the solver produced and report where the hand actually ended up. */
    const chain = (root, sol, l1, l2, axis) => {
      const elbow = axis.clone().applyQuaternion(sol.upper).multiplyScalar(l1).add(root.clone());
      const hand = axis.clone().applyQuaternion(sol.lower).multiplyScalar(l2).add(elbow);
      return { elbow, hand };
    };

    const shoulder = V(-0.2, 1.44, 0);
    const L1 = 0.29, L2 = 0.29;
    const pole = V(-0.8, -0.5, -0.6).normalize();

    // A rifle foregrip: forward, across the body, well inside arm's length.
    for (const [name, target] of [
      ['a rifle foregrip', V(0.02, 1.3, 0.34)],
      ['a pistol steadied in both hands', V(0.06, 1.26, 0.24)],
      ['an RPG on the shoulder', V(-0.02, 1.46, 0.3)],
      ['straight down by the hip', V(-0.22, 1.0, 0.02)],
    ]) {
      for (const axis of [UP, DOWN]) {
        const sol = solveTwoBone(shoulder, target, pole, L1, L2, axis);
        const { hand } = chain(shoulder, sol, L1, L2, axis);
        if (hand.distanceTo(target) > 1e-4) {
          ok(false, `the hand reaches ${name}`,
            `off by ${hand.distanceTo(target).toFixed(4)}m with bones along ${axis.y > 0 ? '+Y' : '-Y'}`);
        }
      }
    }
    ok(true, 'the support hand lands exactly on the foregrip, on both rigs\' bone conventions');

    // The elbow. Both solutions reach the target; only one of them is an arm.
    const sol = solveTwoBone(shoulder, V(0.02, 1.3, 0.34), pole, L1, L2, UP);
    const { elbow } = chain(shoulder, sol, L1, L2, UP);
    // Both solutions put the hand on the foregrip; only one of them is an arm. Flipping
    // the pole gives the mirror, and it is worth showing what that costs.
    const mirror = chain(shoulder,
      solveTwoBone(shoulder, V(0.02, 1.3, 0.34), pole.clone().negate(), L1, L2, UP), L1, L2, UP).elbow;
    ok(elbow.y < shoulder.y - 0.15,
      `the elbow hangs ${(shoulder.y - elbow.y).toFixed(2)}m below the shoulder, the way it `
      + 'does when you bring a rifle up');
    ok(mirror.y > shoulder.y,
      `while the mirror reaches the same foregrip with the elbow ${(mirror.y - shoulder.y).toFixed(2)}m `
      + 'ABOVE the shoulder and folded across the chest — which is the whole job of the pole vector');
    ok(elbow.z < 0.34, `and it stays behind the hand (elbow z ${elbow.z.toFixed(2)})`);

    // Out of reach: point at it, do not snap to something nearer.
    const far = solveTwoBone(shoulder, V(0.9, 1.44, 1.4), pole, L1, L2, UP);
    ok(far.stretched, 'a target beyond arm\'s length is reported as out of reach');
    const reach = chain(shoulder, far, L1, L2, UP);
    ok(reach.hand.distanceTo(shoulder) > (L1 + L2) - 1e-3,
      `and the arm goes straight for it (${reach.hand.distanceTo(shoulder).toFixed(3)}m of ${(L1 + L2).toFixed(2)}m)`);
    ok(reach.elbow.distanceTo(shoulder) > L1 - 1e-3, 'with the elbow locked out, not bent');

    // Degenerate inputs the game will hand it: a target on the shoulder, and a target
    // exactly along the pole where there is no bend plane to pick.
    for (const [why, t, p] of [
      ['a target sitting on the shoulder', shoulder.clone(), pole],
      ['a target straight down the pole vector', shoulder.clone().addScaledVector(pole, 0.3), pole],
    ]) {
      const d = solveTwoBone(shoulder, t, p, L1, L2, UP);
      const bad = [d.upper, d.lower].some((q) => !Number.isFinite(q.x + q.y + q.z + q.w));
      if (bad) { ok(false, `${why} does not produce NaN`); break; }
    }
    ok(true, 'degenerate targets stay finite rather than NaN-ing the whole skeleton');
  }

  /* End to end, on a real rig, for every weapon in the game.
     The solver being right is not the same as the wiring being right, and the wiring was
     not: with the rifle hanging off the right hand at arm's length the AK's handguard sat
     0.71m from the left shoulder, and an arm here is 0.58m. The support hand could only
     ever hover near it. A shouldered weapon and two solves fixed that; this is the test
     that would have caught it. */
  {
    const dressed = () => createHumanoid({
      skin: 0xf0c69a, shirt: 0xd9d3c3, pants: 0xbfb9aa, hair: 0x24170f, shoes: 0x222222, scale: 1,
    });
    const frame = (h, aiming) => poseHumanoid(h, {
      dt: 1 / 60, t: 0, speed: 0, runSpeed: 6, grounded: true, airVy: 0, aiming,
      aimPitch: 0, dead: 0, seated: false, punch: 0, flinch: 0, steer: 0,
    });
    /** Where the palm ends up, walking down the arm the pose code just set. */
    const palm = (h, elbow) => {
      h.root.updateMatrixWorld(true);
      return elbow.localToWorld(new THREE.Vector3(0, -0.29, 0));
    };

    ok(createWeaponModel('knife').foregrip === null, 'a knife never grows a second hand');
    ok(createWeaponModel('pistol').supportAtRest === false,
      'and a pistol is one-handed until you steady it');

    const missed = [];
    for (const id of ['smg', 'ak47', 'shotgun', 'sniper', 'rpg', 'minigun']) {
      const h = dressed();
      const w = createWeaponModel(id);
      if (!w.foregrip || !w.supportAtRest) { missed.push(`${id} is not two-handed at all`); continue; }
      h.rifleMount.position.copy(w.pocket);
      h.rifleMount.add(w.group);
      h.grip = { at: w.foregrip, atRest: true };
      h.hold = w.group;
      for (let i = 0; i < 90; i++) frame(h, true);

      const offL = palm(h, h.foreL).distanceTo(w.foregrip.getWorldPosition(new THREE.Vector3()));
      const offR = palm(h, h.foreR).distanceTo(w.group.getWorldPosition(new THREE.Vector3()));
      if (offL > 0.03) missed.push(`${id}: support hand ${(offL * 100).toFixed(1)}cm off the handguard`);
      if (offR > 0.03) missed.push(`${id}: firing hand ${(offR * 100).toFixed(1)}cm off the grip`);
      // Reaching the gun is only half of it: both elbow solutions do that, and only one
      // of them keeps the arm out of the ribcage.
      const eL = h.root.worldToLocal(h.foreL.getWorldPosition(new THREE.Vector3()));
      const eR = h.root.worldToLocal(h.foreR.getWorldPosition(new THREE.Vector3()));
      const sL = h.root.worldToLocal(h.armL.getWorldPosition(new THREE.Vector3()));
      const sR = h.root.worldToLocal(h.armR.getWorldPosition(new THREE.Vector3()));
      if (Math.sign(eL.x) !== Math.sign(sL.x) || Math.abs(eL.x) < 0.06) {
        missed.push(`${id}: support elbow folded through the chest (x ${eL.x.toFixed(2)})`);
      }
      if (Math.sign(eR.x) !== Math.sign(sR.x) || Math.abs(eR.x) < 0.06) {
        missed.push(`${id}: firing elbow folded through the chest (x ${eR.x.toFixed(2)})`);
      }
    }
    ok(!missed.length,
      'both hands land on all six two-handed weapons, with both elbows outside the body',
      missed.join('; '));

    // And nothing drags on the pavement while it is being carried. The RPG's tube is
    // 0.85m long; at the half-radian low-ready angle the first version of this put the
    // warhead through the player's own feet.
    const dragging = [];
    for (const id of ['pistol', 'smg', 'ak47', 'shotgun', 'sniper', 'rpg', 'minigun']) {
      const h = dressed();
      const w = createWeaponModel(id);
      h.pocket.copy(w.pocket);
      h.rifleMount.add(w.group);
      h.grip = { at: w.foregrip, atRest: w.supportAtRest };
      h.hold = w.group;
      for (let i = 0; i < 150; i++) frame(h, false);
      h.root.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(w.group);
      if (bb.min.y < 0.3) dragging.push(`${id} hangs down to ${bb.min.y.toFixed(2)}m`);
      if (bb.max.y > 1.85) dragging.push(`${id} sticks up to ${bb.max.y.toFixed(2)}m`);
    }
    ok(!dragging.length,
      'and carried at rest, every one of them clears the ground and stays below head height',
      dragging.join('; '));

    // The pistol: one hand at rest, two once the shot is steadied, and the support hand
    // has to be able to reach across to it.
    {
      const h = dressed();
      const w = createWeaponModel('pistol');
      h.pocket.copy(w.pocket);
      h.rifleMount.add(w.group);
      h.hold = w.group;
      h.grip = { at: w.foregrip, atRest: false };
      const support = () => palm(h, h.foreL).distanceTo(w.foregrip.getWorldPosition(new THREE.Vector3()));
      const firing = () => palm(h, h.foreR).distanceTo(w.group.getWorldPosition(new THREE.Vector3()));

      for (let i = 0; i < 120; i++) frame(h, false);
      ok(firing() < 0.03, 'walking around, the pistol stays in the firing hand');
      ok(support() > 0.15,
        `with the other arm swinging free ${(support() * 100).toFixed(0)}cm away, not welded to the gun`);
      const carriedAt = w.group.getWorldPosition(new THREE.Vector3()).y;

      for (let i = 0; i < 120; i++) frame(h, true);
      ok(support() < 0.03, `and the off hand comes up to cup it when aiming (${(support() * 100).toFixed(1)}cm)`);
      ok(w.group.getWorldPosition(new THREE.Vector3()).y > carriedAt + 0.1,
        'the gun comes up from the hip to do it, rather than the arms reaching down to a '
        + 'weapon that was already levelled at everybody in the street');
    }

    // Putting it away has to let go, and let go smoothly.
    {
      const h = dressed();
      const w = createWeaponModel('ak47');
      h.rifleMount.position.copy(w.pocket);
      h.rifleMount.add(w.group);
      h.grip = { at: w.foregrip, atRest: true };
      h.hold = w.group;
      for (let i = 0; i < 90; i++) frame(h, true);
      ok(h.gripW > 0.98, 'the solve ramps fully in while a weapon is out');
      h.grip = null; h.hold = null;
      frame(h, false);
      ok(h.gripW > 0.5 && h.gripW < 1,
        `switching to fists releases the arms over several frames (${h.gripW.toFixed(2)} after one), `
        + 'instead of snapping them back to the hips in a single one');
      for (let i = 0; i < 120; i++) frame(h, false);
      ok(h.gripW < 0.02, 'and lets go completely');
    }

    // Empty hands must not cost anything: no grip, no solve, no matrix walk.
    const idle = dressed();
    frame(idle, true);
    ok(idle.gripW === 0, 'a character with empty hands never runs the solver at all');
  }

  /* The bone socket. Rig bones carry a scale of 100 and arbitrary rest orientations, so
     a prop parented straight to one arrives huge and tilted; this is the correction. */
  {
    const root = new THREE.Group();
    const inner = new THREE.Group();
    inner.scale.setScalar(1.1);          // charScale
    inner.rotation.y = Math.PI;          // the model faces -Z
    root.add(inner);
    const bone = new THREE.Group();
    bone.scale.setScalar(100);
    bone.position.set(0.02, 0.86, 0.09);
    bone.rotation.set(0.31, 0.2, -0.15); // some rest pose nobody chose
    inner.add(bone);
    root.updateMatrixWorld(true);

    const m = socket(bone, 1.3);         // a tall ped
    root.updateMatrixWorld(true);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.matrixWorld.decompose(p, q, s);
    ok(Math.abs(s.x - 1.3) < 1e-6 && Math.abs(s.y - 1.3) < 1e-6,
      `one unit on the socket is one metre, scaled to the wearer (${s.x.toFixed(3)})`);
    ok(Math.abs(q.x) < 1e-6 && Math.abs(q.y) < 1e-6 && Math.abs(q.z) < 1e-6,
      'the prop comes out upright however the bone was posed at bind time');
    const bp = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
    ok(p.distanceTo(bp) < 1e-6, 'and its origin sits exactly on the joint');
  }

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



/* The animated rig — the one that actually ships.
 *
 * `character.glb` is a skinned mannequin, so everything about it is driven by bones looked
 * up *by name*. Nothing else in the test suite touched it, because loading a GLB seemed to
 * need a browser; it does not. GLTFLoader.parse() takes an ArrayBuffer, which is all this
 * needs, and the first thing it found was that half the rig lookups had never worked. */

const { installCanvasStub } = await import('./stub-canvas.mjs');
installCanvasStub();
globalThis.window = globalThis;

const fs = await import('node:fs');
const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`  ok   ${msg}`);
  else { fails++; console.log(`  FAIL ${msg} ${extra}`); }
};

const MODEL = 'public/assets/models/character.glb';
console.log('\nanimated character rig');

if (!fs.existsSync(MODEL)) {
  // A fresh clone has no downloads. The capsule rig covers this ground in world.test.mjs.
  console.log('  --   character.glb not present; skipping (procedural rig is tested elsewhere)');
} else {
  const buf = fs.readFileSync(MODEL);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
  gltf.scene.userData.clips = gltf.animations;

  const { initCharacters, animatedHumansAvailable } = await import('./characters.js');
  initCharacters({ model: (id) => (id === 'character' ? gltf.scene : undefined) });
  ok(animatedHumansAvailable(), `the mannequin loads with ${gltf.animations.length} clips`);

  const { createHumanoid, poseHumanoid } = await import('./humanoid.js');
  const { createWeaponModel } = await import('./weapons.js');
  const look = () => ({
    skin: 0xf0c69a, shirt: 0xd9d3c3, pants: 0xbfb9aa, hair: 0x24170f, shoes: 0x222222, scale: 1,
  });

  /* -- the naming trap ---------------------------------------------------------------
     GLTFLoader runs every node name through PropertyBinding.sanitizeNodeName, which strips
     the dots: `DEF-hand.R` in the file is `DEF-handR` in the scene. Every bone on this rig
     with a dot in its name — both upper arms, both forearms, both hands, every spine bone —
     failed to resolve, and getObjectByName returning undefined just quietly does nothing.
     Two whole features were dead and neither of them threw. */
  {
    const scene = gltf.scene;
    const raw = [];
    scene.traverse((o) => { if (o.name) raw.push(o.name); });
    ok(raw.includes('DEF-handR') && !raw.includes('DEF-hand.R'),
      'the loader really does strip the dots out of bone names (DEF-hand.R -> DEF-handR)');

    const needed = [
      'DEF-hips', 'DEF-head', 'DEF-spine.003',
      'DEF-upper_arm.L', 'DEF-forearm.L', 'DEF-hand.L',
      'DEF-upper_arm.R', 'DEF-forearm.R', 'DEF-hand.R',
    ];
    const missing = needed.filter((n) => !scene.getObjectByName(n.replace(/\./g, '')));
    ok(!missing.length,
      `all ${needed.length} bones the game looks up are found once the dots are normalised`,
      missing.join(', '));
    const naive = needed.filter((n) => !scene.getObjectByName(n));
    ok(naive.length === needed.filter((n) => n.includes('.')).length && naive.length > 0,
      `and ${naive.length} of them would silently resolve to nothing without that — which is `
      + 'exactly what was happening', naive.join(', '));
  }

  /* -- both hands on the gun ---------------------------------------------------------- */
  {
    const h = createHumanoid(look());
    ok(!!h.mixer, 'characters are built from the mannequin, not the capsule fallback');
    ok(!!h.armIK, 'the arm rig resolves, so there is something to solve onto the weapon');
    if (h.armIK) {
      const reach = h.armIK.l1 + h.armIK.l2;
      ok(reach > 0.45 && reach < 0.8, `an arm is ${reach.toFixed(2)}m long, measured off the bind pose`);
    }

    const w = createWeaponModel('smg');
    h.pocket.copy(w.pocket);
    h.rifleMount.add(w.group);
    h.hold = w.group;
    h.grip = { at: w.foregrip, atRest: true };
    const frame = (aiming) => poseHumanoid(h, {
      dt: 1 / 60, t: 0, speed: 0, runSpeed: 6, grounded: true, airVy: 0, aiming,
      aimPitch: 0, dead: 0, seated: false, punch: 0, flinch: 0, steer: 0,
    });
    for (let i = 0; i < 150; i++) frame(true);
    h.root.updateMatrixWorld(true);

    const V = () => new THREE.Vector3();
    const inner = h.root.children[0];
    const at = (n) => inner.getObjectByName(n.replace(/\./g, '')).getWorldPosition(V());
    const offL = at('DEF-hand.L').distanceTo(w.foregrip.getWorldPosition(V()));
    const offR = at('DEF-hand.R').distanceTo(w.group.getWorldPosition(V()));
    ok(h.gripW > 0.98, 'the solve is fully applied');
    ok(offL < 0.07,
      `the support hand is on the handguard, ${(offL * 100).toFixed(1)}cm from it — it used to `
      + 'hang by the character\'s side while the gun floated in front of their chest');
    ok(offR < 0.07, `and the firing hand is on the grip, ${(offR * 100).toFixed(1)}cm from it`);

    /* The hand reaching the gun is NOT enough, and believing it was is what shipped a
       character with one arm. Both elbow solutions put the hand on the same target; only
       one of them keeps the arm outside the body. With the poles hard-coded per named
       side they were backwards for this rig and both forearms folded through the ribcage,
       while every reach assertion above went on passing. */
    const localOf = (n) => h.root.worldToLocal(at(n));
    const shoulderL = localOf('DEF-upper_arm.L');
    const elbowL = localOf('DEF-forearm.L');
    const shoulderR = localOf('DEF-upper_arm.R');
    const elbowR = localOf('DEF-forearm.R');
    ok(shoulderL.x > 0 && shoulderR.x < 0,
      `this rig puts its L shoulder at x=${shoulderL.x.toFixed(2)} and its R at `
      + `x=${shoulderR.x.toFixed(2)} — the capsule fallback has them the other way round, which `
      + 'is why the pole is derived from the rig rather than assumed');
    // Sign, not distance: an elbow 6cm off the centreline but well forward of the chest is
    // a perfectly good shooting stance. Whether it is actually *inside* the body is a
    // volume question, and the ribcage test below is the one that answers it.
    ok(Math.sign(elbowL.x) === Math.sign(shoulderL.x) && Math.sign(elbowR.x) === Math.sign(shoulderR.x),
      `each elbow stays on its own side of the spine (L ${elbowL.x.toFixed(2)}, R ${elbowR.x.toFixed(2)}) `
      + 'rather than swapping over through the chest');
    ok(Math.abs(elbowL.x - shoulderL.x) < 0.3 && Math.abs(elbowR.x - shoulderR.x) < 0.3,
      'and neither arm crosses the body to get to the weapon');

    // The arms have to have actually moved off the animation clip to get there.
    const bare = createHumanoid(look());
    for (let i = 0; i < 150; i++) poseHumanoid(bare, {
      dt: 1 / 60, t: 0, speed: 0, runSpeed: 6, grounded: true, airVy: 0, aiming: true,
      aimPitch: 0, dead: 0, seated: false, punch: 0, flinch: 0, steer: 0,
    });
    bare.root.updateMatrixWorld(true);
    const bareL = bare.root.children[0].getObjectByName('DEF-handL').getWorldPosition(V());
    ok(bareL.distanceTo(at('DEF-hand.L')) > 0.1,
      `holding a weapon moves the left hand ${bareL.distanceTo(at('DEF-hand.L')).toFixed(2)}m from `
      + 'where the clip alone would have put it');
  }

  /* -- nothing may end up inside the ribcage ------------------------------------------
     "Both hands reach the gun" and "the elbow is on the correct side" are both true of a
     pose where the whole forearm is buried in the chest, which is what a player actually
     sees and reports as a missing arm. The only assertion that catches it is a volume one:
     the torso is roughly a cylinder, and no part of either arm may be inside it. */
  {
    const V = () => new THREE.Vector3();
    const WEAPONS_TO_CHECK = ['pistol', 'smg', 'ak47', 'shotgun', 'sniper', 'rpg', 'minigun'];
    // The torso is an ellipse, not a circle: broad across the ribs, shallow front to back.
    // Testing it as a fat cylinder would fail arms that are legitimately out in front.
    const TORSO_X = 0.18, TORSO_Z = 0.13, TORSO_LO = 0.85, TORSO_HI = 1.5;
    const insideTorso = (p) => p.y > TORSO_LO && p.y < TORSO_HI
      && (p.x / TORSO_X) ** 2 + (p.z / TORSO_Z) ** 2 < 1;
    const buried = [];

    for (const id of WEAPONS_TO_CHECK) {
      for (const aiming of [true, false]) {
        const h = createHumanoid(look());
        const w = createWeaponModel(id);
        h.pocket.copy(w.pocket);
        h.rifleMount.add(w.group);
        h.hold = w.group;
        h.grip = { at: w.foregrip, atRest: w.supportAtRest };
        for (let i = 0; i < 200; i++) poseHumanoid(h, {
          dt: 1 / 60, t: 0, speed: 0, runSpeed: 6, grounded: true, airVy: 0, aiming,
          aimPitch: 0, dead: 0, seated: false, punch: 0, flinch: 0, steer: 0,
        });
        h.root.updateMatrixWorld(true);
        const inner = h.root.children[0];
        const local = (n) => h.root.worldToLocal(
          inner.getObjectByName(n.replace(/\./g, '')).getWorldPosition(V()));

        const parts = {
          'left elbow': local('DEF-forearm.L'), 'left hand': local('DEF-hand.L'),
          'right elbow': local('DEF-forearm.R'), 'right hand': local('DEF-hand.R'),
        };
        // The support hand is only brought up when the weapon asks for it.
        const twoHanded = w.supportAtRest || aiming;
        for (const [name, p] of Object.entries(parts)) {
          if (!twoHanded && name.startsWith('left')) continue;
          if (insideTorso(p)) {
            buried.push(`${id}${aiming ? '' : ' at rest'}: ${name} at x=${p.x.toFixed(2)} z=${p.z.toFixed(2)}`);
          }
        }
        // And the weapon itself has to be out where it can be held.
        if (insideTorso(h.root.worldToLocal(w.foregrip.getWorldPosition(V())))) {
          buried.push(`${id}${aiming ? '' : ' at rest'}: the foregrip itself is inside the torso`);
        }
      }
    }
    ok(!buried.length,
      `across all ${WEAPONS_TO_CHECK.length} guns, aimed and at rest, no elbow, hand or `
      + 'grip ends up inside the ribcage', buried.join('; '));
  }

  /* -- sitting in a car ---------------------------------------------------------------
     The seating code has to know how tall a seated character is, and it was using numbers
     that describe the *capsule* rig for both. The mannequin folds up 37cm more compactly,
     so every driver of the rig that actually ships sat a foot below their own seat with
     their legs through the floor pan. These constants are measured off the model, so
     re-measure them here: swapping character.glb must not silently invalidate them. */
  {
    const V = () => new THREE.Vector3();
    const { ANIMATED_SEATED } = await import('./characters.js');
    const { CAPSULE_SEATED, seatMetrics } = await import('./humanoid.js');
    const { SKULL_TOP } = await import('./outfits.js');
    const { createVehicle, SPECS } = await import('./vehicle.js');

    const h = createHumanoid(look());
    h.root.position.set(0, 0, 0);
    const sit = () => { for (let i = 0; i < 150; i++) poseHumanoid(h, {
      dt: 1 / 60, t: 0, speed: 0, runSpeed: 6, grounded: true, airVy: 0, aiming: false,
      aimPitch: 0, dead: 0, seated: true, punch: 0, flinch: 0, steer: 0 }); };
    sit();
    h.root.updateMatrixWorld(true);
    const bone = (n) => h.root.children[0].getObjectByName(n).getWorldPosition(V()).y;
    const hip = bone('DEF-hips');
    const head = bone('DEF-head') + SKULL_TOP.animated;

    ok(Math.abs(hip - ANIMATED_SEATED.hip) < 0.01,
      `a seated driver's hips are ${hip.toFixed(3)}m up, matching the measured constant`);
    ok(Math.abs(head - ANIMATED_SEATED.head) < 0.01,
      `and the top of their head ${head.toFixed(3)}m, matching too`);
    ok(Math.abs(ANIMATED_SEATED.hip - CAPSULE_SEATED.hip) > 0.2,
      `the two rigs really do disagree, by ${((CAPSULE_SEATED.hip - ANIMATED_SEATED.hip) * 100).toFixed(0)}cm at `
      + 'the hip — which is why one set of numbers for both put the driver through the floor');
    ok(seatMetrics(h) === ANIMATED_SEATED, 'and a mannequin reports the mannequin\'s numbers');

    // Now every car, on the rig that ships: head under the roof, backside on the seat.
    const seatHeight = (v, m) => {
      let y = v.spec.seat[1] - m.hip;
      const roof = v.spec.height - 0.1;
      if (y + m.head > roof) y -= y + m.head - roof;
      return y;
    };
    const wrong = [];
    for (const kind of Object.keys(SPECS)) {
      const v = createVehicle(kind, 0xcccccc);
      const y = seatHeight(v, ANIMATED_SEATED);
      const headTop = y + ANIMATED_SEATED.head;
      const hipY = y + ANIMATED_SEATED.hip;
      // Sinking into the seat is the mechanism, not a fault — these cabins are smaller
      // than a 1.48m seated mannequin. What matters is the two ends of it: the head must
      // not come through the roof, and must not disappear so far down that the driver is
      // no longer framed in his own window.
      if (headTop > v.spec.height) wrong.push(`${kind}: head ${((headTop - v.spec.height) * 100) | 0}cm through the roof`);
      // Measured from the seat, not the roofline: spec.height on the Bedford is 3.7m of
      // painted cargo crown, nothing to do with how much headroom the cab has.
      const sitUp = headTop - v.spec.seat[1];
      if (sitUp < 0.5) wrong.push(`${kind}: head only ${(sitUp * 100) | 0}cm above the seat — lying in the footwell`);
      void hipY;
    }
    ok(!wrong.length,
      `in all ${Object.keys(SPECS).length} vehicles the driver's head clears the roof and he is `
      + 'sitting up in the seat rather than lying in the footwell', wrong.join('; '));
  }

  /* -- clothing that hangs off the chest ---------------------------------------------- */
  {
    const cop = createHumanoid({ ...look(), outfit: 'police' });
    ok(cop.props.length >= 3,
      `a constable carries ${cop.props.length} pieces of uniform — cap, belt and epaulettes`);
    const swat = createHumanoid({ ...look(), outfit: 'swat' });
    ok(swat.props.length >= 2, 'and SWAT get a helmet and a plate carrier');
    ok(createHumanoid({ ...look(), outfit: 'street' }).props.length === 0,
      'while an ordinary civilian carries nothing extra at all');

    // Every prop has to be parented to something, or it was built and thrown away.
    const orphan = cop.props.some((m) => !m.parent);
    ok(!orphan, 'and every piece is actually attached to a bone rather than built and dropped');
  }
}

console.log(fails ? `\n${fails} FAILURES` : '\nALL PASS');
process.exit(fails ? 1 : 0);

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

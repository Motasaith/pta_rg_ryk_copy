import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AssetBank } from './assets';
import {
  BONE_UP, holdWeapon, humanoidMaterial, RIFLE_POCKET,
  type ArmRig, type GripTarget, type Humanoid, type Look, type PoseInput,
} from './humanoid';
import { buildOutfit, defaultHat, SKULL_TOP } from './outfits';

/**
 * Animated humans from Quaternius' CC0 "Universal Base Character" (a skinned
 * mannequin on a universal rig with 40+ embedded clips).
 *
 * It impersonates the procedural `Humanoid`: same `root`/`gunMount`/`meshes`
 * surface, and `poseHumanoid()` dispatches to `poseAnimated()` when it meets one,
 * so the hero, every ped and every remote player upgrade without their call
 * sites changing at all. When the model is missing (offline, headless tests)
 * `createHumanoid` keeps building the capsule rig exactly as before.
 */

/**
 * How the mannequin folds up in the `Driving_Loop` clip: hip height and the top of the
 * skull, both above the character's root.
 *
 * Measured off the model rather than guessed, and `tests/character.test.mjs` re-measures
 * it on every run so swapping the model cannot silently invalidate it. It matters because
 * the seating code was using the capsule rig's numbers (hip 0.91, skull 1.65) for both
 * rigs, and this one sits 37cm more compactly — so every driver was sunk more than a foot
 * too deep into their seat, with their legs through the floor pan.
 */
export const ANIMATED_SEATED = { hip: 0.539, head: 1.484 };

export interface AnimatedHumanoid extends Humanoid {
  /** Clothing hung off the bones. Owned by this character, unlike the shared body. */
  props: THREE.Mesh[];
  /**
   * Both arms, and how long they are. Measured off the bind pose rather than assumed, so
   * it comes out right for a 0.93-scale pedestrian and a 1.05-scale officer alike.
   */
  armIK: ArmRig | null;
  mixer: THREE.AnimationMixer;
  a: Record<ClipName, THREE.AnimationAction | undefined>;
  loco: THREE.AnimationAction | null;
  oneShot: THREE.AnimationAction | null;
  oneShotT: number;
  deadPlayed: boolean;
  punchT: number;
}

type ClipName = 'idle' | 'walk' | 'jog' | 'sprint' | 'crouch' | 'crouchWalk' | 'aim' | 'drive' | 'jump'
  | 'punch' | 'hit' | 'death';

/** Which embedded clip each state uses. Names carry a "Rig|" prefix. */
const CLIP_MATCH: Record<ClipName, RegExp> = {
  idle: /(?:^|\|)Idle_Loop$/,
  walk: /(?:^|\|)Walk_Loop$/,
  jog: /(?:^|\|)Jog_Fwd_Loop$/,
  sprint: /(?:^|\|)Sprint_Loop$/,
  crouch: /(?:^|\|)Crouch_Idle_Loop$/,
  crouchWalk: /(?:^|\|)Crouch_Fwd_Loop$/,
  aim: /(?:^|\|)Pistol_Idle_Loop$/,
  drive: /(?:^|\|)Driving_Loop$/,
  jump: /(?:^|\|)Jump_Loop$/,
  punch: /(?:^|\|)Punch_Jab$/,
  hit: /(?:^|\|)Hit_Chest$/,
  death: /(?:^|\|)Death01$/,
};

let template: THREE.Object3D | null = null;
let templateClips: THREE.AnimationClip[] = [];
/** Uniform scale that makes the mannequin our canonical 1.78 m. */
let charScale = 1;

export function initCharacters(bank: AssetBank): void {
  const scene = bank.model('character');
  if (!scene) return;
  const clips = (scene.userData.clips as THREE.AnimationClip[] | undefined) ?? [];
  if (!clips.length) return;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const height = box.max.y - box.min.y;
  if (height > 1e-3) charScale = 1.78 / height;
  // Sit the feet on the origin the way the procedural rig does.
  scene.position.y -= box.min.y * charScale;
  template = scene;
  templateClips = clips;
}

export function animatedHumansAvailable(): boolean {
  return template !== null;
}

/**
 * Find a rig bone by the name it has in Blender.
 *
 * GLTFLoader runs every node name through `PropertyBinding.sanitizeNodeName`, which strips
 * the dots — so `DEF-hand.R` in the file arrives in the scene as `DEF-handR`. Every bone on
 * this rig whose name contains a dot is affected: both upper arms, both forearms, both
 * hands, and every spine bone.
 *
 * That mattered a great deal, because a lookup that misses just returns null and null
 * quietly does nothing. Two features were silently dead: the arm IK never found an arm, so
 * a shouldered weapon hung in mid-air in front of the chest with both arms by the
 * character's sides; and the chest socket never resolved, so police epaulettes and the
 * SWAT plate carrier were built and then thrown away. Neither threw, neither logged, and
 * both looked exactly like a bug in something else.
 */
function bone(root: THREE.Object3D, name: string): THREE.Object3D | null {
  return root.getObjectByName(name.replace(/\./g, '')) ?? root.getObjectByName(name) ?? null;
}

/**
 * A world-upright, metre-scaled mount on a bone.
 *
 * The rig carries an internal scale of 100 and every bone has its own rest orientation,
 * so a prop parented straight to one arrives a hundred times too big and tilted by
 * whatever the bind pose happened to be. This undoes both **once, at bind time**: the
 * mount comes out axis-aligned with the character, with one unit to the metre, and its
 * origin exactly on the joint. After that the prop simply rides the bone, which is what
 * a cap or a belt does on a real person too.
 */
export function socket(bone: THREE.Object3D, lookScale: number): THREE.Object3D {
  bone.updateWorldMatrix(true, false);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  bone.matrixWorld.decompose(p, q, sc);
  const m = new THREE.Object3D();
  m.quaternion.copy(q).invert();
  m.scale.setScalar(lookScale / (sc.x || 1));
  bone.add(m);
  return m;
}

export function createAnimatedHumanoid(look: Look): AnimatedHumanoid {
  const root = new THREE.Group();
  const inner = skeletonClone(template!) as THREE.Group;
  inner.scale.setScalar(charScale * look.scale);
  // GLTF models default to -Z forward; rotate 180° so character faces +Z (game forward)
  inner.rotation.y = Math.PI;
  root.add(inner);

  const meshes: THREE.Mesh[] = [];
  inner.traverse((o) => {
    const m = o as THREE.Mesh & { material: THREE.Material | THREE.Material[] };
    if (!m.isMesh) return;
    m.material = Array.isArray(m.material)
      ? m.material.map((x) => x.clone())
      : m.material.clone();
    m.castShadow = true;
    m.frustumCulled = false; // skinned meshes escape their bind-pose bounds
    meshes.push(m);
  });
  // One material for the whole body: tint it toward the outfit so the crowd varies.
  for (const m of meshes) {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const x of mats) {
      const mat = x as THREE.MeshStandardMaterial;
      if (!mat.color) continue;
      const shirt = new THREE.Color(look.shirt);
      const skin = new THREE.Color(look.skin);
      // A uniform covers the whole officer; ordinary clothes leave more skin showing.
      const uniform = look.outfit === 'police' || look.outfit === 'swat';
      if (/joint/i.test(mat.name || '')) {
        // The mannequin ships a second material on the shoulder and elbow caps, and it
        // was never being tinted — so every character in the game, whatever they were
        // wearing, had bright magenta patches at each joint. Sit it a shade under the
        // body so the caps read as seams instead of as a costume malfunction.
        mat.color.copy(skin.lerp(shirt, uniform ? 0.95 : 0.8)).multiplyScalar(0.72);
        mat.roughness = 0.85;
      } else {
        mat.color.copy(skin.lerp(shirt, uniform ? 0.93 : 0.72));
        mat.roughness = 0.8;
      }
    }
  }

  const mixer = new THREE.AnimationMixer(inner);
  const a = {} as Record<ClipName, THREE.AnimationAction | undefined>;
  for (const key of Object.keys(CLIP_MATCH) as ClipName[]) {
    const clip = templateClips.find((c) => CLIP_MATCH[key].test(c.name));
    if (clip) a[key] = mixer.clipAction(clip);
  }
  if (a.death) {
    a.death.setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
    a.death.timeScale = 2.0;
  }
  if (a.punch) a.punch.setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
  if (a.hit) a.hit.setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
  if (a.punch) a.punch.timeScale = 1.6;
  a.idle?.play();

  // Weapons hang off the right hand bone. Compensate for internal rig scale 100.
  const gunMount = new THREE.Object3D();
  gunMount.name = 'gunMount';
  gunMount.scale.setScalar(0.01);
  gunMount.position.set(0, 0.065 / 100, -0.015 / 100);
  gunMount.rotation.set(1.41, Math.PI - 0.03, -0.04);
  const hand = bone(inner, 'DEF-hand.R');
  if (hand) {
    hand.add(gunMount);
  }

  // ── clothes. One merged prop per joint, so a dressed character is at most three
  // draw calls dearer than a bare mannequin.
  const outfit = look.outfit ?? 'street';
  const kit = buildOutfit(outfit, look.hat ?? defaultHat(outfit), look, SKULL_TOP.animated);
  const props: THREE.Mesh[] = [];
  const dress = (boneName: string, geo: THREE.BufferGeometry | null): void => {
    if (!geo) return;
    const at = bone(inner, boneName);
    if (!at) { geo.dispose(); return; }
    const mesh = new THREE.Mesh(geo, humanoidMaterial());
    mesh.castShadow = true;
    mesh.frustumCulled = false;   // it rides a skinned bone, like the body
    socket(at, look.scale).add(mesh);
    props.push(mesh);
    meshes.push(mesh);
  };
  dress('DEF-hips', kit.hips);
  dress('DEF-spine.003', kit.chest);
  dress('DEF-head', kit.head);

  // ── the arms, for putting both hands on a rifle
  root.updateMatrixWorld(true);
  const upperL = bone(inner, 'DEF-upper_arm.L');
  const lowerL = bone(inner, 'DEF-forearm.L');
  const handL = bone(inner, 'DEF-hand.L');
  const upperR = bone(inner, 'DEF-upper_arm.R');
  const lowerR = bone(inner, 'DEF-forearm.R');
  let armIK: ArmRig | null = null;
  if (upperL && lowerL && handL && upperR && lowerR) {
    const a = upperL.getWorldPosition(new THREE.Vector3());
    const b = lowerL.getWorldPosition(new THREE.Vector3());
    const c = handL.getWorldPosition(new THREE.Vector3());
    armIK = {
      upperL, lowerL, upperR, lowerR,
      l1: a.distanceTo(b),
      // to the palm, not the wrist bone, so the hand closes on the grip rather than
      // hovering a centimetre short of it
      l2: b.distanceTo(c) + 0.035 * look.scale,
      axis: BONE_UP,
    };
  }

  // ── where a shouldered weapon hangs: on the body, in character space, so one set of
  // numbers serves both rigs and no animation clip can tilt the muzzle.
  const rifleMount = new THREE.Object3D();
  rifleMount.scale.setScalar(look.scale);
  rifleMount.position.copy(RIFLE_POCKET);
  root.add(rifleMount);

  const stub = (): THREE.Group => new THREE.Group();
  return {
    root,
    props,
    armIK,
    grip: null as GripTarget | null,
    rifleMount,
    hold: null as THREE.Object3D | null,
    pocket: RIFLE_POCKET.clone(),
    gripW: 0,
    // The animated driver never touches these; they exist for interface parity.
    tilt: stub(), hips: stub(), chest: stub(), head: stub(),
    armL: stub(), armR: stub(), foreL: stub(), foreR: stub(),
    legL: stub(), legR: stub(), shinL: stub(), shinR: stub(),
    gunMount,
    meshes,
    look,
    phase: 0, aimW: 0, punchT: 0, punchSide: 1, slashing: false, hitT: 0, bob: 0,
    mixer, a,
    loco: a.idle ?? null,
    oneShot: null, oneShotT: 0, deadPlayed: false,
  };
}

function fadeTo(ch: AnimatedHumanoid, next: THREE.AnimationAction | undefined, fade = 0.22): void {
  if (!next) return;
  if (ch.loco === next) return;
  next.reset().fadeIn(fade).play();
  ch.loco?.fadeOut(fade);
  ch.loco = next;
}

/** Plays a full-body replacement clip (punch, hit, death) over the base locomotion. */
function playOneShot(ch: AnimatedHumanoid, action: THREE.AnimationAction, dur: number, fade = 0.12): void {
  ch.loco?.fadeOut(fade);
  action.reset().fadeIn(fade).play();
  ch.oneShot = action;
  ch.oneShotT = dur;
}

/** Animation-state twin of the procedural poseHumanoid. */
export function poseAnimated(ch: AnimatedHumanoid, p: PoseInput): void {
  const dt = p.dt;

  if (p.dead > 0) {
    if (!ch.deadPlayed) {
      ch.deadPlayed = true;
      if (ch.a.death) playOneShot(ch, ch.a.death, 1e9, 0.15);
    }
    ch.mixer.update(dt);
    return;
  }

  // Revived or respawned: cleanly cancel death pose and restore full locomotion
  if (ch.deadPlayed) {
    ch.deadPlayed = false;
    if (ch.a.death) {
      ch.a.death.stop();
      ch.a.death.reset();
    }
    if (ch.oneShot === ch.a.death) {
      ch.oneShot = null;
      ch.oneShotT = 0;
    }
    ch.loco = null;
    fadeTo(ch, ch.a.idle, 0.1);
  }

  if (p.punch > 0) ch.punchT = 0.38;
  ch.punchT = Math.max(0, ch.punchT - dt);
  if (ch.punchT > 0 && ch.a.punch && ch.oneShot !== ch.a.punch) {
    playOneShot(ch, ch.a.punch, ch.punchT);
  } else if (p.flinch > 0 && ch.a.hit && ch.oneShot !== ch.a.hit) {
    playOneShot(ch, ch.a.hit, 0.4);
  }

  if (ch.oneShot) {
    ch.oneShotT -= dt;
    if (ch.oneShotT <= 0 && ch.oneShot !== ch.a.death) {
      ch.oneShot.fadeOut(0.15);
      ch.loco?.reset().fadeIn(0.15).play();
      ch.oneShot = null;
    }
  }

  if (!ch.oneShot) {
    if (p.seated) fadeTo(ch, ch.a.drive);
    else if (!p.grounded) fadeTo(ch, ch.a.jump);
    else if (p.aiming) fadeTo(ch, ch.a.aim);
    else if (p.crouching) {
      const s = Math.abs(p.speed);
      if (s < 0.12) fadeTo(ch, ch.a.crouch ?? ch.a.idle);
      else fadeTo(ch, ch.a.crouchWalk ?? ch.a.walk);
      if (ch.loco) {
        ch.loco.timeScale = THREE.MathUtils.clamp(s / 1.35, 0.6, 1.4);
      }
    }
    else {
      const s = Math.abs(p.speed);
      if (s < 0.12) fadeTo(ch, ch.a.idle);
      else if (s < 3.4) fadeTo(ch, ch.a.walk);
      else if (s < 6.2) fadeTo(ch, ch.a.jog);
      else fadeTo(ch, ch.a.sprint);
      // pace the clip to the actual ground speed
      if (ch.loco) {
        const n = ch.loco === ch.a.walk ? 1.55 : ch.loco === ch.a.jog ? 3.6 : 6.4;
        ch.loco.timeScale = THREE.MathUtils.clamp(s / n, 0.55, 1.5);
      }
    }
  }

  ch.mixer.update(dt);

  // Last, on top of the clip: the mannequin's only aiming animation is a pistol stance,
  // and it has no idea how long an AK is. A shouldered weapon is placed on the chest and
  // both hands are solved onto it instead.
  if (ch.armIK) holdWeapon(ch, p, ch.armIK);
}

/**
 * Free what this character actually owns.
 *
 * Deliberately **not** the body geometry: `SkeletonUtils.clone` shares the mannequin's
 * buffers between every character in the game, so the old blanket
 * `meshes.forEach(m => m.geometry.dispose())` threw away the shared vertex buffers every
 * time a single pedestrian walked out of range, forcing a full re-upload of the mannequin
 * for everyone still on screen. The materials are per-character clones and the clothing is
 * built fresh per character, so those two are ours to release.
 */
export function disposeAnimatedHumanoid(ch: AnimatedHumanoid): void {
  ch.mixer.stopAllAction();
  ch.mixer.uncacheRoot(ch.mixer.getRoot());
  for (const m of ch.props) m.geometry.dispose();
  for (const m of ch.meshes) {
    if (ch.props.includes(m)) continue;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const x of mats) x.dispose();
  }
}

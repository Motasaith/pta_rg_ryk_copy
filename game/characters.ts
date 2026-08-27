import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AssetBank } from './assets';
import type { Humanoid, Look, PoseInput } from './humanoid';

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

export interface AnimatedHumanoid extends Humanoid {
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
      if (mat.color && /main|body/i.test(mat.name || 'main')) {
        const shirt = new THREE.Color(look.shirt);
        const skin = new THREE.Color(look.skin);
        mat.color.copy(skin.lerp(shirt, 0.72));
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
  if (a.death) a.death.setLoop(THREE.LoopOnce, 1).clampWhenFinished = true;
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
  const hand = inner.getObjectByName('DEF-handR') || inner.getObjectByName('DEF-hand.R');
  if (hand) {
    hand.add(gunMount);
  }

  const stub = (): THREE.Group => new THREE.Group();
  return {
    root,
    // The animated driver never touches these; they exist for interface parity.
    tilt: stub(), hips: stub(), chest: stub(), head: stub(),
    armL: stub(), armR: stub(), foreL: stub(), foreR: stub(),
    legL: stub(), legR: stub(), shinL: stub(), shinR: stub(),
    gunMount,
    meshes,
    look,
    phase: 0, aimW: 0, punchT: 0, hitT: 0, bob: 0,
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
}

export function disposeAnimatedHumanoid(ch: AnimatedHumanoid): void {
  ch.mixer.stopAllAction();
  ch.mixer.uncacheRoot(ch.mixer.getRoot());
}

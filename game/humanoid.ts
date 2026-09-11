import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, damp, lerp, TAU } from './mathx';
import { animatedHumansAvailable, createAnimatedHumanoid, disposeAnimatedHumanoid, poseAnimated, AnimatedHumanoid } from './characters';
import { buildOutfit, defaultHat, SKULL_TOP, type Hat, type Outfit } from './outfits';
import { applyWorldRotation, makeTwoBone, solveTwoBone } from './ik';
import { ANIMATED_SEATED } from './characters';

/**
 * A jointed humanoid built from capsules, with proportions taken from a 1.78m adult:
 * ankle 0.09 · knee 0.47 · hip 0.93 · chest 1.24 · shoulder 1.44 · eyes 1.66.
 *
 * Every part is vertex-coloured and shares ONE material, so a full character costs
 * 11 draw calls and the renderer can batch every ped in the scene into the same program.
 */

export interface Look {
  skin: number;
  shirt: number;
  pants: number;
  hair: number;
  shoes: number;
  scale: number;
  /** What they are wearing. Absent means the plain shirt-and-trousers of the old crowd. */
  outfit?: Outfit;
  /** Headwear. Absent means whatever the outfit implies (a cap for police, nothing else). */
  hat?: Hat;
}

export const SKINS = [0xf0c69a, 0xdba875, 0xc08a5c, 0xa06e45, 0x8b5a35, 0xf6d5ae];
export const SHIRTS = [0xc94f4f, 0x3f6fb5, 0x2e8b57, 0xe0a53c, 0xf0f0ea, 0x8e5aa8, 0x2b3a4a, 0xd97c3a, 0x4f7f8c, 0xb3564e];
export const PANTS = [0x2f3a4a, 0x3b3b44, 0x4a4038, 0x28405c, 0x554a3a, 0x1f2630];
export const HAIRS = [0x24170f, 0x3a2416, 0x120d0a, 0x51341c];

/** Where the off hand goes, and whether it goes there at rest or only while aiming. */
export interface GripTarget {
  at: THREE.Object3D;
  atRest: boolean;
}

/**
 * Where a shouldered weapon sits, relative to the chest joint.
 *
 * This exists because of a measurement. With the rifle hanging off the right hand and
 * the hand out at arm's length — which is what the aim pose and the mannequin's
 * `Pistol_Idle_Loop` clip both do — the AK's handguard ended up **0.71m from the left
 * shoulder**, and an arm in this game is 0.58m long. No amount of IK reaches that; the
 * support hand can only ever hang in the air near it.
 *
 * So a gun is not held at the end of an arm at all. It is mounted here, in the shoulder
 * pocket, aimed by pitching this socket, and *both* arms are then solved onto it: the
 * right hand onto the firing grip, the left onto the handguard. That is also simply what
 * shouldering a rifle is.
 *
 * Measured from the feet, and hung off the body root rather than the chest. Hanging it
 * off the chest was the obvious thing and it was wrong: on the animated rig the chest
 * bone carries whatever lean the idle clip has, so the RPG came out pointing at the
 * player's own feet. A gun has to point where the camera points, not where the
 * breathing animation does.
 *
 * **x is negative**, and that is not a detail. `rgt()` is (−cos, sin), so a character
 * facing +Z has their right hand at −x. Every pocket was authored at +x, which parked the
 * weapon on the character's left while the right hand held it — so on all seven guns the
 * firing arm reached across the body and its elbow went through the ribcage to get there.
 */
export const RIFLE_POCKET = new THREE.Vector3(-0.10, 1.295, 0.24);
/**
 * How far the muzzle drops when they are not actually aiming at anything. Small: at half
 * a radian the RPG's 0.85m tube reaches the pavement.
 */
const LOW_READY = 0.34;
/**
 * Where the weapon goes when nobody is being aimed at: down and in, towards the hip.
 * Without this an armed pedestrian walks around permanently at the ready, which reads as
 * a threat rather than as somebody carrying a gun.
 */
const REST_DROP = new THREE.Vector3(-0.02, -0.17, -0.04);

export interface Humanoid {
  root: THREE.Group;
  tilt: THREE.Group;
  hips: THREE.Group;
  chest: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  foreL: THREE.Group;
  foreR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  gunMount: THREE.Object3D;
  /**
   * The support-hand target of whatever they are holding, or null for empty hands and
   * one-handed weapons. Set where the weapon is attached; read by the pose code, which
   * solves the left arm onto it.
   */
  grip: GripTarget | null;
  /**
   * Where a shouldered weapon hangs. Two-handed weapons parent here instead of to the
   * hand, and the right arm is solved onto them; see RIFLE_POCKET.
   */
  rifleMount: THREE.Object3D;
  /** The firing grip of a shouldered weapon — the right hand's target, or null. */
  hold: THREE.Object3D | null;
  /** Where this particular weapon rides on the chest when aimed. Set on equip. */
  pocket: THREE.Vector3;
  meshes: THREE.Mesh[];
  look: Look;
  /** animation state */
  phase: number;
  aimW: number;
  punchT: number;
  punchSide: number;
  slashing: boolean;
  hitT: number;
  bob: number;
  /** How much of the support-hand solve is applied, 0..1. Ramps so holstering is smooth. */
  gripW: number;
}

const HIP_Y = 0.93;
const THIGH = 0.46;
const SHIN = 0.44;
const CHEST_Y = 0.31;    // above hips
const SHOULDER_Y = 0.51; // above hips
const UPPER_ARM = 0.29;
const FOREARM = 0.27;

let SHARED_MAT: THREE.MeshStandardMaterial | null = null;

export function humanoidMaterial(): THREE.MeshStandardMaterial {
  if (!SHARED_MAT) {
    SHARED_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.02 });
  }
  return SHARED_MAT;
}

function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function capsule(r: number, len: number, hex: number, seg = 5, radial = 8): THREE.BufferGeometry {
  return paint(new THREE.CapsuleGeometry(r, len, seg, radial), hex);
}

function boxg(w: number, h: number, d: number, hex: number): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(w, h, d), hex);
}

function sphereg(r: number, hex: number, w = 12, h = 9): THREE.BufferGeometry {
  return paint(new THREE.SphereGeometry(r, w, h), hex);
}

function at(geo: THREE.BufferGeometry, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  if (sx !== 1 || sy !== 1 || sz !== 1) geo.scale(sx, sy, sz);
  geo.translate(x, y, z);
  return geo;
}

function part(parent: THREE.Object3D, geos: THREE.BufferGeometry[], meshes: THREE.Mesh[]): THREE.Mesh {
  const merged = mergeGeometries(geos, false)!;
  const m = new THREE.Mesh(merged, humanoidMaterial());
  m.castShadow = true;
  parent.add(m);
  meshes.push(m);
  return m;
}

export function createHumanoid(look: Look): Humanoid {
  // When the CC0 animated model is available, every human in the game is built
  // from it instead of the capsule rig; poseHumanoid dispatches transparently.
  if (animatedHumansAvailable()) return createAnimatedHumanoid(look) as Humanoid;
  const root = new THREE.Group();
  const tilt = new THREE.Group();
  root.add(tilt);
  const hips = new THREE.Group();
  hips.position.y = HIP_Y;
  tilt.add(hips);
  const meshes: THREE.Mesh[] = [];

  // What they are wearing, as geometry. Merged into the joints below, so a dressed
  // character costs the same eleven draw calls an undressed one does.
  const outfit = look.outfit ?? 'street';
  const hat = look.hat ?? defaultHat(outfit);
  const kit = buildOutfit(outfit, hat, look, SKULL_TOP.capsule);

  // ── pelvis + abdomen (rotates with the hips)
  part(hips, [
    at(capsule(0.145, 0.1, look.pants), 0, -0.02, 0, 1.14, 1, 0.82),
    at(capsule(0.15, 0.14, look.shirt), 0, 0.15, 0, 1.1, 1, 0.8),
    ...(kit.hips ? [kit.hips] : []),
  ], meshes);

  // ── chest (spine twist happens here, which is what makes aiming read)
  const chest = new THREE.Group();
  chest.position.y = CHEST_Y;
  hips.add(chest);
  part(chest, [
    at(capsule(0.175, 0.17, look.shirt), 0, 0.04, 0, 1.18, 1, 0.78),
    at(capsule(0.055, 0.08, look.skin), 0, 0.25, 0),            // neck
    at(sphereg(0.085, look.shirt, 8, 6), -0.2, 0.19, 0),        // shoulder caps
    at(sphereg(0.085, look.shirt, 8, 6), 0.2, 0.19, 0),
    at(boxg(0.34, 0.12, 0.2, look.shirt), 0, 0.13, 0.03),       // collar/chest fill
    ...(kit.chest ? [kit.chest] : []),
  ], meshes);

  // ── head
  const head = new THREE.Group();
  head.position.y = 0.33;
  chest.add(head);
  part(head, [
    at(sphereg(0.125, look.skin, 14, 11), 0, 0.02, 0, 0.94, 1.14, 1),
    at(boxg(0.055, 0.05, 0.04, look.skin), 0, -0.01, 0.115),     // nose
    at(boxg(0.16, 0.03, 0.02, 0x8a5a4a), 0, -0.06, 0.105),       // mouth
    at(sphereg(0.02, 0x1a1a20, 6, 5), -0.048, 0.03, 0.105),      // eyes
    at(sphereg(0.02, 0x1a1a20, 6, 5), 0.048, 0.03, 0.105),
    at(paint(new THREE.SphereGeometry(0.132, 14, 8, 0, TAU, 0, Math.PI * 0.58), look.hair), 0, 0.025, 0, 1, 1.05, 1),
    at(boxg(0.19, 0.045, 0.03, look.hair), 0, 0.055, 0.115),     // fringe
    at(sphereg(0.035, look.skin, 6, 5), -0.122, 0.01, 0),        // ears
    at(sphereg(0.035, look.skin, 6, 5), 0.122, 0.01, 0),
    ...(kit.head ? [kit.head] : []),
  ], meshes);

  // ── arms: shoulder → elbow → (forearm + hand)
  const mkArm = (side: number) => {
    const sh = new THREE.Group();
    sh.position.set(side * 0.205, SHOULDER_Y - CHEST_Y, 0);
    chest.add(sh);
    part(sh, [at(capsule(0.062, UPPER_ARM - 0.12, look.shirt), 0, -UPPER_ARM / 2, 0)], meshes);
    const el = new THREE.Group();
    el.position.y = -UPPER_ARM;
    sh.add(el);
    part(el, [
      at(capsule(0.052, FOREARM - 0.12, look.skin), 0, -FOREARM / 2, 0),
      at(sphereg(0.058, look.skin, 8, 6), 0, -FOREARM - 0.02, 0, 1, 0.9, 1.15),   // hand
    ], meshes);
    return { sh, el };
  };
  const aL = mkArm(-1), aR = mkArm(1);

  // one-handed weapons hang off the right hand
  const gunMount = new THREE.Object3D();
  gunMount.position.set(0, -FOREARM - 0.03, 0.03);
  aR.el.add(gunMount);

  // guns are shouldered instead, and the arms come to them
  const rifleMount = new THREE.Object3D();
  rifleMount.position.copy(RIFLE_POCKET);
  root.add(rifleMount);

  // ── legs: hip → knee → (shin + foot)
  const mkLeg = (side: number) => {
    const hp = new THREE.Group();
    hp.position.set(side * 0.095, -0.02, 0);
    hips.add(hp);
    part(hp, [at(capsule(0.088, THIGH - 0.19, look.pants), 0, -THIGH / 2, 0)], meshes);
    const kn = new THREE.Group();
    kn.position.y = -THIGH;
    hp.add(kn);
    part(kn, [
      at(capsule(0.07, SHIN - 0.2, look.pants), 0, -SHIN / 2 + 0.02, 0),
      at(boxg(0.105, 0.085, 0.24, look.shoes), 0, -SHIN + 0.04, 0.045),
      at(boxg(0.105, 0.055, 0.1, look.shoes), 0, -SHIN + 0.1, -0.03),
    ], meshes);
    return { hp, kn };
  };
  const lL = mkLeg(-1), lR = mkLeg(1);

  if (look.scale !== 1) root.scale.setScalar(look.scale);

  return {
    root, tilt, hips, chest, head,
    armL: aL.sh, armR: aR.sh, foreL: aL.el, foreR: aR.el,
    legL: lL.hp, legR: lR.hp, shinL: lL.kn, shinR: lR.kn,
    gunMount, grip: null, rifleMount, hold: null, pocket: RIFLE_POCKET.clone(), meshes, look,
    phase: Math.random() * TAU, aimW: 0, punchT: 0, punchSide: 1, slashing: false, hitT: 0, bob: 0,
    gripW: 0,
  };
}

export interface PoseInput {
  dt: number;
  t: number;
  /** horizontal speed in m/s */
  speed: number;
  runSpeed: number;
  grounded: boolean;
  airVy: number;
  aiming: boolean;
  /** radians above the horizon */
  aimPitch: number;
  /** 0 = alive, 1 = fully collapsed */
  dead: number;
  seated: boolean;
  crouching?: boolean;
  /** 0..1 punch swing */
  punch: number;
  /** which hand throws it: +1 right, -1 left. Alternating hands is what makes a combo. */
  punchSide?: number;
  /** a blade is swung in an arc, not jabbed straight out like a fist. */
  slash?: boolean;
  /** counts down after being shot */
  flinch: number;
  /** steering input while driving, −1..1 */
  steer: number;
  /** Where the camera is looking, relative to the body. This is what makes the character
   *  feel connected to the camera instead of staring blankly ahead while you look around. */
  lookYaw?: number;
  lookPitch?: number;
}

/** Drives every joint. Called once per frame per visible character. */
/** Hip height and skull top of a seated character, above their root. */
export interface SeatMetrics { hip: number; head: number }

/** The capsule rig's own proportions, which is what the seating code used to assume. */
export const CAPSULE_SEATED: SeatMetrics = { hip: 0.91, head: 1.65 };

/**
 * How this particular character folds up when they sit down.
 *
 * Ask, do not assume: the two rigs differ by 37cm at the hip, and using one set of numbers
 * for both put every driver of the shipping rig a foot too low in their seat.
 */
export function seatMetrics(h: Humanoid): SeatMetrics {
  return (h as AnimatedHumanoid).mixer ? ANIMATED_SEATED : CAPSULE_SEATED;
}

export function poseHumanoid(h: Humanoid, p: PoseInput): void {
  if ((h as AnimatedHumanoid).mixer) {
    poseAnimated(h as AnimatedHumanoid, p);
    return;
  }
  const dt = p.dt;
  h.aimW = damp(h.aimW, p.aiming ? 1 : 0, 12, dt);
  const aw = h.aimW;

  if (p.dead > 0) {
    poseDead(h, p.dead, dt);
    return;
  }

  if (p.seated) {
    poseSeated(h, p, dt);
    return;
  }

  const sr = clamp(p.speed / p.runSpeed, 0, 1.4);
  const walking = p.speed > 0.12;
  const cadence = walking ? 4.6 + sr * 4.2 : 0;
  h.phase = (h.phase + cadence * dt) % TAU;
  const ph = h.phase;
  const amp = clamp(p.speed / 2.4, 0, 1) * (p.grounded ? 1 : 0.25);

  // ── legs
  const thigh = Math.sin(ph) * (0.55 + sr * 0.32) * amp;
  const thigh2 = Math.sin(ph + Math.PI) * (0.55 + sr * 0.32) * amp;
  const kneeBend = (s: number) => -(0.13 + (0.75 + sr * 0.5) * Math.max(0, -Math.sin(s + 0.45))) * amp - 0.05;
  h.legL.rotation.x = thigh;
  h.legR.rotation.x = thigh2;
  h.shinL.rotation.x = kneeBend(ph);
  h.shinR.rotation.x = kneeBend(ph + Math.PI);
  // splay slightly so the legs never intersect
  h.legL.rotation.z = 0.035;
  h.legR.rotation.z = -0.035;

  if (!p.grounded) {
    // tuck in the air, then reach for the ground on the way down
    const land = clamp(-p.airVy / 6, 0, 1);
    h.legL.rotation.x = lerp(0.75, 0.18, land);
    h.legR.rotation.x = lerp(-0.2, 0.05, land);
    h.shinL.rotation.x = lerp(-1.1, -0.25, land);
    h.shinR.rotation.x = -0.35;
  }

  // ── hips / torso
  const crouchDrop = p.crouching ? 0.32 : 0;
  h.bob = damp(h.bob, Math.abs(Math.sin(ph)) * 0.05 * amp, 18, dt);
  h.hips.position.y = HIP_Y - crouchDrop + h.bob + (p.grounded ? 0 : -0.04) + Math.sin(p.t * 1.7) * 0.006;
  h.hips.rotation.z = Math.sin(ph) * 0.045 * amp;
  h.hips.rotation.y = -Math.sin(ph) * 0.09 * amp;
  h.tilt.rotation.x = damp(h.tilt.rotation.x, 0.03 + sr * 0.13 * (1 - aw * 0.6), 10, dt);
  h.tilt.rotation.z = damp(h.tilt.rotation.z, 0, 10, dt);

  // Look target, split between neck and spine the way a real neck does it — turning the
  // head alone past about 70° looks like an owl.
  const lookY = clamp(p.lookYaw ?? 0, -1.9, 1.9);
  const lookX = clamp(p.lookPitch ?? 0, -0.55, 0.7);
  const chestTwist = lerp(Math.sin(ph) * 0.1 * amp + lookY * 0.26, 0.34, aw);
  h.chest.rotation.y = chestTwist;
  h.chest.rotation.x = lerp(0.02, -0.06, aw);
  h.chest.rotation.z = 0;

  // ── head: follows the camera when free, follows the sights when aiming
  const headX = lerp(-0.02 + lookX * 0.55, -clamp(p.aimPitch, -0.7, 0.7) * 0.45, aw);
  const headY = lerp(lookY * 0.62 - Math.sin(ph * 0.5) * 0.05 * amp, -0.16, aw);
  h.head.rotation.x = damp(h.head.rotation.x, headX, 10, dt);
  h.head.rotation.y = damp(h.head.rotation.y, clamp(headY, -1.2, 1.2), 10, dt);
  h.head.rotation.z = -h.hips.rotation.z * 0.5 + lookY * 0.06;

  // ── arms
  h.punchT = Math.max(0, h.punchT - dt * (p.slash ? 3.9 : 4.6));
  if (p.punch > 0) {
    h.punchT = 1;
    h.punchSide = p.punchSide ?? 1;
    h.slashing = !!p.slash;
  }
  h.hitT = Math.max(0, p.flinch);

  const swingL = -Math.sin(ph) * (0.42 + sr * 0.3) * amp;
  const swingR = -Math.sin(ph + Math.PI) * (0.42 + sr * 0.3) * amp;
  const elbowIdle = -(0.22 + sr * 0.45) * (0.4 + amp * 0.6);

  // right arm: aiming down the sights when aw = 1
  const aimX = -Math.PI / 2 - clamp(p.aimPitch, -1.1, 1.1);
  const targetRX = lerp(swingR, aimX, aw);
  const targetRZ = lerp(0.06, -0.14, aw);
  const targetREl = lerp(elbowIdle, -0.16, aw);
  // left arm supports the grip
  const targetLX = lerp(swingL, -Math.PI / 2 - clamp(p.aimPitch, -1.1, 1.1) + 0.12, aw);
  const targetLZ = lerp(-0.06, 0.52, aw);
  const targetLEl = lerp(elbowIdle, -0.62, aw);

  /*
   * Melee.
   *
   * Two things were wrong with the old version and both were visible immediately: only
   * the right arm ever moved, so a flurry of clicks was the same jab over and over; and
   * a blade used the identical straight-out punch, which is not how anyone swings a
   * knife. Now the hands alternate — that is what makes a combo read as a combo — and a
   * blade travels in a horizontal arc with the shoulders following it through.
   */
  const pz = h.punchT;
  const swing = Math.sin(clamp(pz, 0, 1) * Math.PI);      // 0 -> 1 -> 0 over the strike
  const right = h.punchSide >= 0;
  const punching = pz > 0.01;

  // straight jab: shoulder drives forward, elbow snaps open
  const jabX = lerp(-0.4, -1.62, swing);
  const jabEl = lerp(-1.5, -0.12, swing);
  // blade: starts drawn back across the body and sweeps through to the far side
  const slashX = lerp(-0.55, -1.15, swing);
  const slashZ = lerp(right ? 1.15 : -1.15, right ? -0.75 : 0.75, swing);
  const slashEl = lerp(-1.75, -0.35, swing);

  const armX = h.slashing ? slashX : jabX;
  const armZ = h.slashing ? slashZ : (right ? 0.25 : -0.25);
  const armEl = h.slashing ? slashEl : jabEl;

  const liveR = punching && right;
  const liveL = punching && !right;
  h.armR.rotation.x = damp(h.armR.rotation.x, liveR ? armX : targetRX, 18, dt);
  h.armR.rotation.z = damp(h.armR.rotation.z, liveR ? armZ : targetRZ, 18, dt);
  h.foreR.rotation.x = damp(h.foreR.rotation.x, liveR ? armEl : targetREl, 18, dt);
  h.armL.rotation.x = damp(h.armL.rotation.x, liveL ? armX : targetLX, 18, dt);
  h.armL.rotation.z = damp(h.armL.rotation.z, liveL ? -armZ : targetLZ, 18, dt);
  h.foreL.rotation.x = damp(h.foreL.rotation.x, liveL ? armEl : targetLEl, 18, dt);

  // the whole body turns into a strike, which is most of what sells the weight of it
  if (punching) {
    const turn = swing * (right ? -1 : 1) * (h.slashing ? 0.42 : 0.26);
    h.chest.rotation.y += turn;
    h.hips.rotation.y += turn * 0.35;
  }

  if (h.hitT > 0) {
    const f = Math.min(1, h.hitT * 4);
    h.chest.rotation.x -= 0.22 * f;
    h.head.rotation.x -= 0.18 * f;
  }

  holdWeapon(h, p, {
    upperL: h.armL, lowerL: h.foreL, upperR: h.armR, lowerR: h.foreR,
    l1: UPPER_ARM, l2: FOREARM + 0.02, axis: DOWN,
  });
}

/** The arm bones and their lengths, whichever rig they came from. */
export interface ArmRig {
  upperL: THREE.Object3D;
  lowerL: THREE.Object3D;
  upperR: THREE.Object3D;
  lowerR: THREE.Object3D;
  l1: number;
  l2: number;
  axis: THREE.Vector3;
}

/** The capsule rig hangs its arms downwards; the glTF skeleton points its bones up. */
const DOWN = new THREE.Vector3(0, -1, 0);
export const BONE_UP = new THREE.Vector3(0, 1, 0);

const _shoulder = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _sol = makeTwoBone();

/**
 * Put the left hand on the weapon.
 *
 * Shared by both rigs because the problem is identical: the animation (or the pose code)
 * has no idea how long the gun is, so the off hand has to be solved rather than keyframed.
 * `weight` ramps so holstering does not snap the arm.
 *
 * The pole vector points down, back and outboard — that is where a human elbow goes when
 * they shoulder a rifle, and without it the solver is free to pick the mirror-image
 * solution with the elbow folded up through the ribs.
 */
export function holdWeapon(h: Humanoid, p: PoseInput, arms: ArmRig): void {
  const want = (h.grip || h.hold) && p.dead <= 0 && !p.seated && h.punchT <= 0.01
    && (h.grip?.atRest || h.hold !== null || p.aiming);
  h.gripW = damp(h.gripW, want ? 1 : 0, 12, p.dt);
  if (h.gripW < 0.02) return;

  // Aim the shouldered weapon before solving to it: the arms follow the gun, not the
  // other way round, which is why the muzzle tracks the camera exactly.
  if (h.hold) {
    const pitch = p.aiming ? -p.aimPitch : LOW_READY;
    h.rifleMount.rotation.x = damp(h.rifleMount.rotation.x, pitch, 12, p.dt);
    h.rifleMount.rotation.y = damp(h.rifleMount.rotation.y, p.aiming ? 0.06 : 0.22, 10, p.dt);
    _rest.copy(h.pocket);
    if (!p.aiming) _rest.add(REST_DROP);
    h.rifleMount.position.x = damp(h.rifleMount.position.x, _rest.x, 10, p.dt);
    h.rifleMount.position.y = damp(h.rifleMount.position.y, _rest.y, 10, p.dt);
    h.rifleMount.position.z = damp(h.rifleMount.position.z, _rest.z, 10, p.dt);
  }

  h.root.updateMatrixWorld(true);
  h.root.getWorldQuaternion(_q);

  if (h.hold) {
    h.hold.getWorldPosition(_target);
    reach(h, arms, arms.upperR, arms.lowerR, _target);
  }

  if (h.grip && (h.grip.atRest || p.aiming)) {
    h.grip.at.getWorldPosition(_target);
    reach(h, arms, arms.upperL, arms.lowerL, _target);
  }
}

/**
 * Solve one arm onto a point, with the elbow going where an elbow goes: down, back and
 * **outboard**.
 *
 * Which way "outboard" is gets asked of the rig rather than assumed, and that is the whole
 * point of this function. The two rigs disagree about handedness: `rgt()` is (−cos, sin),
 * so a character facing +Z has their left at +X — the glTF skeleton agrees, putting
 * `DEF-upper_arm.L` at +0.2 once the model's 180° flip is applied, while the capsule rig
 * builds its `armL` at −0.205, on the other side entirely.
 *
 * Hard-coding a pole per named side therefore cannot be right for both, and it was wrong
 * for the one that ships: both elbows were driven *inwards*, folding each forearm through
 * the ribcage. The hand still landed on the gun — both elbow solutions reach the same
 * target, which is exactly why the reach test passed — but the arm was inside the chest,
 * and a character with an arm inside their chest looks like a character with one arm.
 */
function reach(
  h: Humanoid, arms: ArmRig, upper: THREE.Object3D, lower: THREE.Object3D, target: THREE.Vector3,
): void {
  upper.getWorldPosition(_shoulder);
  _local.copy(_shoulder);
  h.root.worldToLocal(_local);
  _pole.set(_local.x >= 0 ? 1 : -1, -0.5, -0.75).applyQuaternion(_q).normalize();
  solveTwoBone(_shoulder, target, _pole, arms.l1, arms.l2, arms.axis, _sol);
  applyWorldRotation(upper, _sol.upper, h.gripW);
  applyWorldRotation(lower, _sol.lower, h.gripW);
}
const _local = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _rest = new THREE.Vector3();

function poseDead(h: Humanoid, d: number, dt: number): void {
  h.tilt.rotation.x = damp(h.tilt.rotation.x, -1.57, 9, dt);
  h.tilt.rotation.z = damp(h.tilt.rotation.z, 0.08, 8, dt);
  h.hips.position.y = damp(h.hips.position.y, 0.12, 10, dt);
  h.hips.rotation.set(0, 0, 0);
  h.chest.rotation.set(0.04, 0.08, 0);
  h.head.rotation.set(0.12, 0.35, 0);
  h.armL.rotation.set(-0.2, 0, -0.65);
  h.armR.rotation.set(-0.15, 0, 0.65);
  h.foreL.rotation.x = -0.1;
  h.foreR.rotation.x = -0.1;
  h.legL.rotation.set(0.05, 0, 0.15);
  h.legR.rotation.set(-0.05, 0, -0.15);
  h.shinL.rotation.x = -0.1;
  h.shinR.rotation.x = -0.1;
  void d;
}

function poseSeated(h: Humanoid, p: PoseInput, dt: number): void {
  h.tilt.rotation.x = damp(h.tilt.rotation.x, 0.12, 10, dt);
  h.tilt.rotation.z = damp(h.tilt.rotation.z, 0, 10, dt);
  h.hips.position.y = damp(h.hips.position.y, HIP_Y - 0.02, 10, dt);
  h.hips.rotation.set(0, 0, 0);
  h.chest.rotation.set(0.06, 0, 0);
  h.head.rotation.set(0, p.steer * -0.25, 0);
  // hands on the wheel, elbows out
  h.armL.rotation.set(-1.15 + p.steer * 0.4, 0, 0.34);
  h.armR.rotation.set(-1.15 - p.steer * 0.4, 0, -0.34);
  h.foreL.rotation.x = -0.55;
  h.foreR.rotation.x = -0.55;
  // legs folded into the footwell
  h.legL.rotation.set(-1.32, 0, 0.12);
  h.legR.rotation.set(-1.32, 0, -0.12);
  h.shinL.rotation.x = -1.05;
  h.shinR.rotation.x = -1.05;
  void dt;
}

/** Distance culling + shadow budget: only nearby characters cast shadows. */
export function setHumanoidDetail(h: Humanoid, visible: boolean, shadows: boolean): void {
  if (h.root.visible !== visible) h.root.visible = visible;
  if (!visible) return;
  for (let i = 0; i < h.meshes.length; i++) {
    if (h.meshes[i].castShadow !== shadows) h.meshes[i].castShadow = shadows;
  }
}

export function disposeHumanoid(h: Humanoid): void {
  const anim = h as AnimatedHumanoid;
  if (anim.mixer) {
    // The animated rig shares its geometry with every other character; only
    // disposeAnimatedHumanoid knows which buffers belong to this one.
    disposeAnimatedHumanoid(anim);
    h.root.removeFromParent();
    return;
  }
  for (const m of h.meshes) m.geometry.dispose();
  h.root.removeFromParent();
}

import * as THREE from 'three';

/**
 * Two-bone inverse kinematics, used to put the support hand on a weapon.
 *
 * Every gun in the game was held one-handed: the model hung off a socket on the right
 * hand and the left arm carried on swinging through whatever the animation clip said,
 * so a rifle looked welded to one fist rather than *held*. Animation cannot fix that —
 * the clip does not know how long an AK is — so the left arm is solved instead: given a
 * shoulder, a target and two bone lengths, there are exactly two elbow positions, and
 * picking the one nearest a pole vector is what stops the elbow inverting through the
 * ribcage.
 *
 * Deliberately free of any rig: it takes world positions and returns world rotations, so
 * the same solver drives the skinned mannequin's `DEF-` bones and the capsule rig's
 * groups, which point their bones in opposite directions.
 */

export interface TwoBone {
  /** where the elbow (or knee) ends up, in world space */
  elbow: THREE.Vector3;
  /** world rotation for the upper bone */
  upper: THREE.Quaternion;
  /** world rotation for the lower bone */
  lower: THREE.Quaternion;
  /** true when the target was out of reach and the arm was left straight towards it */
  stretched: boolean;
}

export function makeTwoBone(): TwoBone {
  return {
    elbow: new THREE.Vector3(),
    upper: new THREE.Quaternion(),
    lower: new THREE.Quaternion(),
    stretched: false,
  };
}

const _toT = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _other = new THREE.Vector3();
const _up = new THREE.Vector3();
const _low = new THREE.Vector3();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _fix = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);

/**
 * Aim a two-bone chain from `root` at `target`.
 *
 * `pole` is a world direction saying which way the joint should bend — behind and
 * outside the elbow, for an arm. `axis` is the direction the rig's bones point in their
 * own local space: +Y for the glTF skeleton, −Y for the capsule rig.
 *
 * Returns world rotations. The caller converts them to whatever local space its bones
 * live in, because only the caller knows the parent.
 */
export function solveTwoBone(
  root: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  l1: number,
  l2: number,
  axis: THREE.Vector3,
  out: TwoBone = makeTwoBone(),
): TwoBone {
  _toT.subVectors(target, root);
  let len = _toT.length();
  if (len < 1e-6) { _toT.set(0, 0, 1); len = 1e-6; }
  _dir.copy(_toT).divideScalar(len);

  // Out of reach: point straight at it rather than snapping to some nearer pose. Also
  // guard the degenerate folded case, where the law of cosines below divides by zero.
  const reach = l1 + l2;
  const fold = Math.abs(l1 - l2);
  out.stretched = len >= reach;
  const solve = Math.min(Math.max(len, fold + 1e-4), reach - 1e-4);

  // The bend plane. If the target happens to lie along the pole there is no plane to
  // pick, so fall back to any perpendicular rather than producing a zero-length normal.
  _n.crossVectors(_dir, pole);
  if (_n.lengthSq() < 1e-8) {
    _other.set(Math.abs(_dir.x) < 0.9 ? 1 : 0, Math.abs(_dir.x) < 0.9 ? 0 : 1, 0);
    _n.crossVectors(_dir, _other);
  }
  _n.normalize();

  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + solve * solve - l2 * l2) / (2 * l1 * solve)));
  const a = Math.acos(cosA);

  // Two elbows satisfy the triangle. Take the one on the pole's side — the other one is
  // the same arm with the elbow folded through the chest.
  _bend.copy(_dir).applyAxisAngle(_n, a);
  _other.copy(_dir).applyAxisAngle(_n, -a);
  if (_other.dot(pole) > _bend.dot(pole)) _bend.copy(_other);
  out.elbow.copy(_bend).multiplyScalar(l1).add(root);

  _up.subVectors(out.elbow, root).normalize();
  _low.subVectors(target, out.elbow);
  if (_low.lengthSq() < 1e-12) _low.copy(_up); else _low.normalize();

  // `axis` is where the bone points before rotation, so compose: first bring it onto +Y,
  // then swing +Y onto the bone direction with the bend plane holding the twist.
  _fix.setFromUnitVectors(axis, _Y);
  basis(_up, _n, out.upper).multiply(_fix);
  basis(_low, _n, out.lower).multiply(_fix);
  return out;
}

/** A rotation putting +Y along `y`, with `side` pinning the twist. */
function basis(y: THREE.Vector3, side: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _x.copy(side);
  _x.addScaledVector(y, -y.dot(_x));          // orthogonalise against drift
  if (_x.lengthSq() < 1e-10) {
    _x.set(Math.abs(y.x) < 0.9 ? 1 : 0, Math.abs(y.x) < 0.9 ? 0 : 1, 0).cross(y);
  }
  _x.normalize();
  _z.crossVectors(_x, y).normalize();
  _m.makeBasis(_x, y, _z);
  return out.setFromRotationMatrix(_m);
}

/**
 * Blend a bone towards a solved world rotation and write it back as a local one.
 *
 * `weight` is how much of the solve to apply, so the support hand can fade on and off —
 * dropping it in one frame when a gun is holstered reads as a glitch.
 */
const _parent = new THREE.Quaternion();
const _want = new THREE.Quaternion();
export function applyWorldRotation(bone: THREE.Object3D, world: THREE.Quaternion, weight: number): void {
  if (weight <= 0) return;
  const p = bone.parent;
  if (p) {
    p.getWorldQuaternion(_parent);
    _want.copy(_parent).invert().multiply(world);
  } else {
    _want.copy(world);
  }
  if (weight >= 1) bone.quaternion.copy(_want);
  else bone.quaternion.slerp(_want, weight);
  bone.updateMatrix();
  bone.updateMatrixWorld(true);
}

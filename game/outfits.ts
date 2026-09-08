import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Clothes.
 *
 * Everyone in the game used to be a bare mannequin tinted one flat colour, so the police
 * were recognisable only by being slightly navier than everyone else. They have a cap, a
 * white belt and epaulettes now, which read from fifty metres.
 *
 * There was a shalwar kameez here too. It was removed: as a rigid tunic on the hip bone it
 * read as a bell-shaped skirt rather than as clothing, and a bad kameez is worse than
 * none. Doing it properly means skinning the tunic to the skeleton so it deforms with the
 * legs, which is a different job from hanging props on bones.
 *
 * There are two rigs to dress. `character.glb` (a skinned Quaternius mannequin) is the
 * one that actually ships; `humanoid.ts` builds a capsule rig when that model is
 * missing, which is what the headless tests see. So the geometry lives here, authored
 * once in metres **relative to the joint it hangs from**, and each rig mounts it:
 *
 *   · the capsule rig merges it straight into the existing hips/chest/head meshes,
 *     so it costs nothing at all — no extra draw calls;
 *   · the animated rig hangs it off `DEF-hips` / `DEF-spine.003` / `DEF-head` as
 *     rigid props, one merged mesh per joint, so a dressed character costs at most
 *     three draw calls more than an undressed one.
 *
 * Rigid props on a bone are exactly right for a cap, a belt, epaulettes and a helmet —
 * they are rigid on a real person too, which is why what is left here works and the tunic
 * did not.
 */

export type Outfit = 'street' | 'police' | 'swat';
export type Hat = 'none' | 'topi' | 'peaked' | 'helmet';

/** The joints both rigs expose. Props are authored relative to these. */
export interface OutfitProps {
  hips: THREE.BufferGeometry | null;
  chest: THREE.BufferGeometry | null;
  head: THREE.BufferGeometry | null;
}

/**
 * Height of the top of the skull above the head joint, per rig.
 *
 * Headwear is the only thing here that needs it, and it needs it exactly: a cap is
 * measured down from the crown, not up from a joint, so anchoring to the crown is the
 * difference between a cap sitting on someone's head and a cap sitting inside it.
 *
 * The two rigs disagree because they hang the head from different places. The mannequin's
 * `DEF-head` is at the base of the skull, 1.485m up a 1.78m character (measured out of
 * character.glb: mesh height 1.8287 glb units, charScale 0.9734, head bone at 1.5122).
 * The capsule rig's head group is most of the way up the skull at 1.57m, with the sphere
 * topping out around 1.73m.
 */
export const SKULL_TOP = { animated: 0.295, capsule: 0.16 };

const TAU = Math.PI * 2;

/* Trim colours shared by the uniforms. */
const SILVER = 0xc2c6cf;
const GOLD = 0xd2ae48;
const BELT_WHITE = 0xe8e6dc;
const GEAR_BLACK = 0x14171c;

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
  if (geo.attributes.normal === undefined) geo.computeVertexNormals();
  return geo;
}

function tube(rTop: number, rBot: number, h: number, hex: number, seg = 12): THREE.BufferGeometry {
  return paint(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, false), hex);
}

function box(w: number, h: number, d: number, hex: number): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(w, h, d), hex);
}

function at(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z);
  return g;
}

/** Darken a colour without ever brightening it — a multiply cannot lighten. */
function shade(hex: number, k: number): number {
  return new THREE.Color(hex).multiplyScalar(k).getHex();
}

function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!geos.length) return null;
  return geos.length === 1 ? geos[0] : mergeGeometries(geos, false)!;
}

/* ── the garments ────────────────────────────────────────────────────────────── */

/** A prayer cap. Flat-topped, perched on the crown, worn by a slice of the street. */
function topi(crown: number): THREE.BufferGeometry[] {
  const cream = 0xe6e1d2;
  return [
    at(tube(0.112, 0.118, 0.062, cream, 14), 0, crown + 0.005, 0),
    at(tube(0.106, 0.112, 0.014, shade(cream, 0.86), 14), 0, crown + 0.039, 0),
  ];
}

/**
 * The police peaked cap: dark crown, black band, stiff peak and a badge. This is the
 * single most legible thing about a Pakistani constable at a distance, so it is worth
 * the eight triangles.
 */
function peakedCap(top: number, cloth: number): THREE.BufferGeometry[] {
  // Measured down from the crown: the band sits at brow level, 85mm below the top of
  // the skull, and the cap itself stands a little proud of it.
  const band = top - 0.085;
  return [
    at(tube(0.124, 0.124, 0.036, GEAR_BLACK, 14), 0, band, 0),                // band
    at(tube(0.118, 0.126, 0.075, cloth, 14), 0, band + 0.055, 0),             // crown
    at(tube(0.132, 0.118, 0.016, cloth, 14), 0, band + 0.1, 0),               // top plate
    at(box(0.235, 0.016, 0.115, GEAR_BLACK), 0, band - 0.011, 0.115),         // peak
    at(box(0.05, 0.052, 0.014, GOLD), 0, band + 0.03, 0.128),                 // badge
  ];
}

/** SWAT: a ballistic helmet, and nothing on the face so the ped still reads as a person. */
function helmet(top: number): THREE.BufferGeometry[] {
  const dome = paint(
    new THREE.SphereGeometry(0.142, 14, 9, 0, TAU, 0, Math.PI * 0.62),
    GEAR_BLACK,
  );
  dome.scale(1, 1.02, 1.06);
  return [
    at(dome, 0, top - 0.115, 0),
    at(tube(0.145, 0.145, 0.022, shade(GEAR_BLACK, 1.35), 14), 0, top - 0.108, 0), // rail band
  ];
}

/** Epaulettes and a shoulder flash — rank, which is what makes a uniform a uniform. */
function epaulettes(): THREE.BufferGeometry[] {
  return [
    at(box(0.095, 0.022, 0.078, SILVER), -0.155, 0.185, 0),
    at(box(0.095, 0.022, 0.078, SILVER), 0.155, 0.185, 0),
    at(box(0.11, 0.06, 0.016, shade(GOLD, 0.85)), 0, 0.10, 0.14),  // breast tape
  ];
}

/** The white patrol belt, with a buckle. Unmistakable, and free. */
function beltWhite(): THREE.BufferGeometry[] {
  return [
    at(tube(0.176, 0.176, 0.052, BELT_WHITE, 14), 0, 0.10, 0),
    at(box(0.062, 0.058, 0.02, GOLD), 0, 0.10, 0.172),
    at(box(0.09, 0.13, 0.055, GEAR_BLACK), 0.15, 0.03, 0.03),      // holster
  ];
}

/** SWAT plate carrier: a slab across the chest with two pouches. */
function plateCarrier(): THREE.BufferGeometry[] {
  const rig = shade(GEAR_BLACK, 1.5);
  return [
    at(box(0.335, 0.30, 0.26, rig), 0, 0.06, 0.012),
    at(box(0.085, 0.075, 0.05, GEAR_BLACK), -0.075, -0.03, 0.16),
    at(box(0.085, 0.075, 0.05, GEAR_BLACK), 0.075, -0.03, 0.16),
    at(box(0.2, 0.05, 0.06, GEAR_BLACK), 0, 0.155, 0.125),         // collar plate
  ];
}

/* ── assembly ────────────────────────────────────────────────────────────────── */

/**
 * Build every prop for one outfit, merged into at most one geometry per joint.
 *
 * `crown` is the rig's skull-top constant (see `SKULL_TOP`). Returns nulls for
 * `'street'`, so an undressed character costs exactly what it always did.
 */
export function buildOutfit(
  outfit: Outfit,
  hat: Hat,
  colors: { shirt: number; pants: number },
  crown: number,
): OutfitProps {
  const hips: THREE.BufferGeometry[] = [];
  const chest: THREE.BufferGeometry[] = [];
  const head: THREE.BufferGeometry[] = [];

  if (outfit === 'police') {
    hips.push(...beltWhite());
    chest.push(...epaulettes());
  }
  if (outfit === 'swat') chest.push(...plateCarrier());

  if (hat === 'topi') head.push(...topi(crown));
  else if (hat === 'peaked') head.push(...peakedCap(crown, colors.shirt));
  else if (hat === 'helmet') head.push(...helmet(crown));

  return { hips: merge(hips), chest: merge(chest), head: merge(head) };
}

/** Whether an outfit puts anything on the model at all. */
export function isDressed(outfit: Outfit, hat: Hat): boolean {
  return outfit !== 'street' || hat !== 'none';
}

/**
 * The hat a given outfit implies when nobody picked one. Police wear the cap, SWAT the
 * helmet; the street is mixed, so `peds.ts` rolls for a topi and passes it in.
 */
export function defaultHat(outfit: Outfit): Hat {
  if (outfit === 'police') return 'peaked';
  if (outfit === 'swat') return 'helmet';
  return 'none';
}

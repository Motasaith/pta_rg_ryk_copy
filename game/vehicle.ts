import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, damp, fwdX, fwdZ, rgtX, rgtZ, wrapPi } from './mathx';
import { Box, KIND, Physics } from './physics';
import { Humanoid } from './humanoid';
import { tex } from './materials';
import type { AssetBank } from './assets';

export type VehKind = 'sedan' | 'hatch' | 'suv' | 'van' | 'sports' | 'police' | 'rickshaw' | 'muscle' | 'hyper' | 'truck';

export interface VehSpec {
  maxSpeed: number;      // m/s
  reverseMax: number;
  accel: number;
  brake: number;
  /** lateral grip: higher = less slide */
  grip: number;
  driftGrip: number;
  wheelbase: number;
  maxSteer: number;
  halfL: number;
  halfW: number;
  height: number;
  wheelR: number;
  seat: [number, number, number];
  camBack: number;
  camUp: number;
  mass: number;
  name: string;
  /** seconds of nitrous at full tilt; boostPower multiplies engine torque */
  boostTime: number;
  boostPower: number;
  /** shown in the HUD and the car-spotting stats */
  cls: 'city' | 'family' | 'utility' | 'muscle' | 'super' | 'hyper' | 'service';
}

/**
 * The class ladder. maxSpeed is now the *real* terminal velocity — the aero drag constant
 * is derived from it — so these numbers are what the speedometer will actually show.
 *
 *   rickshaw  75 km/h    van 130    hatch 155    suv 165    sedan 180
 *   police   205 km/h    muscle 225    sports 255    hyper 340 (+ boost)
 */
export const SPECS: Record<VehKind, VehSpec> = {
  rickshaw: { maxSpeed: 21, reverseMax: 7, accel: 4.2, brake: 15, grip: 5, driftGrip: 1.3, wheelbase: 1.9, maxSteer: 0.75, halfL: 1.5, halfW: 0.7, height: 1.75, wheelR: 0.3, seat: [0, 0.6, 0.1], camBack: 6, camUp: 3, mass: 500, name: 'RICKSHAW', boostTime: 2, boostPower: 1.3, cls: 'service' },
  van:      { maxSpeed: 36, reverseMax: 9, accel: 4.6, brake: 19, grip: 6, driftGrip: 1.4, wheelbase: 3.2, maxSteer: 0.46, halfL: 2.6, halfW: 1.1, height: 2.1, wheelR: 0.38, seat: [-0.5, 0.95, 0.7], camBack: 9, camUp: 3.8, mass: 2100, name: 'PANEL VAN', boostTime: 2.5, boostPower: 1.35, cls: 'utility' },
  hatch:    { maxSpeed: 43, reverseMax: 10, accel: 5.6, brake: 22, grip: 7.2, driftGrip: 1.6, wheelbase: 2.4, maxSteer: 0.6, halfL: 1.95, halfW: 0.9, height: 1.55, wheelR: 0.32, seat: [-0.4, 0.64, 0.2], camBack: 7, camUp: 3, mass: 1100, name: 'HATCHBACK', boostTime: 3, boostPower: 1.4, cls: 'city' },
  suv:      { maxSpeed: 46, reverseMax: 10, accel: 6.1, brake: 21, grip: 6.6, driftGrip: 1.5, wheelbase: 2.9, maxSteer: 0.5, halfL: 2.35, halfW: 1.05, height: 1.85, wheelR: 0.4, seat: [-0.46, 0.82, 0.3], camBack: 8, camUp: 3.4, mass: 1900, name: 'SUV', boostTime: 3, boostPower: 1.4, cls: 'utility' },
  sedan:    { maxSpeed: 50, reverseMax: 11, accel: 7.2, brake: 24, grip: 7.5, driftGrip: 1.6, wheelbase: 2.7, maxSteer: 0.55, halfL: 2.2, halfW: 0.95, height: 1.5, wheelR: 0.34, seat: [-0.42, 0.62, 0.25], camBack: 7.4, camUp: 3, mass: 1300, name: 'SEDAN', boostTime: 3.5, boostPower: 1.45, cls: 'family' },
  police:   { maxSpeed: 57, reverseMax: 12, accel: 8.8, brake: 27, grip: 8.4, driftGrip: 1.8, wheelbase: 2.8, maxSteer: 0.56, halfL: 2.25, halfW: 0.98, height: 1.55, wheelR: 0.35, seat: [-0.42, 0.64, 0.25], camBack: 7.6, camUp: 3.1, mass: 1450, name: 'POLICE CRUISER', boostTime: 4, boostPower: 1.5, cls: 'service' },
  muscle:   { maxSpeed: 62, reverseMax: 12, accel: 10.4, brake: 26, grip: 7.8, driftGrip: 2.3, wheelbase: 2.9, maxSteer: 0.5, halfL: 2.35, halfW: 1.02, height: 1.38, wheelR: 0.37, seat: [-0.42, 0.58, 0.2], camBack: 8, camUp: 2.9, mass: 1600, name: 'MUSCLE', boostTime: 4.5, boostPower: 1.7, cls: 'muscle' },
  sports:   { maxSpeed: 71, reverseMax: 12, accel: 13.2, brake: 30, grip: 9.6, driftGrip: 1.9, wheelbase: 2.6, maxSteer: 0.52, halfL: 2.15, halfW: 1, height: 1.25, wheelR: 0.34, seat: [-0.4, 0.5, 0.15], camBack: 7.6, camUp: 2.6, mass: 1250, name: 'SPORTS', boostTime: 5, boostPower: 1.8, cls: 'super' },
  truck:    { maxSpeed: 24, reverseMax: 6, accel: 3.4, brake: 13, grip: 5.2, driftGrip: 1.2, wheelbase: 4.6, maxSteer: 0.4, halfL: 4.3, halfW: 1.32, height: 3.7, wheelR: 0.54, seat: [-0.62, 1.72, 2.2], camBack: 13, camUp: 5.4, mass: 9000, name: 'BEDFORD TRUCK', boostTime: 1.5, boostPower: 1.12, cls: 'utility' },
  hyper:    { maxSpeed: 94, reverseMax: 13, accel: 18, brake: 34, grip: 11.5, driftGrip: 2.1, wheelbase: 2.75, maxSteer: 0.46, halfL: 2.3, halfW: 1.05, height: 1.14, wheelR: 0.35, seat: [-0.38, 0.46, 0.1], camBack: 8.6, camUp: 2.5, mass: 1300, name: 'HYPERCAR', boostTime: 6, boostPower: 2.0, cls: 'hyper' },
};

export interface VehicleControl {
  throttle: number;   // 0..1
  brake: number;      // 0..1
  /** −1..1, where +1 steers RIGHT (the D key). Right turns decrease yaw — see mathx.ts. */
  steer: number;
  handbrake: boolean;
  boost: boolean;
}

export interface Vehicle {
  kind: VehKind;
  /** body colour as given to createVehicle, kept so the wire can send a palette index */
  colour: number;
  spec: VehSpec;
  group: THREE.Group;
  wheelMeshes: { mesh: THREE.Object3D; front: boolean }[];
  bodyPivot: THREE.Group;
  brakeLight: THREE.Mesh | null;
  lightbar: { l: THREE.Mesh; r: THREE.Mesh } | null;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** world velocity */
  vx: number;
  vz: number;
  /** signed forward speed */
  speed: number;
  steerAngle: number;
  wheelSpin: number;
  health: number;
  /** 0..1 nitrous remaining */
  boost: number;
  boosting: boolean;
  /** true while the tank recovers from empty; blocks re-engagement */
  boostLock: boolean;
  ctrl: VehicleControl;
  driver: Humanoid | null;
  isPlayer: boolean;
  siren: boolean;
  box: Box;
  /** traffic AI state (null once a human takes the wheel) */
  ai: null | { from: number; to: number; t: number; wait: number; chase: boolean };
  hornT: number;
  crashT: number;
  bodyRoll: number;
  bodyPitch: number;
  /**
   * Stable id for network sync, 0 for a car that is never sent. Assigned by Traffic, not
   * by createVehicle, because only cars in the ambient set need one.
   */
  netId: number;
}

/* ── model ────────────────────────────────────────────────────────────────── */

let bodyMat: THREE.MeshStandardMaterial | null = null;
let glassMat: THREE.MeshStandardMaterial | null = null;
let lightMat: THREE.MeshStandardMaterial | null = null;
let brakeMat: THREE.MeshStandardMaterial | null = null;

let artMat: THREE.MeshStandardMaterial | null = null;

/** The painted panels of a jingle truck get a real texture, not a flat colour. */
function truckArtMaterial(): THREE.MeshStandardMaterial {
  if (!artMat) {
    artMat = new THREE.MeshStandardMaterial({ map: tex.truckArt(), roughness: 0.42, metalness: 0.22 });
  }
  return artMat;
}

function mats() {
  if (!bodyMat) {
    bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.42 });
    glassMat = new THREE.MeshStandardMaterial({ color: 0x14202b, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.72 });
    lightMat = new THREE.MeshStandardMaterial({ color: 0xfff4d0, emissive: 0xfff0c0, emissiveIntensity: 1.4, roughness: 0.3 });
    brakeMat = new THREE.MeshStandardMaterial({ color: 0x8c1a10, emissive: 0xff2200, emissiveIntensity: 0.35, roughness: 0.4 });
  }
  return { bodyMat: bodyMat!, glassMat: glassMat!, lightMat: lightMat!, brakeMat: brakeMat! };
}

function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function pbox(w: number, h: number, d: number, hex: number, x = 0, y = 0, z = 0, rx = 0): THREE.BufferGeometry {
  const g = paint(new THREE.BoxGeometry(w, h, d), hex);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return g;
}

/** Squeeze the top face of a box so cabins and bonnets get a real car silhouette. */
function taper(g: THREE.BufferGeometry, sx: number, sz: number, aboveY: number): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > aboveY) {
      p.setX(i, p.getX(i) * sx);
      p.setZ(i, p.getZ(i) * sz);
    }
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Cabin height per class — this is most of what makes a silhouette read as a supercar. */
const CAB_H: Partial<Record<VehKind, number>> = {
  van: 1.1, suv: 0.92, sports: 0.6, muscle: 0.68, hyper: 0.5, rickshaw: 0.9, truck: 1.5,
};

function wheel(r: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const tyre = paint(new THREE.CylinderGeometry(r, r, width, 14), 0x15171a);
  tyre.rotateZ(Math.PI / 2);
  const rim = paint(new THREE.CylinderGeometry(r * 0.58, r * 0.58, width + 0.012, 10), 0x9aa2aa);
  rim.rotateZ(Math.PI / 2);
  const spokes: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const s = paint(new THREE.BoxGeometry(width + 0.02, r * 0.9, 0.05), 0x767d85);
    s.rotateX((i / 5) * Math.PI);
    spokes.push(s);
  }
  const merged = mergeGeometries([tyre, rim, ...spokes], false)!;
  const m = new THREE.Mesh(merged, mats().bodyMat);
  m.castShadow = true;
  g.add(m);
  return g;
}

export function createVehicle(kind: VehKind, colour: number): Vehicle {
  const proto = modelProtos.get(kind);
  if (proto) return createModelVehicle(proto, kind, colour);
  const spec = SPECS[kind];
  const M = mats();
  const group = new THREE.Group();
  const bodyPivot = new THREE.Group();
  group.add(bodyPivot);

  const L = spec.halfL, W = spec.halfW, wr = spec.wheelR;
  const sillY = wr * 0.85;
  const parts: THREE.BufferGeometry[] = [];
  const dark = 0x1b1e22;

  if (kind === 'truck') {
    // A Bedford: high bonnet, upright cab, a carved crown ("taj") over the roof, a long
    // painted cargo body, mudflaps and a fringe of chains along the tailgate.
    const chrome = 0xb9c2c9;
    parts.push(pbox(W * 2, 0.34, L * 2 - 0.4, 0x2b2f33, 0, sillY + 0.3, 0));          // chassis
    parts.push(pbox(W * 1.95, 1.05, 2.2, colour, 0, sillY + 0.95, L - 1.5));           // bonnet
    parts.push(taper(pbox(W * 2, 1.9, 2.3, colour, 0, sillY + 2.1, L - 2.9), 0.94, 0.92, 0)); // cab
    parts.push(pbox(W * 2.06, 0.5, 0.36, chrome, 0, sillY + 0.62, L - 0.22));          // front bumper
    parts.push(pbox(W * 1.7, 0.7, 0.14, chrome, 0, sillY + 1.2, L - 0.42));            // grille
    for (const sx of [-1, 1]) {
      parts.push(pbox(0.26, 0.26, 0.16, 0xfff4d0, sx * W * 1.3, sillY + 1.05, L - 0.3));  // lamps
      parts.push(pbox(0.07, 0.07, 1.1, chrome, sx * (W * 2.05), sillY + 2.4, L - 2.2));   // mirror stalks
      parts.push(pbox(0.1, 0.42, 0.3, 0x22262b, sx * (W * 2.4), sillY + 2.5, L - 1.75));
    }
    // crown over the cab
    parts.push(pbox(W * 2.1, 0.9, 0.5, colour, 0, sillY + 3.35, L - 3.6));
    for (let i = -3; i <= 3; i++) {
      const hh = 0.55 - Math.abs(i) * 0.07;
      parts.push(pbox(0.34, hh, 0.34, i % 2 ? 0xf6c445 : 0xd62828, i * 0.38, sillY + 4.05 + hh / 2, L - 3.6));
    }
    // cargo body shell
    parts.push(pbox(W * 2.1, 0.24, L * 1.35, 0x3a3f45, 0, sillY + 0.62, -L * 0.28));   // bed floor
    parts.push(pbox(W * 2.1, 0.28, 1.0, chrome, 0, sillY + 2.9, -L * 0.95));           // top rail
    // mudflaps + chain fringe
    for (const sx of [-1, 1]) parts.push(pbox(0.5, 0.6, 0.06, 0x1a1d20, sx * W * 1.2, sillY + 0.2, -L + 0.1));
    for (let i = -5; i <= 5; i++) parts.push(pbox(0.05, 0.34, 0.05, chrome, i * 0.24, sillY + 0.45, -L + 0.02));
  } else if (kind === 'rickshaw') {
    parts.push(pbox(W * 1.9, 0.5, L * 1.5, colour, 0, sillY + 0.3, -0.2));
    parts.push(taper(pbox(W * 1.8, 0.9, L * 1.2, colour, 0, sillY + 1, -0.3), 0.8, 0.85, 0.2));
    parts.push(pbox(W * 1.4, 0.6, 0.5, dark, 0, sillY + 0.55, L * 0.9));
    parts.push(pbox(0.1, 0.5, 0.1, dark, 0, sillY + 0.9, L * 0.75));
  } else {
    // chassis + sills
    parts.push(pbox(W * 2, 0.34, L * 2 - 0.2, colour, 0, sillY + 0.17, 0));
    // bonnet and boot, slightly tapered
    parts.push(taper(pbox(W * 1.94, 0.34, L * 0.78, colour, 0, sillY + 0.5, L * 0.55), 0.94, 1, 0));
    parts.push(taper(pbox(W * 1.94, 0.34, L * 0.6, colour, 0, sillY + 0.5, -L * 0.68), 0.96, 1, 0));
    // cabin
    const cabH = CAB_H[kind] ?? 0.78;
    const cabD = kind === 'van' ? L * 1.25 : L * 0.95;
    const cab = taper(pbox(W * 1.86, cabH, cabD, colour, 0, sillY + 0.34 + cabH / 2, kind === 'van' ? 0 : -L * 0.12), 0.88, 0.82, 0);
    parts.push(cab);
    // roof edge
    parts.push(pbox(W * 1.6, 0.06, cabD * 0.82, colour, 0, sillY + 0.34 + cabH, kind === 'van' ? 0 : -L * 0.12));
    // bumpers + grille + arches
    parts.push(pbox(W * 2.02, 0.24, 0.2, dark, 0, sillY + 0.22, L - 0.06));
    parts.push(pbox(W * 2.02, 0.24, 0.2, dark, 0, sillY + 0.22, -L + 0.06));
    parts.push(pbox(W * 1.5, 0.16, 0.1, dark, 0, sillY + 0.46, L - 0.02));
    for (const sx of [-1, 1]) {
      for (const sz of [1, -1]) {
        parts.push(pbox(0.12, 0.3, wr * 2.5, dark, sx * W * 1.02, sillY + 0.3, sz * spec.wheelbase / 2));
      }
      parts.push(pbox(0.1, 0.16, 0.24, dark, sx * (W * 1.02 + 0.05), sillY + 0.75, L * 0.42));  // mirrors
      parts.push(pbox(0.03, 0.06, L * 1.1, dark, sx * W * 1.01, sillY + 0.42, -L * 0.1));       // door line
    }
    parts.push(pbox(0.06, 0.06, 0.3, dark, W * 0.6, sillY + 0.02, -L + 0.02));                  // exhaust
    if (kind === 'van') parts.push(pbox(W * 1.5, 0.08, L * 1.1, 0x9aa2aa, 0, sillY + 0.34 + cabH + 0.1, 0));
    if (kind === 'sports' || kind === 'muscle') parts.push(pbox(W * 1.7, 0.06, 0.3, dark, 0, sillY + 0.72, -L + 0.1)); // spoiler
    if (kind === 'hyper') {
      // big rear wing on stanchions, plus a front splitter and side strakes
      parts.push(pbox(W * 1.85, 0.07, 0.52, dark, 0, sillY + 1.02, -L + 0.16));
      for (const sx of [-1, 1]) parts.push(pbox(0.08, 0.3, 0.3, dark, sx * W * 0.7, sillY + 0.86, -L + 0.2));
      parts.push(pbox(W * 2.05, 0.07, 0.5, dark, 0, sillY + 0.1, L - 0.1));
      for (const sx of [-1, 1]) parts.push(pbox(0.06, 0.16, L * 0.9, dark, sx * (W * 1.03), sillY + 0.16, 0));
    }
  }

  const bodyMesh = new THREE.Mesh(mergeGeometries(parts, false)!, M.bodyMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyPivot.add(bodyMesh);

  // painted panels (their own textured material, so the art actually shows)
  if (kind === 'truck') {
    const art = truckArtMaterial();
    const panel = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), art);
      m.position.set(x, y, z);
      m.castShadow = true;
      bodyPivot.add(m);
    };
    panel(0.1, 2.3, L * 1.3, -W * 2.02, sillY + 1.85, -L * 0.28);   // left side
    panel(0.1, 2.3, L * 1.3, W * 2.02, sillY + 1.85, -L * 0.28);    // right side
    panel(W * 4, 2.3, 0.12, 0, sillY + 1.85, -L * 0.99);            // tailgate
    panel(W * 2.05, 0.8, 0.12, 0, sillY + 3.35, L - 3.9);           // crown face
    panel(W * 1.4, 0.42, 0.1, 0, sillY + 0.72, L - 0.44);           // bonnet plate
  }

  // glazing
  if (kind !== 'rickshaw' && kind !== 'truck') {
    const cabH = CAB_H[kind] ?? 0.78;
    const zc = kind === 'van' ? 0 : -L * 0.12;
    const cabD = kind === 'van' ? L * 1.25 : L * 0.95;
    const glassParts: THREE.BufferGeometry[] = [
      paint(new THREE.BoxGeometry(W * 1.6, cabH * 0.8, 0.06), 0xffffff),
      paint(new THREE.BoxGeometry(W * 1.55, cabH * 0.7, 0.06), 0xffffff),
      paint(new THREE.BoxGeometry(0.06, cabH * 0.62, cabD * 0.72), 0xffffff),
      paint(new THREE.BoxGeometry(0.06, cabH * 0.62, cabD * 0.72), 0xffffff),
    ];
    glassParts[0].rotateX(-0.42);
    glassParts[0].translate(0, sillY + 0.34 + cabH * 0.55, zc + cabD / 2 - 0.1);
    glassParts[1].rotateX(0.5);
    glassParts[1].translate(0, sillY + 0.34 + cabH * 0.55, zc - cabD / 2 + 0.1);
    glassParts[2].translate(-W * 0.9, sillY + 0.34 + cabH * 0.6, zc);
    glassParts[3].translate(W * 0.9, sillY + 0.34 + cabH * 0.6, zc);
    const gm = new THREE.Mesh(mergeGeometries(glassParts, false)!, M.glassMat);
    bodyPivot.add(gm);
  }

  // lamps
  const head: THREE.BufferGeometry[] = [];
  const tail: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const h = new THREE.BoxGeometry(0.34, 0.14, 0.08);
    h.translate(sx * W * 1.2, sillY + 0.46, L - 0.02);
    head.push(h);
    const t = new THREE.BoxGeometry(0.3, 0.14, 0.08);
    t.translate(sx * W * 1.2, sillY + 0.5, -L + 0.02);
    tail.push(t);
  }
  const headMesh = new THREE.Mesh(mergeGeometries(head, false)!, M.lightMat);
  const brakeMesh = new THREE.Mesh(mergeGeometries(tail, false)!, M.brakeMat.clone());
  bodyPivot.add(headMesh, brakeMesh);

  // police lightbar
  let lightbar: Vehicle['lightbar'] = null;
  if (kind === 'police') {
    const barY = sillY + 0.34 + (CAB_H.police ?? 0.78) + 0.12;
    const base = new THREE.Mesh(paint(new THREE.BoxGeometry(W * 1.5, 0.08, 0.34), 0x111417), M.bodyMat);
    base.position.set(0, barY, -L * 0.1);
    const mkLamp = (sx: number, colour2: number) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(W * 0.62, 0.14, 0.3),
        new THREE.MeshStandardMaterial({ color: colour2, emissive: colour2, emissiveIntensity: 0, roughness: 0.3, transparent: true, opacity: 0.9 }),
      );
      m.position.set(sx * W * 0.42, barY + 0.1, -L * 0.1);
      return m;
    };
    const l = mkLamp(-1, 0x2244ff), r = mkLamp(1, 0xff2222);
    bodyPivot.add(base, l, r);
    lightbar = { l, r };
    // white door panels
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(paint(new THREE.BoxGeometry(0.04, 0.5, L * 0.9), 0xf2f2f2), M.bodyMat);
      p.position.set(sx * (W * 1.01 + 0.01), sillY + 0.42, -L * 0.1);
      bodyPivot.add(p);
    }
  }

  // wheels
  const wheelMeshes: Vehicle['wheelMeshes'] = [];
  const wb = spec.wheelbase / 2;
  const positions: [number, number, boolean][] = kind === 'rickshaw'
    ? [[0, wb, true], [-W * 0.9, -wb, false], [W * 0.9, -wb, false]]
    : kind === 'truck'
      // two steering wheels up front, four on the rear axle
      ? [[-W * 0.98, wb, true], [W * 0.98, wb, true],
         [-W * 0.86, -wb, false], [-W * 1.14, -wb, false],
         [W * 0.86, -wb, false], [W * 1.14, -wb, false]]
      : [[-W * 1.02, wb, true], [W * 1.02, wb, true], [-W * 1.02, -wb, false], [W * 1.02, -wb, false]];
  for (const [wx, wz, front] of positions) {
    const w = wheel(wr, 0.22);
    w.position.set(wx, wr, wz);
    group.add(w);
    wheelMeshes.push({ mesh: w, front });
  }

  const v = finishVehicle(kind, colour, group, wheelMeshes, bodyPivot, brakeMesh, lightbar);
  return v;
}

export function placeVehicle(v: Vehicle, x: number, z: number, yaw: number): void {
  v.x = x; v.z = z; v.yaw = yaw;
  v.vx = 0; v.vz = 0; v.speed = 0;
  v.group.position.set(x, v.y, z);
  v.group.rotation.y = yaw;
}

/* ── downloaded GLTF models ───────────────────────────────────────────────────
 *
 * Quaternius CC0 cars (poly.pizza mirrors). The GLTFs arrive in wildly different
 * conventions — flat hierarchies with baked geometry, or scaled/rotated nodes — so
 * each one is normalized ONCE into a prototype:
 *
 *   • scaled to the class spec's length, origin centred, wheels on the ground
 *   • nose pointed at +Z (our forward), decided by where the headlight mesh sits
 *   • every wheel mesh re-centred on its own axle and hung under a pivot named
 *     "WHEELPIVOT_F…" / "WHEELPIVOT_R…", matching the procedural wheel contract
 *     (pivot steers on Y, its child spins on X)
 *   • meshes tagged via userData for per-instance tinting and the brake/lightbar
 *
 * Spawning then is a cheap deep clone; materials are cloned so paint and lamp
 * glow vary per car. The rickshaw, Bedford jingle truck and panel van stay
 * procedural — no CC0 model looks the part.
 */

const WHEEL_NAME_RE = /frontleft|frontright|frontwheel_?l|frontwheel_?r|backwheels|rearwheels/i;
const FRONT_NAME_RE = /front/i;
/** Materials that must survive tinting untouched. */
const UNDYED_RE = /windows|glass|headlights?|taillights?|brakelight|black|grey|gray|tires?|tyres?|wheels?|bluelights|whitelights|atlas|chrome|lights?/i;

const modelProtos = new Map<VehKind, THREE.Object3D>();

export function initVehicleModels(bank: AssetBank): void {
  const files: Partial<Record<VehKind, string>> = {
    sedan: 'sedan', hatch: 'hatch', suv: 'suv', police: 'police',
    sports: 'sports', muscle: 'muscle', hyper: 'hyper',
  };
  for (const [kind, file] of Object.entries(files) as [VehKind, string][]) {
    const scene = bank.model(file);
    if (scene) modelProtos.set(kind, preparePrototype(scene, SPECS[kind]));
  }
}

function preparePrototype(scene: THREE.Object3D, spec: VehSpec): THREE.Object3D {
  const container = new THREE.Group();
  container.add(scene);
  scene.updateMatrixWorld(true);

  // Split wheel meshes out, flattening whatever transform chain they arrived in.
  const wheelMeshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.name && WHEEL_NAME_RE.test(o.name)) wheelMeshes.push(o as THREE.Mesh);
  });
  for (const wm of wheelMeshes) {
    const geo = wm.geometry.clone();
    geo.applyMatrix4(wm.matrixWorld);          // bake the whole chain into the vertices
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const c = bb.getCenter(new THREE.Vector3());
    geo.translate(-c.x, -c.y, -c.z);           // spin around the axle, not the car
    // A downloaded wheel never matches spec.wheelR exactly; resize so it meets the
    // ground when the pivot is pinned to y = wheelR each frame.
    const r = Math.max(bb.max.y - bb.min.y, bb.max.z - bb.min.z) / 2;
    if (r > 1e-4) geo.scale(spec.wheelR / r, spec.wheelR / r, spec.wheelR / r);
    const vis = new THREE.Mesh(geo, wm.material);
    vis.name = 'wheelVisual';
    vis.castShadow = true;
    const pivot = new THREE.Group();
    pivot.name = 'WHEELPIVOT_' + (FRONT_NAME_RE.test(wm.name) ? 'F' : 'R');
    pivot.position.copy(c);
    pivot.add(vis);
    wm.parent?.add(pivot);
    wm.removeFromParent();
  }

  // Lamp emissives + tint/body tagging on the shared prototype materials.
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const raw of mats) {
      const mat = raw as THREE.MeshStandardMaterial;
      if (!mat || !mat.name) continue;
      const n = mat.name.toLowerCase();
      if (/headlights?/.test(n)) { mat.emissive = new THREE.Color(0xfff0c2); mat.emissiveIntensity = 1.1; }
      else if (/taillights?|brakelight/.test(n)) { mat.emissive = new THREE.Color(0xff2200); mat.emissiveIntensity = 0.25; m.userData.lights = 'tail'; }
      else if (/bluelights?/.test(n)) { mat.emissive = new THREE.Color(0x2255ff); mat.emissiveIntensity = 0; m.userData.lights = 'barL'; }
      else if (/whitelights?/.test(n)) { mat.emissive = new THREE.Color(0xffffff); mat.emissiveIntensity = 0; m.userData.lights = 'barR'; }
      if (!UNDYED_RE.test(n)) m.userData.tintable = true;
    }
  });

  // Which way is forward? Ask the headlights.
  let headZ = 0;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (mats.some((x) => /headlights?/i.test((x as THREE.MeshStandardMaterial).name || ''))) {
      m.geometry.computeBoundingBox();
      headZ += m.geometry.boundingBox!.getCenter(new THREE.Vector3()).z;
    }
  });
  if (headZ < 0) container.rotation.y = Math.PI;

  // Fit to the spec's footprint.
  container.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(container);
  const size = box.getSize(new THREE.Vector3());
  const scale = (spec.halfL * 2) / Math.max(size.z, 1e-4);
  container.scale.setScalar(scale);
  container.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(container);
  const c2 = box2.getCenter(new THREE.Vector3());
  container.position.set(-c2.x, -box2.min.y, -c2.z);
  container.updateMatrixWorld(true);
  return container;
}

function createModelVehicle(proto: THREE.Object3D, kind: VehKind, colour: number): Vehicle {
  const spec = SPECS[kind];
  const group = new THREE.Group();
  const bodyPivot = new THREE.Group();
  group.add(bodyPivot);

  const root = proto.clone(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.material = Array.isArray(m.material)
      ? m.material.map((x) => (x as THREE.Material).clone())
      : (m.material as THREE.Material).clone();
    m.castShadow = true;
    m.receiveShadow = true;
  });

  // Wheels hang off the group (so body roll never lifts them); the rest rides the pivot.
  const wheels: THREE.Object3D[] = [];
  root.traverse((o) => { if (o.name.startsWith('WHEELPIVOT')) wheels.push(o); });
  for (const w of wheels) group.attach(w);
  bodyPivot.add(root);

  const wheelMeshes: Vehicle['wheelMeshes'] = wheels.map((w) => ({ mesh: w, front: w.name.includes('_F') }));
  let brakeLight: THREE.Mesh | null = null;
  let barL: THREE.Mesh | null = null;
  let barR: THREE.Mesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.userData.lights === 'tail' && !brakeLight) brakeLight = m;
    if (m.userData.lights === 'barL' && !barL) barL = m;
    if (m.userData.lights === 'barR' && !barR) barR = m;
    if (m.userData.tintable) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const x of mats) (x as THREE.MeshStandardMaterial).color = new THREE.Color(colour);
    }
  });

  return finishVehicle(kind, colour, group, wheelMeshes, bodyPivot, brakeLight,
    barL && barR ? { l: barL, r: barR } : null);
}

/** Shared tail of both factories: physics bookkeeping, collider box, control state. */
function finishVehicle(
  kind: VehKind, colour: number, group: THREE.Group,
  wheelMeshes: Vehicle['wheelMeshes'], bodyPivot: THREE.Group,
  brakeLight: THREE.Mesh | null, lightbar: Vehicle['lightbar'],
): Vehicle {
  const v: Vehicle = {
    kind, colour, spec: SPECS[kind], group, wheelMeshes, bodyPivot,
    brakeLight, lightbar,
    x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, speed: 0, steerAngle: 0, wheelSpin: 0,
    health: 100,
    boost: 1, boosting: false, boostLock: false,
    ctrl: { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false },
    driver: null, isPlayer: false, siren: false,
    box: { minX: 0, maxX: 0, minZ: 0, maxZ: 0, bottom: 0, top: SPECS[kind].height, kind: KIND.Vehicle },
    ai: null, hornT: 0, crashT: 0, bodyRoll: 0, bodyPitch: 0, netId: 0,
  };
  v.box.owner = v;
  return v;
}

/** World-space AABB, refreshed every frame so other bodies can collide with it. */
export function updateVehicleBox(v: Vehicle): void {
  const s = Math.abs(Math.sin(v.yaw)), c = Math.abs(Math.cos(v.yaw));
  const rx = s * v.spec.halfL + c * v.spec.halfW;
  const rz = c * v.spec.halfL + s * v.spec.halfW;
  v.box.minX = v.x - rx; v.box.maxX = v.x + rx;
  v.box.minZ = v.z - rz; v.box.maxZ = v.z + rz;
  v.box.bottom = v.y;
  v.box.top = v.y + v.spec.height;
}

/**
 * Bicycle-model arcade physics.
 *
 * Forward speed is driven directly; lateral velocity is bled off by grip, which is what
 * produces believable understeer, handbrake slides and the inability to turn on the spot.
 */
export function stepVehicle(v: Vehicle, dt: number, phys: Physics): void {
  const s = v.spec;
  const c = v.ctrl;

  // ── boost
  // Held nitrous: raises the rev limit and the pull. Drains fast, recharges when off, so it
  // is a "get out of the way" button rather than a permanent top speed.
  // Hysteresis: once the tank empties it has to recover to 35% before it will re-engage,
  // otherwise holding the key makes it stutter on and off every few frames.
  if (v.boost <= 0.001) v.boostLock = true;
  if (v.boost > 0.35) v.boostLock = false;
  const wantBoost = c.boost && !v.boostLock && v.speed > -0.5;
  if (wantBoost) v.boost = Math.max(0, v.boost - dt / s.boostTime);
  else v.boost = Math.min(1, v.boost + dt / (s.boostTime * 2.6));
  v.boosting = wantBoost;
  const boostK = wantBoost ? s.boostPower : 1;
  const vmax = s.maxSpeed * (wantBoost ? 1.22 : 1);

  // ── drivetrain
  // Torque falls away with speed and aero drag rises with its square; the drag constant is
  // derived from maxSpeed so the car actually reaches its quoted top speed and no further.
  const throttle = clamp(c.throttle, 0, 1), brake = clamp(c.brake, 0, 1);
  const sp = Math.abs(v.speed);
  // Keyed to the boosted limit so nitrous extends the top end, not just the launch.
  const t01 = clamp(sp / vmax, 0, 1);
  if (throttle > 0) {
    const torque = 1 - 0.72 * t01 * t01;             // strong low down, tapering up top
    v.speed += s.accel * boostK * throttle * torque * dt;
  }
  if (brake > 0) {
    if (v.speed > 0.4) v.speed -= s.brake * brake * dt;
    else v.speed -= s.accel * 0.7 * brake * dt;      // pull away in reverse
  }
  if (c.handbrake) v.speed -= Math.sign(v.speed) * s.brake * 0.55 * dt;
  // Aero drag, calibrated so that torque output == drag + rolling resistance exactly at
  // maxSpeed. That makes the quoted top speed the real terminal velocity for every class,
  // and it is independent of `accel`, so acceleration can be tuned without breaking it.
  const roll = (x: number) => 0.42 + x * 0.018;
  const dragK = Math.max(2e-5, (s.accel * 0.28 - roll(s.maxSpeed)) / (s.maxSpeed * s.maxSpeed));
  v.speed -= Math.sign(v.speed) * dragK * sp * sp * dt;
  // rolling resistance: a small constant, not a speed-proportional brake
  v.speed -= Math.sign(v.speed) * Math.min(sp, roll(sp)) * dt;
  if (!throttle && !brake && sp < 0.3) v.speed = 0;
  v.speed = clamp(v.speed, -s.reverseMax, vmax);

  // ── steering
  const speedFactor = 1 / (1 + sp * 0.075);
  const target = c.steer * s.maxSteer * speedFactor;
  v.steerAngle = damp(v.steerAngle, target, 9, dt);
  // steering right (+) turns the car right, which decreases yaw
  let yawRate = -(v.speed / s.wheelbase) * Math.tan(v.steerAngle) * (c.handbrake ? 1.45 : 1);
  // Tyres can only generate so much lateral force: cap the turn rate by the cornering
  // limit. This is what stops a 330 km/h car from turning like a shopping trolley, and it
  // leaves low-speed parking as tight as ever.
  const latLimit = s.grip * 1.5;
  const yawCap = latLimit / Math.max(sp, 1.2);
  yawRate = clamp(yawRate, -yawCap, yawCap);
  v.yaw += yawRate * dt;

  // ── velocity split into forward / lateral, lateral bled off by grip
  const fx = fwdX(v.yaw), fz = fwdZ(v.yaw);
  const rx = rgtX(v.yaw), rz = rgtZ(v.yaw);
  let vf = v.vx * fx + v.vz * fz;
  let vs = v.vx * rx + v.vz * rz;
  vf = damp(vf, v.speed, 14, dt);
  const grip = c.handbrake ? s.driftGrip : s.grip;
  vs *= Math.exp(-grip * dt);
  // sliding scrubs speed
  v.speed -= Math.min(Math.abs(v.speed), Math.abs(vs) * 0.35 * dt);
  v.vx = fx * vf + rx * vs;
  v.vz = fz * vf + rz * vs;

  // ── integrate, sub-stepped so nothing is driven through a wall
  const dist = Math.hypot(v.vx, v.vz) * dt;
  const steps = Math.max(1, Math.ceil(dist / 0.35));
  const sdt = dt / steps;
  for (let i = 0; i < steps; i++) {
    v.x += v.vx * sdt;
    v.z += v.vz * sdt;
    collide(v, phys);
  }

  // ── ride height follows the ground (kerbs, driveways)
  const gh = phys.groundHeight(v.x, v.z, s.halfW, v.y + 0.6, false);
  v.y = damp(v.y, gh, 12, dt);

  // ── visuals
  v.wheelSpin += (v.speed / s.wheelR) * dt;
  for (const w of v.wheelMeshes) {
    // local +Y rotation turns the wheel left, so negate to point it where we steer
    if (w.front) w.mesh.rotation.y = -v.steerAngle;
    w.mesh.children[0].rotation.x = v.wheelSpin;
    w.mesh.position.y = s.wheelR;
  }
  // sliding right (+lateral) leans the body left, which is a negative Z rotation
  const lateral = clamp((v.vx * rx + v.vz * rz) * 0.06, -0.22, 0.22);
  v.bodyRoll = damp(v.bodyRoll, lateral, 8, dt);
  v.bodyPitch = damp(v.bodyPitch, clamp((throttle - brake) * -0.035 + (c.handbrake ? 0.03 : 0), -0.08, 0.08), 7, dt);
  v.bodyPivot.rotation.z = v.bodyRoll;
  v.bodyPivot.rotation.x = v.bodyPitch;
  v.group.position.set(v.x, v.y, v.z);
  v.group.rotation.y = v.yaw;

  if (v.brakeLight) {
    const m = v.brakeLight.material as THREE.MeshStandardMaterial;
    m.emissiveIntensity = brake > 0.05 || (c.handbrake && Math.abs(v.speed) > 0.5) ? 2.2 : 0.25;
  }
  v.crashT = Math.max(0, v.crashT - dt);
  v.hornT = Math.max(0, v.hornT - dt);
  updateVehicleBox(v);
}

/** Four corner probes: cheap, stable, and it lets cars grind along walls instead of sticking. */
function collide(v: Vehicle, phys: Physics): void {
  const s = v.spec;
  const fx = fwdX(v.yaw), fz = fwdZ(v.yaw);
  const rx = rgtX(v.yaw), rz = rgtZ(v.yaw);
  let pushX = 0, pushZ = 0, torque = 0, hits = 0;
  const probe = 0.52;
  for (const [lz, lx] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][]) {
    const ox = (s.halfL - probe * 0.8) * lz, oz = (s.halfW - probe * 0.7) * lx;
    const px = v.x + fx * ox + rx * oz;
    const pz = v.z + fz * ox + rz * oz;
    phys.resolveCircle(px, pz, probe, v.y + 0.15, v.y + s.height, 0.3, true, v);
    if (!phys.outHit) continue;
    const dx = phys.outX - px, dz = phys.outZ - pz;
    pushX += dx; pushZ += dz; hits++;
    torque += ox * (dz * fz + dx * fx) * 0 + (ox * dz - oz * dx) * 0.06;
  }
  if (!hits) return;
  v.x += pushX / hits;
  v.z += pushZ / hits;
  v.yaw += clamp(torque, -0.12, 0.12);
  // kill the velocity component going into the wall
  const n = Math.hypot(pushX, pushZ);
  if (n > 1e-5) {
    const nx = pushX / n, nz = pushZ / n;
    const into = v.vx * nx + v.vz * nz;
    if (into < 0) {
      v.vx -= nx * into * 1.4;
      v.vz -= nz * into * 1.4;
    }
    const impact = Math.abs(v.speed);
    if (impact > 4) {
      v.crashT = 0.35;
      v.health -= (impact - 4) * 1.6;
    }
    v.speed *= impact > 8 ? 0.25 : 0.6;
  }
}

/**
 * Place a car from an interpolated network pose instead of from physics.
 *
 * This is deliberately *not* stepVehicle: running the simulation on a puppet would fight
 * the incoming positions and produce the shudder you get when prediction and correction
 * disagree every frame. So we move the car where we are told, and derive just enough
 * (speed, wheel spin, body roll) to keep it from looking like a sliding cardboard cut-out.
 */
export function poseNetVehicle(v: Vehicle, x: number, y: number, z: number, yaw: number, dt: number): void {
  const dx = x - v.x, dz = z - v.z;
  const moved = Math.hypot(dx, dz);
  // Signed by whether the movement is with or against the car's own nose.
  const forward = dx * fwdX(yaw) + dz * fwdZ(yaw);
  const inst = dt > 1e-4 ? (forward < 0 ? -moved : moved) / dt : 0;
  // Quantisation makes the raw delta jittery at low speed; smooth it for the wheels only.
  v.speed = damp(v.speed, clamp(inst, -70, 70), 8, dt);

  const dYaw = wrapPi(yaw - v.yaw);
  v.x = x; v.y = y; v.z = z; v.yaw = yaw;
  v.vx = dt > 1e-4 ? dx / dt : 0;
  v.vz = dt > 1e-4 ? dz / dt : 0;
  v.group.position.set(x, y, z);
  v.group.rotation.y = yaw;

  // Lean into the corner the same way the driven car does, from turn rate rather than steer.
  const turn = dt > 1e-4 ? dYaw / dt : 0;
  v.steerAngle = damp(v.steerAngle, clamp(turn * 0.35, -0.5, 0.5), 9, dt);
  v.bodyRoll = damp(v.bodyRoll, clamp(turn * v.speed * 0.004, -0.09, 0.09), 7, dt);
  v.bodyPivot.rotation.z = v.bodyRoll;
  v.bodyPivot.rotation.x = 0;

  v.wheelSpin += (v.speed / v.spec.wheelR) * dt;
  for (const w of v.wheelMeshes) {
    if (w.front) w.mesh.rotation.y = -v.steerAngle;
    w.mesh.children[0].rotation.x = v.wheelSpin;
  }
  updateVehicleBox(v);
}

export function vehicleSpeedKmh(v: Vehicle): number {
  return Math.abs(Math.round(v.speed * 3.6));
}

/** Flash the police lightbar. */
export function updateSiren(v: Vehicle, t: number): void {
  if (!v.lightbar) return;
  const on = v.siren;
  const a = on ? (Math.sin(t * 12) > 0 ? 1 : 0) : 0;
  (v.lightbar.l.material as THREE.MeshStandardMaterial).emissiveIntensity = a * 3;
  (v.lightbar.r.material as THREE.MeshStandardMaterial).emissiveIntensity = (on ? 1 - a : 0) * 3;
}

/** Driver seat in world space. seat[0] is negative → right-hand drive, as in Pakistan. */
export function seatWorld(v: Vehicle, out: THREE.Vector3): THREE.Vector3 {
  const [sx, sy, sz] = v.spec.seat;
  return out.set(
    v.x + rgtX(v.yaw) * -sx + fwdX(v.yaw) * sz,
    v.y + sy,
    v.z + rgtZ(v.yaw) * -sx + fwdZ(v.yaw) * sz,
  );
}

export function lerpColour(a: number, b: number, t: number): number {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return ca.lerp(cb, t).getHex();
}

export const CAR_COLOURS = [
  0xb8342a, 0x1f3f7a, 0xe8e8e6, 0x2b2f33, 0x8a9096, 0x2e7d52,
  0xd8a12c, 0x6a4a8a, 0x1d6f7a, 0xc4c9cd, 0x7a3b2a, 0xf0f2f4,
];

export function pickSpec(kinds: VehKind[], r: number): VehKind {
  return kinds[Math.floor(r * kinds.length) % kinds.length];
}

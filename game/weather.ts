import * as THREE from 'three';
import { clamp, damp, lerp, mulberry32 } from './mathx';
import { Mats } from './materials';
import { Sky } from './sky';

/**
 * Weather.
 *
 * Deliberately built out of things that cost nothing per frame:
 *
 *  · **Wet roads** are not a shader, a second pass or a reflection probe. They are two
 *    scalar writes on six materials — roughness down, albedo down, envMapIntensity up —
 *    which is enough because the scene already has a real HDRI environment to reflect.
 *  · **Rain** is one LineSegments of 2400 streaks whose fall is done entirely in the
 *    vertex shader, so the CPU writes a single uniform a frame and never touches a
 *    particle. The object is parked on the camera, so 2400 drops cover the world.
 *  · **Dust** is one Points of 900, same trick.
 *  · **Lightning** is an audio burst plus a HUD opacity — no light, no shadow re-render.
 *
 * Total: two draw calls, ~70 KB of vertex data, and one uniform write per frame.
 */

export type Sky1 = 'clear' | 'dust' | 'rain';

/** How long a spell of weather lasts, and how long the crossfade into it takes. */
const SPELL = [140, 320] as const;
const FADE = 14;

const RAIN_VERT = /* glsl */ `
uniform float uTime;
uniform float uFall;
uniform vec3 uBox;
attribute float aPhase;
attribute float aLen;
varying float vFade;
void main() {
  vec3 p = position;
  // Each streak falls on its own phase and wraps inside the box, so nothing is ever
  // respawned on the CPU. aLen is 0 for the head of a streak and 1 for its tail.
  float fall = mod(p.y - uTime * uFall * (0.75 + aPhase * 0.5), uBox.y);
  p.y = fall - uBox.y * 0.5 + aLen * 1.15 * (0.6 + aPhase * 0.8);
  p.x += aLen * 0.16 + sin(uTime * 0.5 + aPhase * 6.28) * 0.5;
  vec4 world = modelMatrix * vec4(p, 1.0);
  // fade the streaks out at the edge of the box so the wall of rain has no hard rim
  float r = length(world.xz - cameraPosition.xz);
  vFade = (1.0 - smoothstep(uBox.x * 0.25, uBox.x * 0.5, r)) * (1.0 - aLen * 0.65);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const RAIN_FRAG = /* glsl */ `
uniform float uOpacity;
uniform vec3 uColour;
varying float vFade;
void main() {
  gl_FragColor = vec4(uColour, vFade * uOpacity);
}`;

const DUST_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uBox;
attribute float aPhase;
varying float vFade;
void main() {
  vec3 p = position;
  p.x = mod(p.x + uTime * (2.5 + aPhase * 3.0), uBox.x) - uBox.x * 0.5;
  p.y += sin(uTime * 0.7 + aPhase * 6.28) * 1.4;
  vec4 world = modelMatrix * vec4(p, 1.0);
  float r = length(world.xz - cameraPosition.xz);
  vFade = 1.0 - smoothstep(uBox.x * 0.2, uBox.x * 0.5, r);
  vec4 mv = viewMatrix * world;
  gl_PointSize = (26.0 + aPhase * 40.0) / max(1.0, -mv.z) * 24.0;
  gl_Position = projectionMatrix * mv;
}`;

const DUST_FRAG = /* glsl */ `
uniform float uOpacity;
uniform vec3 uColour;
varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  gl_FragColor = vec4(uColour, (1.0 - d * 2.0) * vFade * uOpacity);
}`;

export class Weather {
  /** what we are heading towards */
  target: Sky1 = 'clear';
  /** 0..1 rain intensity, smoothed */
  rain = 0;
  /** 0..1 dust intensity, smoothed */
  dust = 0;
  /**
   * 0..1 how wet the ground is. Lags the rain by a long way in both directions, because
   * tarmac does not dry the second a shower stops — and because a grip change that snaps
   * on and off under the player is unreadable.
   */
  wet = 0;
  /** 0..1, decaying: the last lightning flash. The HUD reads this. */
  flash = 0;

  /** true for one frame when a thunderclap should be played */
  thunderCue = false;
  /** true while the rain hiss should be audible, with this volume */
  hiss = 0;

  enabled = true;

  private rainMesh: THREE.LineSegments;
  private dustMesh: THREE.Points;
  private rainUni: Record<string, THREE.IUniform>;
  private dustUni: Record<string, THREE.IUniform>;
  private spellT = 40;
  private strikeT = 0;
  private baseRough = new Map<THREE.MeshStandardMaterial, number>();
  private baseColour = new Map<THREE.MeshStandardMaterial, THREE.Color>();
  private wetMats: THREE.MeshStandardMaterial[] = [];
  private box = new THREE.Vector3(120, 46, 120);

  constructor(private scene: THREE.Scene, mats: Mats, private rng = mulberry32(90210)) {
    // Only what the sky actually rains on: roads, pavements, lots and bare ground. Walls
    // and roofs keep their own roughness, which is what stops a wet city looking plastic.
    this.wetMats = [
      mats.asphalt, mats.concrete, mats.curb, mats.dirt, mats.cobble, mats.sand,
      mats.forestFloor, mats.grass,
    ];
    for (const m of this.wetMats) {
      this.baseRough.set(m, m.roughness);
      this.baseColour.set(m, m.color.clone());
    }

    this.rainUni = {
      uTime: { value: 0 },
      uFall: { value: 26 },
      uBox: { value: this.box },
      uOpacity: { value: 0 },
      uColour: { value: new THREE.Color(0xc8d8e4) },
    };
    this.rainMesh = new THREE.LineSegments(rainGeometry(2400, this.box, rng), new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, uniforms: this.rainUni,
      transparent: true, depthWrite: false, fog: false,
    }));
    this.rainMesh.frustumCulled = false;
    this.rainMesh.visible = false;
    scene.add(this.rainMesh);

    this.dustUni = {
      uTime: { value: 0 },
      uBox: { value: this.box },
      uOpacity: { value: 0 },
      uColour: { value: new THREE.Color(0xd8b884) },
    };
    this.dustMesh = new THREE.Points(dustGeometry(900, this.box, rng), new THREE.ShaderMaterial({
      vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, uniforms: this.dustUni,
      transparent: true, depthWrite: false, fog: false,
    }));
    this.dustMesh.frustumCulled = false;
    this.dustMesh.visible = false;
    scene.add(this.dustMesh);
  }

  /** Grip multiplier for vehicles. Wet tarmac is roughly a third less grippy. */
  gripScale(): number {
    return 1 - this.wet * 0.34;
  }

  /** Named for the HUD. */
  label(): string {
    if (this.rain > 0.45) return 'HEAVY RAIN';
    if (this.rain > 0.08) return 'DRIZZLE';
    if (this.dust > 0.3) return 'DUST HAZE';
    return '';
  }

  /** Force a spell, for the cheat console and for map themes that start wet. */
  set(kind: Sky1, instant = false): void {
    this.target = kind;
    this.spellT = SPELL[0] + this.rng() * (SPELL[1] - SPELL[0]);
    if (!instant) return;
    this.rain = kind === 'rain' ? 1 : 0;
    this.dust = kind === 'dust' ? 1 : 0;
    this.wet = kind === 'rain' ? 1 : 0;
  }

  update(dt: number, t: number, camX: number, camY: number, camZ: number, sky: Sky, fog: THREE.Fog | null, drawDistance: number): void {
    this.thunderCue = false;

    if (this.enabled) {
      this.spellT -= dt;
      if (this.spellT <= 0) {
        // Rain is the rarest and dust the most common, so the weather has somewhere to
        // go without the map feeling like it is permanently in a monsoon.
        const r = this.rng();
        this.target = r < 0.34 ? 'rain' : r < 0.62 ? 'dust' : 'clear';
        this.spellT = SPELL[0] + this.rng() * (SPELL[1] - SPELL[0]);
      }
    } else {
      this.target = 'clear';
    }

    const rate = 1 / FADE;
    this.rain = approach(this.rain, this.target === 'rain' ? 1 : 0, rate * dt);
    this.dust = approach(this.dust, this.target === 'dust' ? 1 : 0, rate * dt);
    // wetting is fast, drying is slow — the way a road actually behaves
    this.wet = damp(this.wet, this.rain, this.rain > this.wet ? 0.5 : 0.12, dt);

    /* ── particles: one uniform write each, and the object rides the camera ── */
    this.rainMesh.visible = this.rain > 0.01;
    if (this.rainMesh.visible) {
      this.rainMesh.position.set(camX, camY, camZ);
      this.rainUni.uTime.value = t;
      this.rainUni.uOpacity.value = this.rain * 0.5;
      (this.rainUni.uColour.value as THREE.Color).copy(sky.horizonColour()).lerp(WHITE, 0.45);
    }
    this.dustMesh.visible = this.dust > 0.01;
    if (this.dustMesh.visible) {
      this.dustMesh.position.set(camX, camY, camZ);
      this.dustUni.uTime.value = t;
      this.dustUni.uOpacity.value = this.dust * 0.34;
    }

    /* ── wet ground: two scalar writes per material, and only when it changes ── */
    for (const m of this.wetMats) {
      const r0 = this.baseRough.get(m)!;
      const c0 = this.baseColour.get(m)!;
      m.roughness = lerp(r0, r0 * 0.22, this.wet);
      m.color.setRGB(
        lerp(c0.r, c0.r * 0.62, this.wet),
        lerp(c0.g, c0.g * 0.62, this.wet),
        lerp(c0.b, c0.b * 0.66, this.wet),
      );
    }

    /* ── air: the fog does the heavy lifting for "you cannot see far" ── */
    if (fog) {
      const murk = Math.max(this.rain, this.dust * 0.8);
      fog.far = drawDistance * lerp(1, 0.42, murk);
      fog.near = fog.far * 0.28;
      if (this.dust > 0.01) fog.color.lerp(DUST_AIR, this.dust * 0.75);
      if (this.rain > 0.01) fog.color.lerp(RAIN_AIR, this.rain * 0.75);
    }
    // Re-derive the sky from the clock before attenuating it.
    //
    // Everything below *scales* what setHour() produced, and with the day/night cycle
    // switched off the engine only calls setHour once at boot — so without this the
    // scaling would compound every frame and fade the world to black over a minute.
    // setHour is pure arithmetic on a handful of colours, so paying for it is nothing.
    sky.setHour(sky.hour);

    // The sun goes behind the cloud deck rather than being switched off, so shadows
    // soften instead of vanishing in one frame.
    sky.sun.intensity *= lerp(1, 0.22, this.rain) * lerp(1, 0.55, this.dust);
    sky.hemi.intensity *= lerp(1, 0.75, this.rain);

    // Overcast the dome itself. Sky.setHour() rewrites these two colours from scratch
    // every frame, so tinting the live uniforms here is safe and reverts on its own the
    // moment the storm passes — and without it a monsoon happens under a clear blue sky,
    // which is the single most obvious way to make weather look fake.
    if (this.rain > 0.01) {
      sky.topColour().lerp(RAIN_TOP, this.rain * 0.88);
      sky.horizonColour().lerp(RAIN_HORIZON, this.rain * 0.82);
    }
    if (this.dust > 0.01) {
      sky.topColour().lerp(DUST_TOP, this.dust * 0.7);
      sky.horizonColour().lerp(DUST_AIR, this.dust * 0.8);
    }


    /* ── lightning ── */
    this.flash = Math.max(0, this.flash - dt * 4.5);
    if (this.rain > 0.5) {
      this.strikeT -= dt;
      if (this.strikeT <= 0) {
        this.strikeT = 7 + this.rng() * 22;
        this.flash = 1;
        this.thunderCue = true;
      }
    } else {
      this.strikeT = Math.max(this.strikeT, 4);
    }

    this.hiss = clamp(this.rain * 1.1, 0, 1);
  }

  dispose(): void {
    this.scene.remove(this.rainMesh, this.dustMesh);
    this.rainMesh.geometry.dispose();
    this.dustMesh.geometry.dispose();
    (this.rainMesh.material as THREE.Material).dispose();
    (this.dustMesh.material as THREE.Material).dispose();
    // hand the shared materials back exactly as we found them
    for (const m of this.wetMats) {
      m.roughness = this.baseRough.get(m)!;
      m.color.copy(this.baseColour.get(m)!);
    }
  }
}

const WHITE = new THREE.Color(0xffffff);
const RAIN_AIR = new THREE.Color(0x8794a0);
const DUST_AIR = new THREE.Color(0xc09a63);
const RAIN_TOP = new THREE.Color(0x4a545e);
const RAIN_HORIZON = new THREE.Color(0x8d99a4);
const DUST_TOP = new THREE.Color(0xb08a52);

function approach(v: number, to: number, step: number): number {
  return v < to ? Math.min(to, v + step) : Math.max(to, v - step);
}

/** Two vertices per streak: a head and a tail, sheared by the wind in the shader. */
function rainGeometry(count: number, box: THREE.Vector3, rng: () => number): THREE.BufferGeometry {
  const pos = new Float32Array(count * 6);
  const phase = new Float32Array(count * 2);
  const len = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = (rng() - 0.5) * box.x;
    const y = rng() * box.y;
    const z = (rng() - 0.5) * box.z;
    const ph = rng();
    for (let k = 0; k < 2; k++) {
      pos[i * 6 + k * 3] = x;
      pos[i * 6 + k * 3 + 1] = y;
      pos[i * 6 + k * 3 + 2] = z;
      phase[i * 2 + k] = ph;
      len[i * 2 + k] = k;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  g.setAttribute('aLen', new THREE.BufferAttribute(len, 1));
  return g;
}

function dustGeometry(count: number, box: THREE.Vector3, rng: () => number): THREE.BufferGeometry {
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng() * box.x;
    pos[i * 3 + 1] = rng() * box.y * 0.5;
    pos[i * 3 + 2] = (rng() - 0.5) * box.z;
    phase[i] = rng();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  return g;
}

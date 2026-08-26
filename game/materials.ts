import * as THREE from 'three';
import { mulberry32, Rng } from './mathx';
import { createWaterMaterial } from './water';
import type { AssetBank } from './assets';

/**
 * Every surface in the game is generated on a <canvas> at load time. No image downloads,
 * no GLTFs — the whole deploy is ~600KB gzipped and there is nothing to stall on.
 */

let maxAniso = 4;
const cache = new Map<string, THREE.Texture>();

export function initTextures(renderer: THREE.WebGLRenderer): void {
  maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
}

function make(key: string, size: number, draw: (g: CanvasRenderingContext2D, rng: Rng, s: number) => void, repeat = true): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, mulberry32(hash(key)), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  cache.set(key, t);
  return t;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function speckle(g: CanvasRenderingContext2D, rng: Rng, s: number, n: number, colors: string[], min = 1, max = 3): void {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[(rng() * colors.length) | 0];
    const w = min + rng() * (max - min);
    g.fillRect(rng() * s, rng() * s, w, w);
  }
}

export const tex = {
  asphalt: () => make('asphalt', 256, (g, rng, s) => {
    g.fillStyle = '#2e3135';
    g.fillRect(0, 0, s, s);
    speckle(g, rng, s, 5000, ['#3a3e43', '#26292c', '#43474d', '#1f2225'], 1, 3);
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = `rgba(20,22,25,${0.1 + rng() * 0.2})`;
      g.lineWidth = 0.6 + rng() * 1.6;
      g.beginPath();
      g.moveTo(rng() * s, rng() * s);
      g.lineTo(rng() * s, rng() * s);
      g.stroke();
    }
  }),

  concrete: () => make('concrete', 256, (g, rng, s) => {
    g.fillStyle = '#9c9a92';
    g.fillRect(0, 0, s, s);
    speckle(g, rng, s, 3400, ['#a8a69d', '#918f87', '#b2b0a6', '#87857e'], 1, 4);
    // slab joints every 64px
    g.strokeStyle = 'rgba(80,78,72,.55)';
    g.lineWidth = 2;
    for (let i = 0; i <= s; i += 64) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(s, i); g.stroke();
    }
  }),

  grass: () => make('grass', 256, (g, rng, s) => {
    g.fillStyle = '#5f8b46';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 4200; i++) {
      g.fillStyle = `hsla(${92 + rng() * 34},${34 + rng() * 22}%,${26 + rng() * 20}%,.6)`;
      g.fillRect(rng() * s, rng() * s, 1.5, 2 + rng() * 4);
    }
    for (let i = 0; i < 14; i++) {
      g.fillStyle = `rgba(255,255,255,${0.012 + rng() * 0.02})`;
      g.beginPath(); g.arc(rng() * s, rng() * s, 20 + rng() * 50, 0, 7); g.fill();
    }
  }),

  dirt: () => make('dirt', 128, (g, rng, s) => {
    g.fillStyle = '#8d7550';
    g.fillRect(0, 0, s, s);
    speckle(g, rng, s, 2200, ['#7d6644', '#9c8460', '#6d5a3c'], 1, 4);
  }),

  plaster: (variant: number) => make('plaster' + variant, 128, (g, rng, s) => {
    const base = ['#e2d7c3', '#d8ccc0', '#e8ded0', '#cdd6d4', '#e6d2c0', '#dcd8cc'][variant % 6];
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    speckle(g, rng, s, 1500, ['rgba(255,255,255,.25)', 'rgba(0,0,0,.06)', 'rgba(120,100,80,.08)'], 1, 5);
  }),

  brick: () => make('brick', 256, (g, rng, s) => {
    g.fillStyle = '#8d5a48';
    g.fillRect(0, 0, s, s);
    const bh = 16, bw = 34;
    for (let y = 0, row = 0; y < s; y += bh, row++) {
      for (let x = (row % 2) * -bw / 2; x < s; x += bw) {
        g.fillStyle = `hsl(${8 + rng() * 12},${28 + rng() * 16}%,${32 + rng() * 12}%)`;
        g.fillRect(x + 1.4, y + 1.4, bw - 2.8, bh - 2.8);
      }
    }
  }),

  roofTile: () => make('rooftile', 128, (g, rng, s) => {
    g.fillStyle = '#7c4436';
    g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 16) {
      g.fillStyle = `hsl(${10 + rng() * 8},34%,${24 + rng() * 12}%)`;
      g.fillRect(0, y, s, 13);
      g.fillStyle = 'rgba(0,0,0,.22)';
      g.fillRect(0, y + 13, s, 3);
    }
  }),

  metal: () => make('metal', 128, (g, rng, s) => {
    g.fillStyle = '#8d949b';
    g.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 8) {
      g.fillStyle = `rgba(255,255,255,${0.05 + rng() * 0.08})`;
      g.fillRect(x, 0, 3, s);
    }
  }),

  wood: () => make('wood', 128, (g, rng, s) => {
    g.fillStyle = '#a8763f';
    g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 12) {
      g.fillStyle = `hsl(28,${34 + rng() * 14}%,${30 + rng() * 14}%)`;
      g.fillRect(0, y, s, 11);
      g.fillStyle = 'rgba(50,30,12,.4)';
      g.fillRect(0, y + 11, s, 1.5);
    }
  }),

  /** One 14m × 14m block of facade: 4×4 windows with mullions and sills. */
  facade: (variant: number) => make('facade' + variant, 512, (g, rng, s) => {
    const wall = ['#c9c2b4', '#b9c3c8', '#d6c8b2', '#a9b3bd'][variant % 4];
    const glass = ['#38596e', '#2f4c60', '#41627a', '#2a4457'][variant % 4];
    g.fillStyle = wall;
    g.fillRect(0, 0, s, s);
    speckle(g, rng, s, 2000, ['rgba(255,255,255,.16)', 'rgba(0,0,0,.05)'], 1, 4);
    const cell = s / 4;
    for (let iy = 0; iy < 4; iy++) {
      for (let ix = 0; ix < 4; ix++) {
        const x = ix * cell, y = iy * cell;
        const pad = cell * 0.18;
        g.fillStyle = '#6c665c';
        g.fillRect(x + pad - 3, y + pad - 3, cell - pad * 2 + 6, cell - pad * 2 + 6);
        g.fillStyle = glass;
        g.fillRect(x + pad, y + pad, cell - pad * 2, cell - pad * 2);
        // reflection streak
        g.fillStyle = 'rgba(255,255,255,.10)';
        g.beginPath();
        g.moveTo(x + pad, y + cell - pad);
        g.lineTo(x + cell - pad, y + pad);
        g.lineTo(x + cell - pad, y + pad + cell * 0.2);
        g.lineTo(x + pad, y + cell - pad + cell * 0.2);
        g.fill();
        // mullion
        g.fillStyle = 'rgba(40,38,34,.75)';
        g.fillRect(x + cell / 2 - 1.5, y + pad, 3, cell - pad * 2);
        // sill
        g.fillStyle = 'rgba(0,0,0,.18)';
        g.fillRect(x + pad - 4, y + cell - pad, cell - pad * 2 + 8, 5);
      }
    }
  }),

  /** Matching emissive mask — only some windows are lit, so nights look inhabited. */
  facadeLit: (variant: number) => make('facadeLit' + variant, 512, (g, rng, s) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, s, s);
    const cell = s / 4;
    for (let iy = 0; iy < 4; iy++) {
      for (let ix = 0; ix < 4; ix++) {
        if (rng() > 0.42) continue;
        const pad = cell * 0.18;
        g.fillStyle = rng() > 0.3 ? '#ffdca6' : '#cfe4ff';
        g.fillRect(ix * cell + pad, iy * cell + pad, cell - pad * 2, cell - pad * 2);
      }
    }
  }),

  water: () => make('water', 256, (g, rng, s) => {
    g.fillStyle = '#2f7fa8';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 200; i++) {
      g.strokeStyle = `rgba(255,255,255,${0.05 + rng() * 0.12})`;
      g.lineWidth = 1 + rng() * 2;
      const y = rng() * s;
      g.beginPath();
      g.moveTo(rng() * s, y);
      g.lineTo(rng() * s, y + rng() * 4);
      g.stroke();
    }
  }),

  /**
   * Truck art. Every Bedford on a Pakistani road is a moving painting: bands of hot colour,
   * floral rosettes, mirrored chips, poetry panels and a scalloped crown. This draws the
   * grammar of it — symmetrical bands, rosettes, teardrop petals, chrome strips.
   */
  truckArt: () => make('truckart', 512, (g, rng, s) => {
    const hot = ['#d62828', '#1d64c4', '#f6c445', '#12965a', '#e8621f', '#8e3fb0', '#00a3a3'];
    g.fillStyle = '#f7f0dc';
    g.fillRect(0, 0, s, s);
    // horizontal colour bands
    let y = 0;
    while (y < s) {
      const h = 18 + rng() * 46;
      g.fillStyle = hot[(rng() * hot.length) | 0];
      g.fillRect(0, y, s, h);
      // chrome pinstripe between bands
      g.fillStyle = 'rgba(255,255,255,.72)';
      g.fillRect(0, y + h - 3, s, 3);
      g.fillStyle = 'rgba(0,0,0,.22)';
      g.fillRect(0, y + h, s, 2);
      y += h + 2;
    }
    // rosettes, mirrored left/right the way real panels are
    const rosette = (cx: number, cy: number, r: number) => {
      const petals = 8 + ((rng() * 4) | 0);
      const c1 = hot[(rng() * hot.length) | 0];
      for (let i = 0; i < petals; i++) {
        const a = (i / petals) * Math.PI * 2;
        g.fillStyle = i % 2 ? c1 : '#f7f0dc';
        g.beginPath();
        g.ellipse(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55, r * 0.42, r * 0.2, a, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = '#f6c445';
      g.beginPath(); g.arc(cx, cy, r * 0.26, 0, 7); g.fill();
      g.fillStyle = '#d62828';
      g.beginPath(); g.arc(cx, cy, r * 0.12, 0, 7); g.fill();
    };
    for (let i = 0; i < 7; i++) {
      const cy = 40 + rng() * (s - 80), r = 26 + rng() * 30;
      rosette(s * 0.25, cy, r);
      rosette(s * 0.75, cy, r);
    }
    // teardrop petal borders top and bottom
    for (let x = 8; x < s; x += 26) {
      for (const [py, dir] of [[10, 1], [s - 10, -1]] as [number, number][]) {
        g.fillStyle = hot[(x / 26 | 0) % hot.length];
        g.beginPath();
        g.moveTo(x, py);
        g.quadraticCurveTo(x + 13, py + dir * 20, x + 26, py);
        g.fill();
      }
    }
    // mirrored chips catching the light
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(255,255,255,${0.35 + rng() * 0.5})`;
      const cx = rng() * s, cy = rng() * s, r = 2 + rng() * 4;
      g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
    }
  }),

  foliage: () => make('foliage', 128, (g, rng, s) => {
    g.fillStyle = '#3f7238';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 700; i++) {
      g.fillStyle = `hsl(${86 + rng() * 40},${32 + rng() * 26}%,${18 + rng() * 26}%)`;
      g.beginPath(); g.arc(rng() * s, rng() * s, 2 + rng() * 6, 0, 7); g.fill();
    }
  }),
};

/**
 * Derive a normal map from an albedo texture with a Sobel filter on its luminance.
 *
 * Real relief needs a real height field, but for brick, plaster, kerbs and asphalt the
 * albedo *is* essentially a height field — mortar lines are dark, aggregate is light. One
 * extra texture sample per pixel buys grazing-light detail that no amount of geometry
 * would give us, and it costs nothing to author.
 */
function deriveNormal(src: THREE.Texture, key: string, strength = 1.4): THREE.Texture {
  const hit = cache.get('n:' + key);
  if (hit) return hit;
  const img = src.image as HTMLCanvasElement;
  const s = img.width;
  const sg = img.getContext('2d')!;
  const px = sg.getImageData(0, 0, s, s).data;
  const lum = new Float32Array(s * s);
  for (let i = 0; i < s * s; i++) {
    lum[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
  }
  const out = document.createElement('canvas');
  out.width = out.height = s;
  const og = out.getContext('2d')!;
  const dst = og.createImageData(s, s);
  const at = (x: number, y: number) => lum[((y + s) % s) * s + ((x + s) % s)];
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // Sobel
      const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -gx * strength, ny = -gy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const i = (y * s + x) * 4;
      dst.data[i] = (nx * 0.5 + 0.5) * 255;
      dst.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      dst.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      dst.data[i + 3] = 255;
    }
  }
  og.putImageData(dst, 0, 0);
  const t = new THREE.CanvasTexture(out);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  cache.set('n:' + key, t);
  return t;
}

/**
 * Tileable ripple normal map, built analytically from a few sine octaves so the gradients
 * are exact and it tiles seamlessly (frequencies are whole numbers of cycles per edge).
 */
export function rippleNormal(size = 256): THREE.Texture {
  const hit = cache.get('ripple');
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  // [cycles-x, cycles-y, amplitude]
  const waves: [number, number, number][] = [
    [3, 1, 1], [1, 4, 0.8], [5, 3, 0.45], [2, 7, 0.3], [9, 6, 0.14],
  ];
  const TAU2 = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0, dy = 0;
      for (const [fx, fy, a] of waves) {
        const phase = TAU2 * (fx * x / size + fy * y / size);
        dx += a * fx * Math.cos(phase);
        dy += a * fy * Math.cos(phase);
      }
      let nx = -dx * 0.055, ny = -dy * 0.055, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  cache.set('ripple', t);
  return t;
}

/**
 * Wind sway, injected into the foliage material's vertex shader.
 *
 * A vertex-shader-only change on one already-merged mesh: no extra draw calls, no extra
 * geometry, no CPU work per frame beyond a single uniform write. Sway ramps in with height
 * so trunks stay put and canopies move.
 */
function addSway(m: THREE.MeshStandardMaterial): void {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    m.userData.shader = shader;
    shader.vertexShader = `uniform float uTime;
` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      float swayAmt = smoothstep(1.1, 4.2, transformed.y);
      float swayPh = transformed.x * 0.26 + transformed.z * 0.33;
      transformed.x += sin(uTime * 1.25 + swayPh) * 0.08 * swayAmt;
      transformed.z += cos(uTime * 0.98 + swayPh * 1.4) * 0.065 * swayAmt;
      transformed.y += sin(uTime * 1.6 + swayPh * 0.7) * 0.018 * swayAmt;`,
    );
  };
}

/** One uniform write a frame drives every leaf in the world. */
export function updateFoliage(m: THREE.Material, t: number): void {
  const sh = (m.userData as { shader?: { uniforms: Record<string, { value: number }> } }).shader;
  if (sh) sh.uniforms.uTime.value = t;
}

/** Soft radial sprite used for muzzle flash, lamp glow, blood mist and dust. */
export function glowTexture(): THREE.Texture {
  const hit = cache.get('glow');
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  cache.set('glow', t);
  return t;
}

/** Irregular splat for blood decals. */
export function splatTexture(): THREE.Texture {
  const hit = cache.get('splat');
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const rng = mulberry32(9182);
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 9; i++) {
    const a = rng() * 7, r = 10 + rng() * 22;
    g.beginPath();
    g.arc(64 + Math.cos(a) * rng() * 20, 64 + Math.sin(a) * rng() * 20, r, 0, 7);
    g.fill();
  }
  for (let i = 0; i < 26; i++) {
    const a = rng() * 7, d = 26 + rng() * 34;
    g.beginPath();
    g.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 1.5 + rng() * 4.5, 0, 7);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  cache.set('splat', t);
  return t;
}

/** Shop signs, road signs, number plates. */
export function signTexture(text: string, bg: string, fg: string, w = 512, h = 128, font = 'bold'): THREE.Texture {
  const key = `sign:${text}:${bg}:${fg}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,.25)';
  g.lineWidth = 6;
  g.strokeRect(4, 4, w - 8, h - 8);
  let size = Math.floor(h * 0.52);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  do {
    g.font = `${font} ${size}px "Trebuchet MS", system-ui, sans-serif`;
    size -= 2;
  } while (g.measureText(text).width > w * 0.88 && size > 8);
  g.fillStyle = fg;
  g.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  cache.set(key, t);
  return t;
}

/**
 * Scale a geometry's UVs so a tiling texture keeps a constant world-space size no matter
 * how big the box is. Without this you get stretched bricks and windows of random sizes.
 */
export function uvScale(geo: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
}

/** Per-face UV scaling for boxes: three.js box faces are ordered +X −X +Y −Y +Z −Z. */
export function uvScaleBox(geo: THREE.BufferGeometry, w: number, h: number, d: number, tile: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const per = 4;
  const scales: [number, number][] = [
    [d / tile, h / tile], [d / tile, h / tile],
    [w / tile, d / tile], [w / tile, d / tile],
    [w / tile, h / tile], [w / tile, h / tile],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = scales[f];
    for (let i = 0; i < per; i++) {
      const idx = f * per + i;
      if (idx >= uv.count) break;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
}

export interface Mats {
  asphalt: THREE.MeshStandardMaterial;
  paint: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  curb: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
  dirt: THREE.MeshStandardMaterial;
  brick: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  water: THREE.ShaderMaterial;
  trunk: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  plaster: THREE.MeshStandardMaterial[];
  facade: THREE.MeshStandardMaterial[];
}

export function buildMaterials(bank?: AssetBank): Mats {
  // vertexColors carries the baked ambient occlusion (see ao.ts) on every static surface
  const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ vertexColors: true, ...o });
  /** albedo + a normal map derived from it, in one go */
  const bumpy = (key: string, t: THREE.Texture, strength: number, o: THREE.MeshStandardMaterialParameters) => std({
    map: t,
    normalMap: deriveNormal(t, key, strength),
    normalScale: new THREE.Vector2(0.85, 0.85),
    ...o,
  });
  /**
   * A downloaded PBR set, if the bank has one — the procedural generator is the
   * fallback. Roughness comes from the map when present, so the scalar stays 1.
   */
  const real = (id: string, o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial | null => {
    const set = bank?.get(id);
    if (!set) return null;
    return std({
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.roughnessMap,
      roughness: 1,
      ...o,
    });
  };
  const PLASTER_TEX = [
    'plastered_wall_02', 'plastered_wall_03', 'plastered_wall_04',
    'painted_plaster_wall', 'clay_plaster', 'yellow_plaster',
  ];
  const foliageMat = bumpy('foliage', tex.foliage(), 1, { roughness: 0.9 });
  addSway(foliageMat);
  return {
    asphalt: real('asphalt_02', { metalness: 0.02 })
      ?? bumpy('asphalt', tex.asphalt(), 0.8, { roughness: 0.95, metalness: 0.02 }),
    paint: std({ color: 0xd8cf9a, roughness: 0.7 }),
    concrete: real('concrete_pavement_02', {})
      ?? bumpy('concrete', tex.concrete(), 1.5, { roughness: 0.9 }),
    curb: std({ color: 0xbdb8ad, roughness: 0.85 }),
    grass: real('leafy_grass', {})
      ?? bumpy('grass', tex.grass(), 0.5, { roughness: 1 }),
    dirt: real('dirt', {})
      ?? bumpy('dirt', tex.dirt(), 0.9, { roughness: 1 }),
    brick: real('brick_wall_09', {})
      ?? bumpy('brick', tex.brick(), 2.6, { roughness: 0.92 }),
    roof: real('clay_roof_tiles_02', {})
      ?? bumpy('rooftile', tex.roofTile(), 2.2, { roughness: 0.85 }),
    metal: real('metal_plate', { metalness: 0.6 })
      ?? bumpy('metal', tex.metal(), 0.7, { roughness: 0.45, metalness: 0.6 }),
    wood: real('wood_planks', {})
      ?? bumpy('wood', tex.wood(), 1.2, { roughness: 0.8 }),
    glass: std({ color: 0x8fbcd4, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.42 }),
    water: createWaterMaterial(),
    trunk: std({ color: 0x6b4a2f, roughness: 0.95 }),
    foliage: foliageMat,
    plaster: [0, 1, 2, 3, 4, 5].map((v) =>
      real(PLASTER_TEX[v], {})
      ?? bumpy('plaster' + v, tex.plaster(v), 1.1, { roughness: 0.85 })),
    facade: [0, 1, 2, 3].map((v) => bumpy('facade' + v, tex.facade(v), 1.8, {
      emissiveMap: tex.facadeLit(v),
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0,
      roughness: 0.62,
      metalness: 0.08,
    })),
  };
}

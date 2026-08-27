import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type WeaponId =
  | 'fists'
  | 'knife'
  | 'sword'
  | 'pistol'
  | 'smg'
  | 'ak47'
  | 'shotgun'
  | 'sniper'
  | 'rpg'
  | 'minigun';

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  category: 'melee' | 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'sniper' | 'heavy';
  melee: boolean;
  explosive?: boolean;
  damage: number;
  headMult: number;
  /** rounds per minute */
  rpm: number;
  auto: boolean;
  mag: number;
  reserveMax: number;
  defaultReserve: number;
  pellets: number;
  /** cone half-angle in radians at full spread */
  spread: number;
  range: number;
  reload: number;
  recoilPitch: number;
  recoilYaw: number;
  /** camera kick + shake */
  shake: number;
  zoom: number;
  priceAmmo: number;
  ammoPack: number;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  fists: {
    id: 'fists', name: 'FISTS', category: 'melee', melee: true, damage: 24, headMult: 1.5, rpm: 140, auto: false,
    mag: 0, reserveMax: 0, defaultReserve: 0, pellets: 1, spread: 0, range: 2.2, reload: 0,
    recoilPitch: 0, recoilYaw: 0, shake: 0.1, zoom: 1, priceAmmo: 0, ammoPack: 0,
  },
  knife: {
    id: 'knife', name: 'COMBAT KNIFE', category: 'melee', melee: true, damage: 52, headMult: 2.2, rpm: 220, auto: false,
    mag: 0, reserveMax: 0, defaultReserve: 0, pellets: 1, spread: 0, range: 2.4, reload: 0,
    recoilPitch: 0, recoilYaw: 0, shake: 0.15, zoom: 1, priceAmmo: 0, ammoPack: 0,
  },
  sword: {
    id: 'sword', name: 'KATANA', category: 'melee', melee: true, damage: 95, headMult: 2.0, rpm: 110, auto: false,
    mag: 0, reserveMax: 0, defaultReserve: 0, pellets: 1, spread: 0, range: 3.5, reload: 0,
    recoilPitch: 0, recoilYaw: 0, shake: 0.25, zoom: 1, priceAmmo: 0, ammoPack: 0,
  },
  pistol: {
    id: 'pistol', name: '9MM PISTOL', category: 'pistol', melee: false, damage: 34, headMult: 3.0, rpm: 360, auto: false,
    mag: 15, reserveMax: 150, defaultReserve: 75, pellets: 1, spread: 0.012, range: 100, reload: 1.4,
    recoilPitch: 0.026, recoilYaw: 0.008, shake: 0.35, zoom: 0.85, priceAmmo: 25, ammoPack: 30,
  },
  smg: {
    id: 'smg', name: 'MICRO SMG', category: 'smg', melee: false, damage: 24, headMult: 2.2, rpm: 760, auto: true,
    mag: 30, reserveMax: 300, defaultReserve: 120, pellets: 1, spread: 0.026, range: 85, reload: 1.8,
    recoilPitch: 0.018, recoilYaw: 0.012, shake: 0.28, zoom: 0.88, priceAmmo: 40, ammoPack: 60,
  },
  ak47: {
    id: 'ak47', name: 'AK-47', category: 'rifle', melee: false, damage: 44, headMult: 2.8, rpm: 580, auto: true,
    mag: 30, reserveMax: 240, defaultReserve: 120, pellets: 1, spread: 0.018, range: 150, reload: 2.2,
    recoilPitch: 0.038, recoilYaw: 0.016, shake: 0.52, zoom: 0.80, priceAmmo: 60, ammoPack: 60,
  },
  shotgun: {
    id: 'shotgun', name: 'PUMP SHOTGUN', category: 'shotgun', melee: false, damage: 18, headMult: 1.8, rpm: 75, auto: false,
    mag: 8, reserveMax: 64, defaultReserve: 32, pellets: 8, spread: 0.072, range: 45, reload: 2.5,
    recoilPitch: 0.075, recoilYaw: 0.02, shake: 0.95, zoom: 0.95, priceAmmo: 45, ammoPack: 16,
  },
  sniper: {
    id: 'sniper', name: 'SNIPER RIFLE', category: 'sniper', melee: false, damage: 160, headMult: 3.5, rpm: 42, auto: false,
    mag: 5, reserveMax: 35, defaultReserve: 20, pellets: 1, spread: 0.002, range: 350, reload: 2.8,
    recoilPitch: 0.09, recoilYaw: 0.015, shake: 1.1, zoom: 0.28, priceAmmo: 80, ammoPack: 10,
  },
  rpg: {
    id: 'rpg', name: 'RPG-7', category: 'heavy', melee: false, explosive: true, damage: 280, headMult: 1.0, rpm: 25, auto: false,
    mag: 1, reserveMax: 10, defaultReserve: 5, pellets: 1, spread: 0.005, range: 250, reload: 3.2,
    recoilPitch: 0.12, recoilYaw: 0.03, shake: 1.4, zoom: 0.75, priceAmmo: 150, ammoPack: 2,
  },
  minigun: {
    id: 'minigun', name: 'MINIGUN', category: 'heavy', melee: false, damage: 28, headMult: 2.0, rpm: 1200, auto: true,
    mag: 100, reserveMax: 500, defaultReserve: 200, pellets: 1, spread: 0.035, range: 120, reload: 3.5,
    recoilPitch: 0.014, recoilYaw: 0.012, shake: 0.45, zoom: 0.90, priceAmmo: 120, ammoPack: 100,
  },
};

export const WEAPON_ORDER: WeaponId[] = [
  'fists',
  'knife',
  'sword',
  'pistol',
  'smg',
  'ak47',
  'shotgun',
  'sniper',
  'rpg',
  'minigun',
];

/* ── 3D Weapon Models ──────────────────────────────────────────────────────── */

const GUNMETAL = 0x24282e;
const STEEL = 0x5a636c;
const DARK_STEEL = 0x181a1d;
const POLY = 0x111316;
const WOOD = 0x5c3317;
const BRASS = 0xc49a45;
const GOLD = 0xd4af37;
const GREEN_OLIVE = 0x384a32;
const WARHEAD_RED = 0x963224;

let gunMat: THREE.MeshStandardMaterial | null = null;
function mat(): THREE.MeshStandardMaterial {
  if (!gunMat) {
    gunMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.38,
      metalness: 0.65,
    });
  }
  return gunMat;
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

function bx(
  w: number, h: number, d: number, hex: number,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0,
): THREE.BufferGeometry {
  const g = paint(new THREE.BoxGeometry(w, h, d), hex);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function cy(
  rTop: number, rBot: number, h: number, hex: number,
  x = 0, y = 0, z = 0, axis: 'x' | 'y' | 'z' = 'z', seg = 12,
): THREE.BufferGeometry {
  const g = paint(new THREE.CylinderGeometry(rTop, rBot, h, seg), hex);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

export interface WeaponModel {
  group: THREE.Group;
  muzzle: THREE.Object3D;
}

/**
 * Creates high-detail procedural 3D weapon models.
 * Origin (0,0,0) is located at the natural hand grip.
 * Barrel runs along +Z, sights face +Y.
 */
export function createWeaponModel(id: WeaponId): WeaponModel | null {
  if (id === 'fists') return null;
  const parts: THREE.BufferGeometry[] = [];
  let muzzleZ = 0.2;
  let muzzleY = 0.05;

  if (id === 'knife') {
    parts.push(bx(0.026, 0.038, 0.12, POLY, 0, -0.015, -0.05));       // ribbed grip
    parts.push(bx(0.035, 0.07, 0.015, STEEL, 0, 0.005, 0.015));       // double guard
    parts.push(bx(0.01, 0.045, 0.20, STEEL, 0, 0.02, 0.12));          // dagger blade
    parts.push(bx(0.008, 0.02, 0.09, DARK_STEEL, 0, 0.02, 0.08));     // fuller blood groove
    muzzleZ = 0.24;
    muzzleY = 0.02;
  } else if (id === 'sword') {
    parts.push(bx(0.03, 0.04, 0.26, POLY, 0, -0.01, -0.13));          // tsuka long handle
    parts.push(cy(0.045, 0.045, 0.015, GOLD, 0, 0, 0.01, 'z', 16));    // tsuba gold guard
    parts.push(bx(0.012, 0.045, 0.78, STEEL, 0, 0.015, 0.41));        // razor steel katana blade
    parts.push(cy(0.02, 0.02, 0.02, GOLD, 0, -0.01, -0.26, 'z', 10));  // pommel end
    muzzleZ = 0.82;
    muzzleY = 0.015;
  } else if (id === 'pistol') {
    parts.push(bx(0.042, 0.13, 0.065, POLY, 0, -0.065, -0.03, 0.22)); // ergonomic grip
    parts.push(bx(0.044, 0.05, 0.17, GUNMETAL, 0, 0.008, 0.045));      // lower frame + rail
    parts.push(bx(0.042, 0.055, 0.21, STEEL, 0, 0.055, 0.05));         // steel slide
    parts.push(cy(0.012, 0.012, 0.06, DARK_STEEL, 0, 0.055, 0.17));   // barrel bore
    parts.push(bx(0.012, 0.018, 0.016, STEEL, 0, 0.092, 0.14));       // front sight
    parts.push(bx(0.028, 0.018, 0.014, STEEL, 0, 0.092, -0.04));      // rear sight
    parts.push(bx(0.012, 0.03, 0.012, STEEL, 0, -0.018, 0.005));      // trigger
    parts.push(bx(0.038, 0.012, 0.065, GUNMETAL, 0, -0.038, 0.005));   // trigger guard
    muzzleZ = 0.22;
    muzzleY = 0.055;
  } else if (id === 'smg') {
    parts.push(bx(0.042, 0.12, 0.065, POLY, 0, -0.06, -0.07, 0.2));   // pistol grip
    parts.push(bx(0.05, 0.095, 0.32, GUNMETAL, 0, 0.01, 0.06));        // receiver
    parts.push(cy(0.018, 0.018, 0.18, DARK_STEEL, 0, 0.035, 0.29));   // barrel shroud
    parts.push(bx(0.032, 0.18, 0.05, STEEL, 0, -0.075, 0.06, 0.1));   // extended magazine
    parts.push(bx(0.045, 0.06, 0.11, POLY, 0, -0.02, 0.19));          // tactical foregrip
    parts.push(bx(0.035, 0.03, 0.18, STEEL, 0, 0.065, -0.12));        // telescopic stock
    parts.push(bx(0.042, 0.1, 0.03, POLY, 0, 0.045, -0.21));          // stock butt plate
    muzzleZ = 0.40;
    muzzleY = 0.035;
  } else if (id === 'ak47') {
    parts.push(bx(0.044, 0.12, 0.07, WOOD, 0, -0.065, -0.08, 0.25));  // wood pistol grip
    parts.push(bx(0.054, 0.09, 0.36, GUNMETAL, 0, 0.02, 0.07));       // steel receiver
    parts.push(cy(0.015, 0.015, 0.36, STEEL, 0, 0.04, 0.41));         // long steel barrel
    parts.push(cy(0.016, 0.016, 0.22, GUNMETAL, 0, 0.075, 0.28));      // gas piston tube
    parts.push(bx(0.052, 0.065, 0.18, WOOD, 0, 0.05, 0.26));          // wood foregrip
    parts.push(bx(0.046, 0.1, 0.24, WOOD, 0, 0.0, -0.22, -0.1));      // wooden buttstock
    parts.push(bx(0.036, 0.22, 0.09, STEEL, 0, -0.09, 0.08, 0.4));    // curved banana magazine
    parts.push(bx(0.016, 0.035, 0.02, STEEL, 0, 0.095, 0.55));        // hooded front sight
    parts.push(cy(0.014, 0.018, 0.05, DARK_STEEL, 0, 0.04, 0.60));    // slant muzzle brake
    muzzleZ = 0.62;
    muzzleY = 0.04;
  } else if (id === 'shotgun') {
    parts.push(bx(0.046, 0.11, 0.08, WOOD, 0, -0.055, -0.09, 0.2));   // wood grip
    parts.push(bx(0.055, 0.08, 0.32, GUNMETAL, 0, 0.02, 0.08));       // receiver
    parts.push(cy(0.02, 0.02, 0.50, STEEL, 0, 0.05, 0.45));           // heavy 12ga barrel
    parts.push(cy(0.016, 0.016, 0.46, DARK_STEEL, 0, 0.01, 0.43));    // under-barrel tube
    parts.push(bx(0.052, 0.055, 0.16, POLY, 0, 0.005, 0.36));         // pump slide
    parts.push(bx(0.05, 0.11, 0.24, WOOD, 0, 0.0, -0.21, -0.1));      // wooden stock
    parts.push(bx(0.052, 0.12, 0.04, POLY, 0, -0.01, -0.33));         // recoil rubber pad
    parts.push(cy(0.006, 0.006, 0.015, BRASS, 0, 0.08, 0.68, 'y'));   // bead sight
    muzzleZ = 0.70;
    muzzleY = 0.05;
  } else if (id === 'sniper') {
    parts.push(bx(0.044, 0.12, 0.075, POLY, 0, -0.065, -0.1, 0.22));  // grip
    parts.push(bx(0.054, 0.09, 0.4, GUNMETAL, 0, 0.02, 0.06));        // heavy receiver
    parts.push(cy(0.018, 0.016, 0.72, DARK_STEEL, 0, 0.045, 0.57));   // precision barrel
    parts.push(bx(0.038, 0.04, 0.09, STEEL, 0, 0.045, 0.94));         // twin-baffle muzzle brake
    parts.push(bx(0.05, 0.11, 0.26, POLY, 0, 0.0, -0.22, -0.08));     // thumbhole stock
    parts.push(bx(0.036, 0.13, 0.07, STEEL, 0, -0.07, 0.02));         // box mag
    // High-powered optical scope
    parts.push(cy(0.024, 0.024, 0.28, DARK_STEEL, 0, 0.13, 0.1));
    parts.push(cy(0.032, 0.026, 0.08, DARK_STEEL, 0, 0.13, 0.24));
    parts.push(cy(0.028, 0.024, 0.06, DARK_STEEL, 0, 0.13, -0.04));
    parts.push(bx(0.02, 0.05, 0.03, STEEL, 0, 0.085, 0.03));
    parts.push(bx(0.02, 0.05, 0.03, STEEL, 0, 0.085, 0.17));
    // Bipod legs
    parts.push(bx(0.015, 0.16, 0.015, STEEL, -0.04, -0.07, 0.54, 0, 0, 0.3));
    parts.push(bx(0.015, 0.16, 0.015, STEEL, 0.04, -0.07, 0.54, 0, 0, -0.3));
    muzzleZ = 0.98;
    muzzleY = 0.045;
  } else if (id === 'rpg') {
    parts.push(cy(0.038, 0.038, 0.85, GREEN_OLIVE, 0, 0.06, 0.05));   // launch tube
    parts.push(cy(0.048, 0.048, 0.32, WOOD, 0, 0.06, 0.02));          // wooden heat shield
    parts.push(cy(0.055, 0.038, 0.16, GREEN_OLIVE, 0, 0.06, -0.42));  // exhaust flare
    parts.push(bx(0.04, 0.12, 0.06, POLY, 0, -0.04, 0.15, 0.2));      // forward grip + trigger
    parts.push(bx(0.04, 0.09, 0.05, POLY, 0, -0.02, -0.15));          // rear handle
    parts.push(bx(0.03, 0.07, 0.09, DARK_STEEL, 0.05, 0.12, 0.12));   // PGO-7 optic sight
    // PG-7V Rocket warhead
    parts.push(cy(0.018, 0.018, 0.16, STEEL, 0, 0.06, 0.52));
    parts.push(cy(0.052, 0.025, 0.18, GREEN_OLIVE, 0, 0.06, 0.65));
    parts.push(cy(0.012, 0.048, 0.1, WARHEAD_RED, 0, 0.06, 0.77));
    muzzleZ = 0.84;
    muzzleY = 0.06;
  } else if (id === 'minigun') {
    parts.push(cy(0.07, 0.07, 0.32, DARK_STEEL, 0, 0.02, 0.0));       // motor drive body
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      const bx_ = Math.cos(ang) * 0.042;
      const by_ = Math.sin(ang) * 0.042 + 0.02;
      parts.push(cy(0.011, 0.011, 0.62, STEEL, bx_, by_, 0.44));       // 6 steel barrels
    }
    parts.push(cy(0.058, 0.058, 0.03, GUNMETAL, 0, 0.02, 0.28));
    parts.push(cy(0.058, 0.058, 0.03, GUNMETAL, 0, 0.02, 0.52));
    parts.push(cy(0.058, 0.058, 0.04, DARK_STEEL, 0, 0.02, 0.74));    // muzzle clamp
    parts.push(bx(0.04, 0.08, 0.04, POLY, 0, 0.12, 0.06));
    parts.push(bx(0.04, 0.04, 0.24, POLY, 0, 0.16, -0.04));           // carrying top handle
    parts.push(bx(0.04, 0.1, 0.05, POLY, 0, 0.11, -0.14));            // rear spade grip
    muzzleZ = 0.78;
    muzzleY = 0.02;
  }

  const merged = mergeGeometries(parts, false)!;
  const mesh = new THREE.Mesh(merged, mat());
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const group = new THREE.Group();
  group.add(mesh);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, muzzleY, muzzleZ);
  mesh.add(muzzle);

  return { group, muzzle };
}

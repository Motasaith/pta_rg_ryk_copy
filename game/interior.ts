import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Mats } from './materials';
import { KIND, Physics } from './physics';

/**
 * Rooms you can walk into.
 *
 * Shops used to be a counter on the pavement that opened a full-screen menu, and home was
 * a front door you could not open at all. Both are now places: you walk in, the world
 * fades, and you are stood in a room with things in it that you walk up to.
 *
 * Built the way GTA built interiors, because it is still the cheap answer: an interior is
 * a separate cell parked far outside the city rather than a hollowed-out building. That
 * buys three things at once — no hole to cut in the shopfront, no chance of the room and
 * the street fighting over the same collision space, and the city stays exactly as it was
 * so stepping back out is instant.
 *
 * Cost: one room per kind, built the first time somebody opens that door and kept after.
 * Four rooms of about forty boxes each, merged to one mesh apiece.
 */

export type InteriorKind = 'ammo' | 'health' | 'food' | 'home';

/** Something in the room you can walk up to and use. */
export interface Stand {
  x: number;
  z: number;
  /** What the engine does about it. See `useStand` in engine.ts. */
  action: string;
  /** Weapon id, or whatever else the action needs. */
  arg?: string;
  /** Fallback prompt; the engine overrides it where a live price is worth showing. */
  label: string;
}

export interface Interior {
  kind: InteriorKind;
  root: THREE.Group;
  /** Where the player lands, and which way they are facing. */
  entry: { x: number; z: number; yaw: number };
  /** The doorway. Walk back into it to leave. */
  door: { x: number; z: number };
  stands: Stand[];
  /** Floor height. Everything is authored from here up. */
  y: number;
}

/**
 * Where the interiors live: far enough out that the city is past the draw distance and
 * fogged away, so no part of it is ever visible through the doorway.
 */
const CELL_X = -6000;
const CELL_Z = -6000;
const CELL_GAP = 60;
const ORDER: InteriorKind[] = ['ammo', 'health', 'food', 'home'];

const W = 5.4;      // half-width
const D = 4.6;      // half-depth
const H = 3.1;      // ceiling
const WALL = 0.3;
const DOOR_W = 1.5;

/* ── geometry helpers ─────────────────────────────────────────────────────── */

/**
 * The city's materials all read vertex colours, because that is where its baked AO lives.
 * Interiors get a cheap stand-in: flat tint, with a contact darkening near the floor, so
 * furniture reads as sitting on the ground rather than hovering over it.
 */
function shade(geo: THREE.BufferGeometry, tint: number, floorY: number): THREE.BufferGeometry {
  const c = new THREE.Color(tint);
  const pos = geo.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const h = Math.max(0, pos.getY(i) - floorY);
    const k = 0.62 + 0.38 * Math.min(1, h / 0.9);
    arr[i * 3] = c.r * k;
    arr[i * 3 + 1] = c.g * k;
    arr[i * 3 + 2] = c.b * k;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

interface Builder {
  add(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number,
      tint?: number, solid?: boolean): void;
}

/* ── the rooms ────────────────────────────────────────────────────────────── */

/**
 * What goes in each kind of room, and what you can do with it.
 *
 * Kept as one function per room rather than a data table: the props and the stands have to
 * agree about where things are, and two lists that have to agree drift apart.
 */
function dress(kind: InteriorKind, b: Builder, m: Mats, stands: Stand[]): void {
  const counter = (x: number, z: number, w: number, d: number): void => {
    b.add(m.wood, w, 0.94, d, x, 0.47, z, 0x8a6a44);
    b.add(m.concrete, w + 0.1, 0.06, d + 0.1, x, 0.97, z, 0xd8d3c6, false);
  };
  const shelf = (x: number, z: number, w: number, rot: boolean): void => {
    const [sw, sd] = rot ? [0.45, w] : [w, 0.45];
    b.add(m.metal, sw, 0.08, sd, x, 0.6, z, 0x9aa0a6);
    b.add(m.metal, sw, 0.08, sd, x, 1.15, z, 0x9aa0a6);
    b.add(m.metal, sw, 0.08, sd, x, 1.7, z, 0x9aa0a6);
    b.add(m.concrete, sw, 2.1, 0.06, x, 1.05, z + (rot ? 0 : -0.2), 0x6e747a, false);
  };

  if (kind === 'ammo') {
    counter(0, D - 1.4, 4.6, 0.8);
    // gun racks down both side walls: this is what you walk up to
    for (const [i, side] of [-1, 1].entries()) {
      const x = side * (W - 0.85);
      b.add(m.wood, 0.35, 2.2, 5.4, x, 1.2, 0.4, 0x6b4a2f);
      void i;
    }
    stands.push(
      { x: -(W - 1.5), z: -0.9, action: 'ammo', arg: 'pistol', label: 'buy pistol rounds' },
      { x: -(W - 1.5), z: 1.5, action: 'ammo', arg: 'smg', label: 'buy SMG rounds' },
      { x: W - 1.5, z: -0.9, action: 'ammo', arg: 'ak47', label: 'buy rifle rounds' },
      { x: W - 1.5, z: 1.5, action: 'ammo', arg: 'shotgun', label: 'buy shells' },
      { x: 0, z: D - 2.4, action: 'menu', label: 'ask at the counter' },
      { x: -3.2, z: D - 2.5, action: 'armour', label: 'buy body armour' },
    );
  } else if (kind === 'health') {
    counter(0, D - 1.4, 4.0, 0.8);
    shelf(-(W - 1.0), -1.2, 3.6, true);
    shelf(W - 1.0, -1.2, 3.6, true);
    b.add(m.glass, 1.6, 2.0, 0.7, W - 1.2, 1.0, 2.2, 0xa8d0dc);   // chiller
    stands.push(
      { x: 0, z: D - 2.4, action: 'health', label: 'buy a first-aid kit' },
      { x: -3.2, z: D - 2.5, action: 'armour', label: 'buy body armour' },
      { x: W - 2.8, z: 2.2, action: 'menu', label: 'browse the shelves' },
    );
  } else if (kind === 'food') {
    counter(0, D - 1.4, 3.4, 0.9);
    // a tandoor, and a couple of tables to eat at
    b.add(m.brick, 1.0, 1.25, 1.0, W - 1.6, 0.63, D - 1.6, 0xa8674a);
    for (const tx of [-2.6, 1.0]) {
      b.add(m.wood, 1.3, 0.08, 1.3, tx, 0.76, -1.6, 0x7a5a3a);
      b.add(m.metal, 0.12, 0.76, 0.12, tx, 0.38, -1.6, 0x6a6a70);
    }
    stands.push(
      { x: 0, z: D - 2.4, action: 'health', label: 'order a plate' },
      { x: -2.6, z: 0.3, action: 'menu', label: 'read the menu board' },
    );
  } else {
    // home
    b.add(m.wood, 2.1, 0.42, 1.9, -(W - 1.6), 0.21, D - 1.6, 0x6b4a2f);        // bed base
    b.add(m.paint, 2.0, 0.26, 1.8, -(W - 1.6), 0.55, D - 1.6, 0xd8d3c6, false); // mattress
    b.add(m.paint, 0.9, 0.18, 0.5, -(W - 1.6), 0.77, D - 2.3, 0xe8e4d8, false); // pillow
    b.add(m.wood, 1.2, 2.1, 0.6, W - 1.0, 1.05, D - 1.4, 0x5d4230);            // wardrobe
    b.add(m.metal, 1.0, 1.8, 0.7, W - 1.0, 0.9, -1.6, 0xb8bcc0);               // fridge
    // The television goes against the side wall, not the front one. The doorway is at
    // x = 0 on the front wall, and the first version stood the TV directly in it — you
    // arrived home already inside the furniture.
    b.add(m.wood, 0.7, 0.5, 2.4, -(W - 0.7), 0.25, -1.0, 0x6b4a2f);            // TV stand
    b.add(m.glass, 0.08, 1.0, 1.7, -(W - 0.78), 1.05, -1.0, 0x1a2026, false);  // TV
    b.add(m.wood, 2.6, 0.75, 1.0, -1.0, 0.38, -1.4, 0x7a4a3a);                 // charpai/sofa
    stands.push(
      { x: -(W - 1.6), z: D - 3.0, action: 'sleep', label: 'sleep until morning' },
      { x: W - 2.2, z: -1.6, action: 'eat', label: 'eat something' },
      { x: W - 2.3, z: D - 1.4, action: 'wardrobe', label: 'get changed' },
      { x: -(W - 2.4), z: -1.0, action: 'tv', label: 'watch the news' },
    );
  }
}

/* ── assembly ─────────────────────────────────────────────────────────────── */

/**
 * Build one interior and add it to the scene.
 *
 * Its colliders go into the same static world as the city. They are six kilometres away
 * from anything, so they cost one spatial-hash bucket and are never consulted again except
 * while somebody is actually stood in the room.
 */
export function buildInterior(
  kind: InteriorKind, m: Mats, phys: Physics, scene: THREE.Scene, floorY = 0,
): Interior {
  const ox = CELL_X + ORDER.indexOf(kind) * CELL_GAP;
  const oz = CELL_Z;
  const root = new THREE.Group();
  root.position.set(ox, floorY, oz);
  scene.add(root);

  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const push = (mat: THREE.Material, geo: THREE.BufferGeometry): void => {
    const list = byMat.get(mat);
    if (list) list.push(geo); else byMat.set(mat, [geo]);
  };

  const b: Builder = {
    add(mat, w, h, d, x, y, z, tint = 0xffffff, solid = true) {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      push(mat, shade(g, tint, 0));
      if (solid && h > 0.25) {
        // addLate, not addCentered: the world was hashed at load and this room is being
        // built now, so it has to put itself into the grid rather than wait for a rebuild
        // that will never come.
        phys.addLateCentered(ox + x, oz + z, w / 2, d / 2, floorY + y - h / 2, floorY + y + h / 2, KIND.Prop);
      }
    },
  };

  // shell: floor, ceiling, three walls, and a front wall with a doorway cut into it
  // (one pass — every b.add both merges geometry and registers a collider)
  b.add(m.concrete, W * 2, 0.3, D * 2, 0, -0.15, 0, 0xbdb8ad, false);
  // The floor is Ground rather than Prop: groundHeight has to find it, or the player
  // arrives in the room and falls through it.
  phys.addLateCentered(ox, oz, W + WALL, D + WALL, floorY - 0.5, floorY, KIND.Ground);
  b.add(m.paint, W * 2, 0.25, D * 2, 0, H + 0.12, 0, 0xe6e2d6, false);
  b.add(m.brick, WALL, H, D * 2, -W - WALL / 2, H / 2, 0, 0xb9a894);
  b.add(m.brick, WALL, H, D * 2, W + WALL / 2, H / 2, 0, 0xb9a894);
  b.add(m.brick, (W + WALL) * 2, H, WALL, 0, H / 2, D + WALL / 2, 0xb9a894);
  const jamb = (W + WALL - DOOR_W / 2) / 2 + DOOR_W / 2;
  b.add(m.brick, W + WALL - DOOR_W / 2, H, WALL, -jamb, H / 2, -D - WALL / 2, 0xb9a894);
  b.add(m.brick, W + WALL - DOOR_W / 2, H, WALL, jamb, H / 2, -D - WALL / 2, 0xb9a894);
  b.add(m.brick, DOOR_W, H - 2.15, WALL, 0, H - (H - 2.15) / 2, -D - WALL / 2, 0xb9a894, false);
  // A closed door in the opening, and it is solid.
  //
  // Not decoration: the third-person camera pulls back four metres, the player arrives
  // facing into the room with the doorway directly behind them, and an *open* doorway is
  // a four-metre-wide hole for the camera to slide straight out of. The first version
  // framed the whole interior from outside the building, through the gap. You leave with
  // E, not by walking through, so sealing it costs nothing.
  b.add(m.wood, DOOR_W - 0.06, 2.12, 0.1, 0, 1.06, -D - 0.06, 0x6b4a2f);
  b.add(m.metal, 0.09, 0.09, 0.06, DOOR_W / 2 - 0.28, 1.05, -D - 0.13, 0xc9a44a, false);   // handle

  const stands: Stand[] = [];
  dress(kind, b, m, stands);

  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // A closed room gets no sun, and the city's ambient alone leaves it a cave at night.
  const lamp = new THREE.PointLight(0xffe8c4, 26, 16, 2);
  lamp.position.set(0, H - 0.45, 1.4);
  root.add(lamp);
  const lamp2 = new THREE.PointLight(0xffe4bc, 16, 13, 2);
  lamp2.position.set(0, H - 0.5, -D + 1.6);
  root.add(lamp2);

  // A marker on the floor at every stand.
  //
  // Without one an interior is a room with invisible hotspots in it: you know there is a
  // wardrobe because you can see a wardrobe, but not that standing *there* rather than
  // *there* is what brings the prompt up. One merged, unlit disc per room, so it costs a
  // single extra draw call and reads instantly at any time of day.
  const discs: THREE.BufferGeometry[] = [];
  for (const s of stands) {
    const d = new THREE.CylinderGeometry(0.42, 0.42, 0.02, 18);
    d.translate(s.x, 0.012, s.z);
    discs.push(d);
  }
  // And one on the mat inside the door, because the way out has to be as findable as
  // everything else in the room — it is the only thing in here you always need.
  const mat0 = new THREE.BoxGeometry(DOOR_W + 0.3, 0.02, 0.85);
  mat0.translate(0, 0.012, -D + 0.45);
  discs.push(mat0);
  if (discs.length) {
    const mesh = new THREE.Mesh(
      mergeGeometries(discs, false)!,
      new THREE.MeshBasicMaterial({ color: 0xffc65a, transparent: true, opacity: 0.34, depthWrite: false }),
    );
    mesh.renderOrder = 2;
    root.add(mesh);
  }

  for (const s of stands) { s.x += ox; s.z += oz; }

  return {
    kind, root,
    // Far enough in that the camera has somewhere to be behind the player's shoulder,
    // and still clear of the doorway trigger.
    entry: { x: ox, z: oz - D + 1.9, yaw: 0 },
    door: { x: ox, z: oz - D - 0.1 },
    stands,
    y: floorY,
  };
}

/** How close you have to be to a stand for its prompt to come up. */
export const STAND_REACH = 1.8;

/** The nearest thing you could use from here, or null. */
export function nearestStand(it: Interior, x: number, z: number): Stand | null {
  let best: Stand | null = null;
  let bd = STAND_REACH * STAND_REACH;
  for (const s of it.stands) {
    const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/** True once the player has walked back into the doorway. */
export function atDoor(it: Interior, x: number, z: number): boolean {
  return Math.abs(x - it.door.x) < DOOR_W * 0.7 && z < it.door.z + 0.9;
}

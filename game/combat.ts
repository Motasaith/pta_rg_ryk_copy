import * as THREE from 'three';
import { glowTexture, splatTexture } from './materials';
import { KIND, Physics } from './physics';
import { Ped } from './peds';
import { Vehicle } from './vehicle';

export type HitKind = 'none' | 'world' | 'ground' | 'ped' | 'vehicle' | 'player';

export interface Hit {
  kind: HitKind;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  dist: number;
  ped: Ped | null;
  veh: Vehicle | null;
  head: boolean;
  /** network id of the player hit, 0 for anything else */
  netId: number;
}

export interface NetTarget {
  id: number;
  x: number;
  y: number;
  z: number;
  /** true for someone we must not be able to shoot: a teammate, or a corpse */
  friendly: boolean;
}

function raySphere(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number, r: number,
): number {
  const ex = cx - ox, ey = cy - oy, ez = cz - oz;
  const b = ex * dx + ey * dy + ez * dz;
  const c = ex * ex + ey * ey + ez * ez - r * r;
  if (c > 0 && b < 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = b - Math.sqrt(disc);
  return t >= 0 ? t : (c <= 0 ? 0 : -1);
}

/** Simple GPU-friendly particle field: one draw call, dead particles parked off-screen. */
class ParticleField {
  pts: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private ttl: Float32Array;
  private head = 0;

  constructor(
    scene: THREE.Scene,
    private cap: number,
    colour: number,
    size: number,
    private gravity: number,
    additive = false,
  ) {
    this.pos = new Float32Array(cap * 3).fill(-9999);
    this.vel = new Float32Array(cap * 3);
    this.ttl = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.pts = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: colour,
        size,
        map: glowTexture(),
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        opacity: additive ? 0.9 : 0.95,
      }),
    );
    this.pts.frustumCulled = false;
    scene.add(this.pts);
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, ttl: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.ttl[i] = ttl;
  }

  update(dt: number): void {
    let live = false;
    for (let i = 0; i < this.cap; i++) {
      if (this.ttl[i] <= 0) continue;
      this.ttl[i] -= dt;
      if (this.ttl[i] <= 0) {
        this.pos[i * 3 + 1] = -9999;
        continue;
      }
      live = true;
      this.vel[i * 3 + 1] -= this.gravity * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    if (live) (this.pts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.pts.geometry.dispose();
    (this.pts.material as THREE.Material).dispose();
    this.pts.removeFromParent();
  }
}

interface Decal {
  mesh: THREE.Mesh;
  life: number;
  max: number;
}

export interface ActiveRocket {
  mesh: THREE.Group;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  damage: number;
}

/** Bullets, rockets, blood, dust, fire, smoke, and decals. */
export class Combat {
  private blood: ParticleField;
  private dust: ParticleField;
  private fire: ParticleField;
  private smoke: ParticleField;
  private decals: Decal[] = [];
  private decalHead = 0;
  private tracers: { line: THREE.Line; life: number }[] = [];
  private tracerHead = 0;
  private flash: THREE.Sprite;
  private flashT = 0;
  private rockets: ActiveRocket[] = [];
  private rocketProto: THREE.Group;
  bloodEnabled = true;

  onExplosion?: (x: number, y: number, z: number, damage: number, radius: number) => void;

  constructor(private scene: THREE.Scene, private phys: Physics, decalCount = 48) {
    this.blood = new ParticleField(scene, 360, 0x9c0f10, 0.14, 9);
    this.dust = new ParticleField(scene, 240, 0xb9b2a4, 0.18, 3.5);
    this.fire = new ParticleField(scene, 280, 0xff7711, 0.32, -1.2, true);
    this.smoke = new ParticleField(scene, 320, 0x555a60, 0.45, -0.6, false);

    const splat = splatTexture();
    for (let i = 0; i < decalCount; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: splat,
          color: 0x6e0a0a,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      scene.add(m);
      this.decals.push({ mesh: m, life: 0, max: 1 });
    }

    for (let i = 0; i < 24; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({
          color: 0xffd070,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this.tracers.push({ line, life: 0 });
    }

    this.flash = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        color: 0xffc84a,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.flash.scale.setScalar(0.6);
    this.flash.visible = false;
    scene.add(this.flash);

    // RPG rocket prototype
    this.rocketProto = new THREE.Group();
    const rBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.032, 0.5, 8),
      new THREE.MeshStandardMaterial({ color: 0x384a32, roughness: 0.5 }),
    );
    rBody.rotation.x = Math.PI / 2;
    const rHead = new THREE.Mesh(
      new THREE.ConeGeometry(0.065, 0.22, 8),
      new THREE.MeshStandardMaterial({ color: 0x963224, roughness: 0.4 }),
    );
    rHead.rotation.x = Math.PI / 2;
    rHead.position.z = 0.32;
    this.rocketProto.add(rBody, rHead);
  }

  spawnRocket(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    speed = 52, damage = 280,
  ): void {
    const mesh = this.rocketProto.clone();
    mesh.position.set(ox, oy, oz);
    mesh.lookAt(ox + dx, oy + dy, oz + dz);
    this.scene.add(mesh);
    this.rockets.push({
      mesh,
      x: ox, y: oy, z: oz,
      vx: dx * speed, vy: dy * speed, vz: dz * speed,
      life: 4.5,
      damage,
    });
  }

  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxT: number, peds: Ped[], skipPed: Ped | null, skipVeh: Vehicle | null,
    players: NetTarget[] = [],
  ): Hit {
    const hit: Hit = {
      kind: 'none', x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, dist: maxT,
      ped: null, veh: null, head: false, netId: 0,
    };
    let bestT = maxT;

    const w = this.phys.raycast(ox, oy, oz, dx, dy, dz, maxT, true, 0, skipVeh ?? undefined);
    if (w) {
      bestT = w.t;
      hit.kind = w.box && w.box.kind === KIND.Vehicle ? 'vehicle' : 'world';
      hit.veh = w.box && w.box.kind === KIND.Vehicle ? (w.box.owner as Vehicle) : null;
      hit.nx = w.nx; hit.ny = w.ny; hit.nz = w.nz;
    }

    if (dy < -1e-6) {
      const tg = -oy / dy;
      if (tg > 0 && tg < bestT) {
        bestT = tg;
        hit.kind = 'ground';
        hit.veh = null;
        hit.nx = 0; hit.ny = 1; hit.nz = 0;
      }
    }

    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      if (p === skipPed) continue;
      if (p.state === 'dead' && p.deadT >= 1) continue;
      const sc = p.h.look.scale;
      const ex = p.x - ox, ey = p.y + 0.9 - oy, ez = p.z - oz;
      const along = ex * dx + ey * dy + ez * dz;
      if (along < -1.5 || along > bestT + 1.2) continue;
      const lat = Math.hypot(ex - dx * along, ey - dy * along, ez - dz * along);
      if (lat > 1.2) continue;

      const th = raySphere(ox, oy, oz, dx, dy, dz, p.x, p.y + 1.64 * sc, p.z, 0.17 * sc);
      const tt = raySphere(ox, oy, oz, dx, dy, dz, p.x, p.y + 1.15 * sc, p.z, 0.3 * sc);
      const tl = raySphere(ox, oy, oz, dx, dy, dz, p.x, p.y + 0.5 * sc, p.z, 0.26 * sc);
      let t = -1, head = false;
      if (th >= 0) { t = th; head = true; }
      if (tt >= 0 && (t < 0 || tt < t)) { t = tt; head = false; }
      if (tl >= 0 && (t < 0 || tl < t)) { t = tl; head = false; }
      if (t >= 0 && t < bestT) {
        bestT = t;
        hit.kind = 'ped';
        hit.ped = p;
        hit.veh = null;
        hit.head = head;
        hit.nx = -dx; hit.ny = -dy; hit.nz = -dz;
      }
    }

    for (let i = 0; i < players.length; i++) {
      const q = players[i];
      if (q.friendly) continue;
      const ex = q.x - ox, ey = q.y + 0.9 - oy, ez = q.z - oz;
      const along = ex * dx + ey * dy + ez * dz;
      if (along < -1.5 || along > bestT + 1.2) continue;
      const lat = Math.hypot(ex - dx * along, ey - dy * along, ez - dz * along);
      if (lat > 1.2) continue;

      const th = raySphere(ox, oy, oz, dx, dy, dz, q.x, q.y + 1.64, q.z, 0.17);
      const tt = raySphere(ox, oy, oz, dx, dy, dz, q.x, q.y + 1.15, q.z, 0.3);
      const tl = raySphere(ox, oy, oz, dx, dy, dz, q.x, q.y + 0.5, q.z, 0.26);
      let t = -1, head = false;
      if (th >= 0) { t = th; head = true; }
      if (tt >= 0 && (t < 0 || tt < t)) { t = tt; head = false; }
      if (tl >= 0 && (t < 0 || tl < t)) { t = tl; head = false; }
      if (t >= 0 && t < bestT) {
        bestT = t;
        hit.kind = 'player';
        hit.ped = null;
        hit.veh = null;
        hit.netId = q.id;
        hit.head = head;
        hit.nx = -dx; hit.ny = -dy; hit.nz = -dz;
      }
    }

    hit.dist = bestT;
    hit.x = ox + dx * bestT;
    hit.y = oy + dy * bestT;
    hit.z = oz + dz * bestT;
    return hit;
  }

  tracer(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, color = 0xffd070): void {
    const t = this.tracers[this.tracerHead];
    this.tracerHead = (this.tracerHead + 1) % this.tracers.length;
    const p = t.line.geometry.attributes.position as THREE.BufferAttribute;
    p.setXYZ(0, x1, y1, z1);
    p.setXYZ(1, x2, y2, z2);
    p.needsUpdate = true;
    t.life = 0.055;
    t.line.visible = true;
    (t.line.material as THREE.LineBasicMaterial).color.setHex(color);
    (t.line.material as THREE.LineBasicMaterial).opacity = 0.95;
  }

  muzzleFlash(x: number, y: number, z: number, scale = 0.55): void {
    this.flash.position.set(x, y, z);
    this.flash.scale.setScalar(scale * (0.85 + Math.random() * 0.4));
    this.flash.material.rotation = Math.random() * 6.28;
    this.flash.visible = true;
    this.flashT = 0.045;
  }

  impact(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    for (let i = 0; i < 6; i++) {
      this.dust.emit(
        x + nx * 0.05, y + ny * 0.05, z + nz * 0.05,
        nx * 1.6 + (Math.random() - 0.5) * 2.4,
        ny * 1.6 + Math.random() * 2.2,
        nz * 1.6 + (Math.random() - 0.5) * 2.4,
        0.3 + Math.random() * 0.25,
      );
      this.fire.emit(
        x + nx * 0.04, y + ny * 0.04, z + nz * 0.04,
        nx * 2.2 + (Math.random() - 0.5) * 3.5,
        ny * 2.2 + Math.random() * 3.5,
        nz * 2.2 + (Math.random() - 0.5) * 3.5,
        0.15 + Math.random() * 0.15,
      );
    }
  }

  bloodBurst(x: number, y: number, z: number, dx: number, dy: number, dz: number, amount: number): void {
    if (!this.bloodEnabled) return;
    for (let i = 0; i < amount; i++) {
      this.blood.emit(
        x, y, z,
        dx * (1.5 + Math.random() * 3) + (Math.random() - 0.5) * 2.6,
        dy * 1.4 + Math.random() * 2.8,
        dz * (1.5 + Math.random() * 3) + (Math.random() - 0.5) * 2.6,
        0.45 + Math.random() * 0.4,
      );
    }
  }

  bloodPool(x: number, y: number, z: number, size = 1.6, life = 45): void {
    if (!this.bloodEnabled) return;
    const d = this.decals[this.decalHead];
    this.decalHead = (this.decalHead + 1) % this.decals.length;
    d.mesh.position.set(x, y + 0.02, z);
    d.mesh.rotation.z = Math.random() * 6.28;
    d.mesh.scale.setScalar(size * (0.8 + Math.random() * 0.5));
    (d.mesh.material as THREE.MeshBasicMaterial).color.setHex(0x6e0a0a);
    d.mesh.visible = true;
    d.life = life;
    d.max = life;
    (d.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9;
  }

  scorchMark(x: number, y: number, z: number, size = 3.5): void {
    const d = this.decals[this.decalHead];
    this.decalHead = (this.decalHead + 1) % this.decals.length;
    d.mesh.position.set(x, y + 0.02, z);
    d.mesh.rotation.z = Math.random() * 6.28;
    d.mesh.scale.setScalar(size);
    (d.mesh.material as THREE.MeshBasicMaterial).color.setHex(0x111113);
    d.mesh.visible = true;
    d.life = 60;
    d.max = 60;
    (d.mesh.material as THREE.MeshBasicMaterial).opacity = 0.95;
  }

  explode(
    x: number, y: number, z: number,
    damage = 280, radius = 7.5,
  ): void {
    this.muzzleFlash(x, y + 0.5, z, 3.2);
    this.scorchMark(x, y, z, radius * 0.7);

    // Fire blast
    for (let i = 0; i < 48; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.5;
      const spd = 4 + Math.random() * 12;
      this.fire.emit(
        x, y + 0.2, z,
        Math.cos(theta) * Math.cos(phi) * spd,
        Math.sin(phi) * spd + 2.5,
        Math.sin(theta) * Math.cos(phi) * spd,
        0.35 + Math.random() * 0.35,
      );
    }
    // Heavy smoke billowing upwards
    for (let i = 0; i < 55; i++) {
      const theta = Math.random() * Math.PI * 2;
      const spd = 1.5 + Math.random() * 6.5;
      this.smoke.emit(
        x + (Math.random() - 0.5) * 1.5,
        y + 0.2 + Math.random() * 0.8,
        z + (Math.random() - 0.5) * 1.5,
        Math.cos(theta) * spd,
        2.5 + Math.random() * 4.5,
        Math.sin(theta) * spd,
        0.8 + Math.random() * 0.8,
      );
    }
    if (this.onExplosion) this.onExplosion(x, y, z, damage, radius);
  }

  update(
    dt: number,
    peds: Ped[] = [],
    players: NetTarget[] = [],
  ): void {
    this.blood.update(dt);
    this.dust.update(dt);
    this.fire.update(dt);
    this.smoke.update(dt);

    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) this.flash.visible = false;
    }

    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const m = t.line.material as THREE.LineBasicMaterial;
      m.opacity = Math.max(0, t.life / 0.055) * 0.9;
      if (t.life <= 0) t.line.visible = false;
    }

    for (const d of this.decals) {
      if (d.life <= 0) continue;
      d.life -= dt;
      const m = d.mesh.material as THREE.MeshBasicMaterial;
      if (d.life < 6) m.opacity = Math.max(0, (d.life / 6) * 0.9);
      if (d.life <= 0) d.mesh.visible = false;
    }

    // Rocket updates
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.life -= dt;
      const ox = r.x, oy = r.y, oz = r.z;
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.z += r.vz * dt;
      r.mesh.position.set(r.x, r.y, r.z);

      // Rocket exhaust smoke & fire trail
      const spd = Math.hypot(r.vx, r.vy, r.vz);
      if (spd > 0.1) {
        const bdx = -r.vx / spd, bdy = -r.vy / spd, bdz = -r.vz / spd;
        this.smoke.emit(
          r.x + bdx * 0.35, r.y + bdy * 0.35, r.z + bdz * 0.35,
          bdx * 3 + (Math.random() - 0.5) * 1.5,
          bdy * 3 + (Math.random() - 0.5) * 1.5,
          bdz * 3 + (Math.random() - 0.5) * 1.5,
          0.45 + Math.random() * 0.35,
        );
        this.fire.emit(
          r.x + bdx * 0.25, r.y + bdy * 0.25, r.z + bdz * 0.25,
          bdx * 4 + (Math.random() - 0.5) * 1.2,
          bdy * 4 + (Math.random() - 0.5) * 1.2,
          bdz * 4 + (Math.random() - 0.5) * 1.2,
          0.12,
        );
      }

      // Check collision
      const segLen = Math.hypot(r.x - ox, r.y - oy, r.z - oz);
      if (segLen > 0.01) {
        const sdx = (r.x - ox) / segLen;
        const sdy = (r.y - oy) / segLen;
        const sdz = (r.z - oz) / segLen;
        const hit = this.raycast(ox, oy, oz, sdx, sdy, sdz, segLen, peds, null, null, players);
        if (hit.kind !== 'none' || r.life <= 0) {
          const ex = hit.kind !== 'none' ? hit.x : r.x;
          const ey = hit.kind !== 'none' ? hit.y : r.y;
          const ez = hit.kind !== 'none' ? hit.z : r.z;
          this.explode(ex, ey, ez, r.damage, 8.0);
          r.mesh.removeFromParent();
          this.rockets.splice(i, 1);
        }
      }
    }
  }

  dispose(): void {
    this.blood.dispose();
    this.dust.dispose();
    this.fire.dispose();
    this.smoke.dispose();
    for (const r of this.rockets) r.mesh.removeFromParent();
    this.rockets.length = 0;
    for (const d of this.decals) {
      d.mesh.geometry.dispose();
      (d.mesh.material as THREE.Material).dispose();
      d.mesh.removeFromParent();
    }
    for (const t of this.tracers) {
      t.line.geometry.dispose();
      (t.line.material as THREE.Material).dispose();
      t.line.removeFromParent();
    }
    this.flash.material.dispose();
    this.flash.removeFromParent();
  }
}

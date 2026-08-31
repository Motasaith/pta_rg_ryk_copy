import * as THREE from 'three';
import { City, laneOffsetFor, LEFT_HAND_TRAFFIC, RoadNode } from './layout';
import { clamp, dist2, mulberry32, pick, Rng, wrapPi } from './mathx';
import { CarState, MAX_SYNC_CARS, TF_BRAKE, TF_PARKED, TF_SIREN, VEH_KINDS } from './protocol';
import { Physics } from './physics';
import {
  createVehicle, placeVehicle, poseNetVehicle, stepVehicle, updateAlarm, updateSiren, updateVehicleBox, CAR_COLOURS, Vehicle, VehKind,
} from './vehicle';

interface Lane {
  from: RoadNode;
  to: RoadNode;
  next: RoadNode;
  /** metres travelled along the current edge */
  s: number;
  /**
   * Seconds this car has failed to get anywhere.
   *
   * Measured from actual displacement rather than from speed. A car wedged against a wall
   * still reads a speed: the throttle pushes it up, the collision response knocks it back,
   * and it oscillates across any speed threshold forever while never moving a metre. That
   * is exactly how cars used to end up parked in the road for a whole session.
   */
  stuck: number;
  /** where the car was at the last progress check, and how long ago that was */
  cx: number;
  cz: number;
  ct: number;
}

/** How often to check whether a car has actually got anywhere, and how far counts. */
const PROGRESS_EVERY = 3;
const PROGRESS_MIN = 2;

// Weighted by how common each is on the street: mostly ordinary cars, the odd fast one,
// and a hypercar you will occasionally find parked and be very pleased about.
const CIVILIAN: VehKind[] = [
  'sedan', 'hatch', 'suv', 'van', 'rickshaw', 'sedan', 'hatch', 'suv',
  'sedan', 'hatch', 'rickshaw', 'van', 'muscle', 'sports', 'truck', 'hyper',
];

/**
 * Traffic drives the *same* physics as the player: an AI controller writes throttle/brake/
 * steer and stepVehicle does the rest. That means AI cars understeer, get shunted, and can
 * be pushed off the road — but they always try to get back into their lane.
 */
export class Traffic {
  cars: Vehicle[] = [];
  private lanes = new Map<Vehicle, Lane>();
  private rng: Rng = mulberry32(90210);
  /**
   * Parked cars draw from their own stream. Sharing one generator with the moving traffic
   * meant the parked layout depended on how many moving cars the quality preset asked for,
   * so two players on different settings parked different cars in different driveways —
   * one of the two reasons the world never matched online.
   */
  private parkRng: Rng = mulberry32(60613);
  private tmp = new THREE.Vector3();

  /**
   * Puppet mode: this client does not own the ambient traffic, so it stops simulating the
   * moving cars and places them where the host says instead. Parked cars stay local —
   * they do not move, and both clients place them from the same seed.
   */
  private puppet = false;
  private remote = new Map<number, Vehicle>();
  /** Cars a player has taken the wheel of. The host stops simulating and sending these. */
  private claimed = new Set<number>();
  private nextNetId = 1;

  constructor(
    private scene: THREE.Scene,
    private city: City,
    private phys: Physics,
  ) {}

  private lanePoint(from: RoadNode, to: RoadNode, s: number, out: THREE.Vector3): THREE.Vector3 {
    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    // right of travel = forward × up = (−uz, ux). Pakistan drives on the left, so we sit
    // on the opposite side of the centre line. The offset scales with the carriageway so
    // cars keep left on a 30ft scheme street as well as on a city arterial.
    const off = (LEFT_HAND_TRAFFIC ? -1 : 1) * laneOffsetFor(from, to);
    const t = clamp(s, 0, len);
    return out.set(from.x + ux * t + -uz * off, 0, from.z + uz * t + ux * off);
  }

  private edgeLen(l: Lane): number {
    return Math.hypot(l.to.x - l.from.x, l.to.z - l.from.z);
  }

  /**
   * Pick the next edge out of a junction, preferring to carry straight on. This is
   * geometric rather than grid-index based, so it works for the housing scheme's
   * irregular streets as well as the city grid.
   */
  private chooseNext(from: RoadNode, to: RoadNode): RoadNode {
    const options = to.nb.filter((n) => n !== from);
    if (!options.length) return from;
    const ix = to.x - from.x, iz = to.z - from.z;
    const il = Math.hypot(ix, iz) || 1;
    let straight: RoadNode | null = null, best = 0.7;   // ≈45° cone
    for (const n of options) {
      const ox = n.x - to.x, oz = n.z - to.z;
      const ol = Math.hypot(ox, oz) || 1;
      const dot = (ix * ox + iz * oz) / (il * ol);
      if (dot > best) { best = dot; straight = n; }
    }
    if (straight && this.rng() < 0.62) return straight;
    return pick(this.rng, options);
  }

  spawn(count: number): void {
    const n = this.city.nodes;
    for (let i = 0; i < count; i++) {
      const from = pick(this.rng, n);
      if (!from.nb.length) continue;
      const to = pick(this.rng, from.nb);
      const v = createVehicle(pick(this.rng, CIVILIAN), pick(this.rng, CAR_COLOURS));
      this.scene.add(v.group);
      const s = this.rng() * this.edgeLenRaw(from, to);
      this.lanePoint(from, to, s, this.tmp);
      placeVehicle(v, this.tmp.x, this.tmp.z, Math.atan2(to.x - from.x, to.z - from.z));
      v.ai = { from: 0, to: 0, t: 0, wait: 0, chase: false };
      v.netId = this.nextNetId++;
      this.lanes.set(v, { from, to, next: this.chooseNext(from, to), s, stuck: 0, cx: 0, cz: 0, ct: 0 });
      this.cars.push(v);
    }
  }

  /**
   * Grow or shrink the moving traffic to `target` cars.
   *
   * Going online calls this, because the ambient set has to be the same size for everyone
   * and the quality preset is a per-machine choice. It is capped at MAX_SYNC_CARS: a
   * shared street is worth more than the extra cars a fast machine could have drawn.
   */
  resizeLanes(target: number): void {
    const want = Math.min(target, MAX_SYNC_CARS);
    const moving = [...this.lanes.keys()].filter((v) => !v.isPlayer);
    if (moving.length > want) {
      for (const v of moving.slice(want)) this.remove(v);
    } else if (moving.length < want) {
      this.spawn(want - moving.length);
    }
  }

  private edgeLenRaw(a: RoadNode, b: RoadNode): number {
    return Math.hypot(b.x - a.x, b.z - a.z);
  }

  /** Parked, unlocked cars scattered in driveways and car parks. */
  spawnParked(count: number): Vehicle[] {
    const out: Vehicle[] = [];
    const spots = this.city.parkSpots.slice();
    for (let i = 0; i < count && spots.length; i++) {
      const idx = Math.floor(this.parkRng() * spots.length);
      const spot = spots.splice(idx, 1)[0];
      const v = createVehicle(pick(this.parkRng, CIVILIAN), pick(this.parkRng, CAR_COLOURS));
      this.scene.add(v.group);
      placeVehicle(v, spot.x, spot.z, spot.yaw);
      updateVehicleBox(v);
      this.cars.push(v);
      out.push(v);
    }
    return out;
  }

  spawnPolice(x: number, z: number, yaw: number): Vehicle {
    const v = createVehicle('police', 0x1b3f7a);
    this.scene.add(v.group);
    placeVehicle(v, x, z, yaw);
    v.siren = true;
    v.ai = { from: 0, to: 0, t: 0, wait: 0, chase: true };
    updateVehicleBox(v);
    this.cars.push(v);
    return v;
  }

  /**
   * A SWAT enforcer van: the same chase AI as a cruiser in a heavier, slower body.
   *
   * Reuses the existing `van` class rather than adding a vehicle kind, because the kind
   * is packed into four bits on the network wire and a new one would cost every client
   * a protocol bump for what is, visually, a black panel van.
   */
  spawnEnforcer(x: number, z: number, yaw: number): Vehicle {
    const v = createVehicle('van', 0x14171c);
    this.scene.add(v.group);
    placeVehicle(v, x, z, yaw);
    v.siren = true;
    v.ai = { from: 0, to: 0, t: 0, wait: 0, chase: true };
    updateVehicleBox(v);
    this.cars.push(v);
    return v;
  }

  /** Hand a traffic car over to the player. */
  release(v: Vehicle): void {
    this.lanes.delete(v);
    v.ai = null;
  }

  remove(v: Vehicle): void {
    this.lanes.delete(v);
    if (v.netId) this.remote.delete(v.netId);
    const i = this.cars.indexOf(v);
    if (i >= 0) this.cars.splice(i, 1);
    v.group.removeFromParent();
  }

  /* ── network ────────────────────────────────────────────────────────────── */

  /**
   * Switch between owning the ambient traffic and puppeting the host's.
   *
   * Becoming a puppet throws the local moving cars away rather than trying to match them
   * up with the host's: they are a different simulation with different ids, and any
   * reconciliation would be guesswork that looks like cars teleporting.
   */
  setPuppet(on: boolean, laneTarget = MAX_SYNC_CARS): void {
    if (on === this.puppet) return;
    this.puppet = on;
    if (on) {
      for (const v of [...this.lanes.keys()]) if (!v.isPlayer) this.remove(v);
      this.lanes.clear();
    } else {
      for (const v of [...this.remote.values()]) if (!v.isPlayer) this.remove(v);
      this.remote.clear();
      this.claimed.clear();
      this.spawn(laneTarget);
    }
  }

  get isPuppet(): boolean {
    return this.puppet;
  }

  /** The moving cars the host broadcasts. Player-driven and claimed cars are left out. */
  netCars(): CarState[] {
    const out: CarState[] = [];
    for (const v of this.lanes.keys()) {
      if (v.isPlayer || this.claimed.has(v.netId)) continue;
      out.push({
        id: v.netId,
        kind: Math.max(0, VEH_KINDS.indexOf(v.kind)),
        colour: colourIndex(v),
        x: v.x, y: v.y, z: v.z, yaw: v.yaw,
        flags: (v.siren ? TF_SIREN : 0) | (v.ctrl.brake > 0.05 ? TF_BRAKE : 0),
      });
      if (out.length >= MAX_SYNC_CARS) break;
    }
    return out;
  }

  /** Reconcile our puppet cars against one interpolated frame from the host. */
  applyNetwork(cars: CarState[], dt: number): void {
    if (!this.puppet) return;
    const seen = new Set<number>();
    for (const c of cars) {
      if (this.claimed.has(c.id)) continue;
      seen.add(c.id);
      let v = this.remote.get(c.id);
      if (!v) {
        v = createVehicle(VEH_KINDS[c.kind] as VehKind, CAR_COLOURS[c.colour % CAR_COLOURS.length]);
        v.netId = c.id;
        placeVehicle(v, c.x, c.z, c.yaw);
        v.y = c.y;
        this.scene.add(v.group);
        this.remote.set(c.id, v);
        this.cars.push(v);
      }
      if (v.isPlayer) continue;                       // we took the wheel; we drive it now
      v.siren = (c.flags & TF_SIREN) !== 0;
      poseNetVehicle(v, c.x, c.y, c.z, c.yaw, dt);
    }
    // Anything the host stopped sending has been recycled or claimed — drop it.
    for (const [id, v] of [...this.remote]) {
      if (!seen.has(id) && !v.isPlayer) this.remove(v);
    }
  }

  /**
   * Mark a car as driven by a player. On the host that stops it being simulated and sent;
   * on a puppet it stops the incoming frames from dragging it out from under its driver.
   */
  setClaimed(netId: number, taken: boolean): void {
    if (!netId) return;
    if (taken) {
      this.claimed.add(netId);
      const v = this.remote.get(netId) ?? this.byNetId(netId);
      // On a puppet the claimed car is drawn from its driver's player state instead, so
      // our copy has to go or there are two of it.
      if (v && !v.isPlayer) this.remove(v);
    } else {
      this.claimed.delete(netId);
    }
  }

  private byNetId(netId: number): Vehicle | null {
    for (const v of this.cars) if (v.netId === netId) return v;
    return null;
  }

  update(
    dt: number, t: number,
    playerVeh: Vehicle | null,
    px: number, pz: number,
    chase: { x: number; z: number } | null,
  ): void {
    for (const v of this.cars) {
      updateSiren(v, t);
      updateAlarm(v, dt, t);
      if (v.isPlayer) continue;
      // A puppet's ambient cars are posed by applyNetwork; stepping them as well would
      // have physics and the network pulling the same car two ways every frame.
      if (this.puppet && this.remote.has(v.netId)) continue;

      const lane = this.lanes.get(v);
      if (v.ai?.chase && chase) {
        this.drivePursuit(v, chase.x, chase.z, dt);
      } else if (lane) {
        this.driveLane(v, lane, dt, px, pz, playerVeh);
      } else {
        // parked: brake and stay put
        v.ctrl.throttle = 0;
        v.ctrl.brake = 1;
        v.ctrl.steer = 0;
        v.ctrl.handbrake = true;
        v.ctrl.boost = false;
      }
      stepVehicle(v, dt, this.phys);
    }
  }

  private drivePursuit(v: Vehicle, tx: number, tz: number, dt: number): void {
    const dx = tx - v.x, dz = tz - v.z;
    const d = Math.hypot(dx, dz);
    // +err means the target is to the left (yaw must increase), so steer negative
    const err = wrapPi(Math.atan2(dx, dz) - v.yaw);
    v.ctrl.steer = clamp(-err * 1.9, -1, 1);
    const want = d > 22 ? 26 : d > 10 ? 15 : 4;
    const over = v.speed > want;
    v.ctrl.throttle = over ? 0 : 1;
    v.ctrl.brake = over ? clamp((v.speed - want) * 0.25, 0, 1) : 0;
    v.ctrl.handbrake = Math.abs(err) > 1.9 && v.speed > 9;
    // burn nitrous to close a gap on a straight — otherwise a hypercar is simply uncatchable
    v.ctrl.boost = d > 45 && Math.abs(err) < 0.5;
    void dt;
  }

  private driveLane(v: Vehicle, lane: Lane, dt: number, px: number, pz: number, playerVeh: Vehicle | null): void {
    const len = this.edgeLen(lane);
    // advance our position along the edge by the distance actually travelled
    const ahead = 7 + Math.abs(v.speed) * 0.55;
    let target: THREE.Vector3;
    if (lane.s + ahead <= len) {
      target = this.lanePoint(lane.from, lane.to, lane.s + ahead, this.tmp);
    } else {
      target = this.lanePoint(lane.to, lane.next, lane.s + ahead - len, this.tmp);
    }
    const dx = target.x - v.x, dz = target.z - v.z;
    const err = wrapPi(Math.atan2(dx, dz) - v.yaw);
    v.ctrl.steer = clamp(-err * 1.7, -1, 1);
    v.ctrl.boost = false;      // ordinary traffic pootles along; only pursuit uses nitrous

    // progress: project our movement onto the edge direction
    const edx = (lane.to.x - lane.from.x) / (len || 1), edz = (lane.to.z - lane.from.z) / (len || 1);
    lane.s += (v.vx * edx + v.vz * edz) * dt;
    if (lane.s >= len - 1.5) {
      lane.s -= len;
      lane.from = lane.to;
      lane.to = lane.next;
      lane.next = this.chooseNext(lane.from, lane.to);
      if (lane.s < 0) lane.s = 0;
    }

    // Progress, not speed: see the note on Lane.stuck. Counted regardless of *why* we are
    // not moving, otherwise a car that yields to a queue never registers as stuck and the
    // whole junction deadlocks.
    lane.ct += dt;
    if (lane.ct >= PROGRESS_EVERY) {
      const moved = Math.hypot(v.x - lane.cx, v.z - lane.cz);
      lane.stuck = moved < PROGRESS_MIN ? lane.stuck + lane.ct : 0;
      lane.cx = v.x; lane.cz = v.z; lane.ct = 0;
    }
    const jammed = lane.stuck >= 6;

    // speed target: slow for corners, stop for obstacles
    let want = 13.5 - Math.abs(err) * 7;
    if (!jammed) {
      if (this.blocked(v, playerVeh)) want = 0;
      // don't mow down the player standing on the kerb
      if (dist2(v.x, v.z, px, pz) < 42 && this.aheadOf(v, px, pz, 0.75)) want = 0;
    } else {
      want = Math.min(want, 4);   // nudge through the jam
    }
    want = Math.max(0, want);

    const over = v.speed > want;
    v.ctrl.throttle = over ? 0 : clamp((want - v.speed) * 0.5, 0, 1);
    v.ctrl.brake = over ? clamp((v.speed - want) * 0.4, 0, 1) : 0;
    v.ctrl.handbrake = false;

    // still wedged after twelve seconds → move it somewhere useful
    if (lane.stuck >= 12) {
      lane.stuck = 0;
      lane.ct = 0;
      this.recycle(v, lane, px, pz);
    }
  }

  private aheadOf(v: Vehicle, x: number, z: number, minDot: number): boolean {
    const dx = x - v.x, dz = z - v.z;
    const l = Math.hypot(dx, dz) || 1;
    return (dx / l) * Math.sin(v.yaw) + (dz / l) * Math.cos(v.yaw) > minDot;
  }

  private blocked(v: Vehicle, playerVeh: Vehicle | null): boolean {
    for (const o of this.cars) {
      if (o === v) continue;
      const d2 = dist2(v.x, v.z, o.x, o.z);
      if (d2 > 13 * 13) continue;
      if (this.aheadOf(v, o.x, o.z, 0.82)) return true;
    }
    if (playerVeh && playerVeh !== v) {
      if (dist2(v.x, v.z, playerVeh.x, playerVeh.z) < 13 * 13 && this.aheadOf(v, playerVeh.x, playerVeh.z, 0.82)) return true;
    }
    return false;
  }

  /**
   * Put a car back into the flow somewhere the player will actually see it: out of the
   * current view but close enough that the streets never look deserted.
   */
  /**
   * Put a wedged or far-away car back into the flow.
   *
   * The 55–190 m band keeps a car from popping into view or being respawned somewhere
   * nobody will ever see it. But the band is a *preference*, not a requirement: the world
   * grew a housing scheme to the south, and standing in it leaves the scheme nodes inside
   * 55 m and the city nodes beyond 190 m — a donut with almost nothing in it. This used to
   * fail all forty tries and return silently, leaving the car frozen in the road for the
   * rest of the session. Online that frozen car is on everyone's screen, because the host
   * broadcasts it.
   *
   * So we keep the best near-miss and use it if the band never hits. A car reappearing a
   * little closer or further than ideal is always better than a car that never moves again.
   */
  private recycle(v: Vehicle, lane: Lane, px: number, pz: number): void {
    const n = this.city.nodes;
    let bestFrom: RoadNode | null = null, bestTo: RoadNode | null = null, bestS = 0;
    let bestMiss = Infinity;

    for (let i = 0; i < 40; i++) {
      const from = pick(this.rng, n);
      if (!from.nb.length) continue;
      const to = pick(this.rng, from.nb);
      const s = this.rng() * this.edgeLenRaw(from, to);
      this.lanePoint(from, to, s, this.tmp);
      const d = Math.sqrt(dist2(this.tmp.x, this.tmp.z, px, pz));
      if (d >= 55 && d <= 190) {
        this.place(v, lane, from, to, s);
        return;
      }
      // how far outside the band this candidate is, so the fallback is the closest fit
      const miss = d < 55 ? 55 - d : d - 190;
      if (miss < bestMiss) {
        bestMiss = miss;
        bestFrom = from; bestTo = to; bestS = s;
      }
    }
    if (bestFrom && bestTo) this.place(v, lane, bestFrom, bestTo, bestS);
  }

  private place(v: Vehicle, lane: Lane, from: RoadNode, to: RoadNode, s: number): void {
    this.lanePoint(from, to, s, this.tmp);
    lane.from = from; lane.to = to; lane.next = this.chooseNext(from, to); lane.s = s;
    placeVehicle(v, this.tmp.x, this.tmp.z, Math.atan2(to.x - from.x, to.z - from.z));
    lane.stuck = 0; lane.ct = 0; lane.cx = this.tmp.x; lane.cz = this.tmp.z;
    v.health = 100;
  }

  /**
   * Traffic streaming: pull far-away cars back towards the player.
   *
   * A puppet must never do this — the cars belong to the host, and recycling them locally
   * would teleport a car that everyone else can see driving perfectly normally.
   */
  streamTo(px: number, pz: number, keepWithin = 230): void {
    if (this.puppet) return;
    for (const [v, lane] of this.lanes) {
      if (v.isPlayer) continue;
      if (dist2(v.x, v.z, px, pz) <= keepWithin * keepWithin) continue;
      this.recycle(v, lane, px, pz);
    }
  }

  nearest(x: number, z: number, maxDist: number, skip?: Vehicle): Vehicle | null {
    let best: Vehicle | null = null, bd = maxDist * maxDist;
    for (const v of this.cars) {
      if (v === skip) continue;
      const d = dist2(v.x, v.z, x, z);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  dispose(): void {
    for (const v of this.cars) v.group.removeFromParent();
    this.cars.length = 0;
    this.lanes.clear();
    this.remote.clear();
    this.claimed.clear();
  }
}

/**
 * Recover a car's palette index for the wire. The body colour is baked into the material
 * at build time, so we compare against the palette rather than store a field nothing else
 * would ever read.
 */
function colourIndex(v: Vehicle): number {
  const i = CAR_COLOURS.indexOf(v.colour);
  return i < 0 ? 0 : i;
}

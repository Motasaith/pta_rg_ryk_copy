import * as THREE from 'three';
import { clamp, dist2, mulberry32, pick, Rng } from './mathx';
import { City } from './city';
import { Ped, PedManager } from './peds';
import { Vehicle } from './vehicle';

/**
 * Freelance work: taxi fares, vigilante busts and ambulance runs.
 *
 * All three are the same two-beat loop — *go to the pickup, then go to the drop-off
 * before the clock runs out* — so they share one state machine and one marker. That is
 * why three jobs cost one small class and a single cylinder mesh rather than three
 * mission scripts: the only things that differ are who you collect, where you take them
 * and what it pays.
 *
 * Nothing here is spawned. A fare is a pedestrian who already exists and a bust is a
 * traffic car that is already driving around; the job only borrows them.
 */

export type JobKind = 'taxi' | 'vigilante' | 'medic';
export type JobStage = 'off' | 'toPickup' | 'toDrop';

/** Which vehicle class unlocks which job. */
export function jobFor(v: Vehicle): JobKind | null {
  if (v.kind === 'rickshaw') return 'taxi';
  if (v.kind === 'police') return 'vigilante';
  if (v.kind === 'van') return 'medic';
  return null;
}

export const JOB_NAME: Record<JobKind, string> = {
  taxi: 'RICKSHAW FARES',
  vigilante: 'VIGILANTE',
  medic: 'PARAMEDIC',
};

const PAY: Record<JobKind, number> = { taxi: 130, vigilante: 320, medic: 210 };

export interface JobHud {
  kind: JobKind | null;
  stage: JobStage;
  /** seconds left on the current leg */
  timer: number;
  /** how many legs completed this shift */
  streak: number;
  /** banked this shift */
  earned: number;
  text: string;
}

export class Jobs {
  kind: JobKind | null = null;
  stage: JobStage = 'off';
  timer = 0;
  streak = 0;
  earned = 0;
  /** where the player has to get to; the engine points the waypoint at this */
  targetX = 0;
  targetZ = 0;

  /** Set when the current leg is a chase, so the target tracks a moving car. */
  private markCar: Vehicle | null = null;
  /** The pedestrian riding along, hidden while aboard. */
  private rider: Ped | null = null;
  private marker: THREE.Mesh;
  private rng: Rng = mulberry32(24680);

  /** Fired when a leg pays out: (amount, message). */
  onPayout: ((amount: number, message: string) => void) | null = null;
  onFail: ((message: string) => void) | null = null;

  constructor(private scene: THREE.Scene, private city: City, private peds: PedManager) {
    // One translucent column, moved around. A "go here" marker that is a new mesh each
    // leg is a new draw call and a new allocation for something the player sees once.
    this.marker = new THREE.Mesh(
      new THREE.CylinderGeometry(1.9, 1.9, 14, 14, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffc94a, transparent: true, opacity: 0.19, depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.marker.visible = false;
    this.marker.frustumCulled = false;
    scene.add(this.marker);
  }

  get active(): boolean {
    return this.stage !== 'off';
  }

  hud(): JobHud {
    return {
      kind: this.kind, stage: this.stage, timer: Math.max(0, this.timer),
      streak: this.streak, earned: this.earned, text: this.text(),
    };
  }

  private text(): string {
    if (!this.kind) return '';
    if (this.kind === 'taxi') {
      return this.stage === 'toPickup' ? 'Pick up the fare' : 'Drop them off';
    }
    if (this.kind === 'vigilante') {
      return this.stage === 'toPickup' ? 'Ram the suspect off the road' : 'Return to patrol';
    }
    return this.stage === 'toPickup' ? 'Collect the casualty' : 'Get them to the clinic';
  }

  /** The `job` key, pressed in a vehicle that offers work. */
  toggle(v: Vehicle | null, px: number, pz: number, cars: Vehicle[]): string {
    if (this.active) {
      const banked = this.earned;
      this.end();
      return banked > 0 ? `Shift over — Rs.${banked} earned` : 'Shift over';
    }
    if (!v) return '';
    const kind = jobFor(v);
    if (!kind) return 'This vehicle is not licensed for work';
    this.kind = kind;
    this.streak = 0;
    this.earned = 0;
    if (!this.nextLeg(px, pz, cars)) {
      this.end();
      return 'Nothing to do around here right now';
    }
    return `${JOB_NAME[kind]} — shift started`;
  }

  end(): void {
    this.releaseRider();
    this.kind = null;
    this.stage = 'off';
    this.markCar = null;
    this.timer = 0;
    this.marker.visible = false;
  }

  private releaseRider(): void {
    if (!this.rider) return;
    this.rider.h.root.visible = true;
    this.rider.state = 'walk';
    this.rider = null;
  }

  /** Choose the next pickup. Returns false when the world has nothing to offer. */
  private nextLeg(px: number, pz: number, cars: Vehicle[]): boolean {
    this.markCar = null;
    if (this.kind === 'vigilante') {
      // Any ambient car far enough away to be a chase but close enough to find.
      const opts = cars.filter((c) => !c.isPlayer && c.ai && !c.siren
        && dist2(c.x, c.z, px, pz) > 45 * 45 && dist2(c.x, c.z, px, pz) < 260 * 260);
      if (!opts.length) return false;
      this.markCar = pick(this.rng, opts);
      this.targetX = this.markCar.x;
      this.targetZ = this.markCar.z;
      this.timer = 75;
    } else {
      const p = this.pickPed(px, pz);
      if (!p) return false;
      this.rider = p;
      this.targetX = p.x;
      this.targetZ = p.z;
      this.timer = this.kind === 'medic' ? 70 : 60;
    }
    this.stage = 'toPickup';
    this.showMarker();
    return true;
  }

  /**
   * Somebody to collect: ideally a proper drive away, but never nobody.
   *
   * The preferred band is 40-220m. If the crowd happens to be all on top of you or all
   * across the map, it falls back to whoever is furthest inside a much wider band rather
   * than refusing the shift, because "no work available" with a city full of people in
   * it reads as a bug.
   */
  private pickPed(px: number, pz: number): Ped | null {
    let best: Ped | null = null;
    let bestD = 0;
    let fallback: Ped | null = null;
    let fallbackD = Infinity;
    for (const p of this.peds.peds) {
      if (p.cop || p.state === 'dead') continue;
      const d = dist2(p.x, p.z, px, pz);
      if (d > 40 * 40 && d < 220 * 220) {
        if (d > bestD) { bestD = d; best = p; }
      } else if (d > 15 * 15 && d < fallbackD) {
        fallbackD = d;
        fallback = p;
      }
    }
    return best ?? fallback;
  }

  private showMarker(): void {
    this.marker.position.set(this.targetX, 6.5, this.targetZ);
    this.marker.visible = true;
  }

  /**
   * One distance test and a clock. Called every frame from the engine's update, and it
   * does nothing at all when no shift is running.
   */
  update(dt: number, v: Vehicle | null, px: number, pz: number, cars: Vehicle[]): void {
    if (!this.active) return;

    // Getting out of the working vehicle ends the shift, the way it does in GTA.
    if (!v || jobFor(v) !== this.kind) {
      const banked = this.earned;
      this.onFail?.(banked > 0 ? `Shift abandoned — Rs.${banked} kept` : 'Shift abandoned');
      this.end();
      return;
    }

    this.timer -= dt;
    if (this.timer <= 0) {
      this.onFail?.(this.kind === 'vigilante' ? 'The suspect got away' : 'Too slow — they got out');
      this.end();
      return;
    }

    if (this.markCar) {
      // a chase target moves, so the marker follows it
      if (this.markCar.health <= 0 || !cars.includes(this.markCar)) {
        this.payout(px, pz, cars, 1.35);
        return;
      }
      this.targetX = this.markCar.x;
      this.targetZ = this.markCar.z;
      this.marker.position.set(this.targetX, 6.5, this.targetZ);
      // a hard enough shunt counts as the bust
      if (dist2(this.markCar.x, this.markCar.z, px, pz) < 36 && this.markCar.crashT > 0.1) {
        this.markCar.health = Math.min(this.markCar.health, 1);
        this.payout(px, pz, cars, 1);
      }
      return;
    }

    const reached = dist2(this.targetX, this.targetZ, px, pz) < 6.5 * 6.5;
    if (!reached) return;

    if (this.stage === 'toPickup') {
      // Aboard: the passenger is hidden rather than parented to the car, because a rider
      // who has to be posed in a seat is a whole animation problem for a dot on the HUD.
      if (this.rider) {
        this.rider.h.root.visible = false;
        this.rider.state = 'idle';
        this.rider.idleT = 999;
      }
      const drop = pick(this.rng, this.dropCandidates());
      this.targetX = drop.x;
      this.targetZ = drop.z;
      this.timer = this.kind === 'medic' ? 80 : 70;
      this.stage = 'toDrop';
      this.showMarker();
    } else {
      this.payout(px, pz, cars, 1);
    }
  }

  private dropCandidates(): { x: number; z: number }[] {
    if (this.kind === 'medic') return [this.city.hospital];
    const pois = this.city.pois.filter((p) => p.kind !== 'shop' && p.kind !== 'home');
    return pois.length ? pois : [this.city.hospital];
  }

  private payout(px: number, pz: number, cars: Vehicle[], bonus: number): void {
    // The tip is what is left on the clock: hurrying is worth something, and a shift that
    // keeps going is worth more per leg than a one-off.
    const tip = Math.round(this.timer * 4);
    const streakBonus = 1 + Math.min(this.streak, 8) * 0.15;
    const amount = Math.round((PAY[this.kind!] + tip) * streakBonus * bonus);
    this.streak++;
    this.earned += amount;
    this.releaseRider();
    this.onPayout?.(amount, `${this.kind === 'vigilante' ? 'Suspect down' : 'Delivered'} — Rs.${amount}`
      + (this.streak > 1 ? ` (x${this.streak})` : ''));
    if (!this.nextLeg(px, pz, cars)) {
      this.onFail?.('No more work nearby — shift over');
      this.end();
    }
  }

  dispose(): void {
    this.end();
    this.scene.remove(this.marker);
    this.marker.geometry.dispose();
    (this.marker.material as THREE.Material).dispose();
  }
}

export const jobsClamp = clamp;

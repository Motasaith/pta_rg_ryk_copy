import * as THREE from 'three';
import { angleDamp, clamp, damp, dist2, fwdX, fwdZ, mulberry32, pick, rgtX, rgtZ, Rng, wrapPi } from './mathx';
import { KIND, Physics } from './physics';
import { buildMaterials, glowTexture, initTextures, Mats, updateFoliage } from './materials';
import { AssetBank } from './assets';
import { updateWater } from './water';
import { Sky } from './sky';
import { City, LOT_Y, Poi, Shop } from './city';
import { DEFAULT_MAP_ID, GameMap, mapAt, mapById, mapIndex } from './maps';
import { Weather } from './weather';
import { Crime, CRIME, escalate, riseTowards } from './wanted';
import {
  atDoor, buildInterior, nearestStand, type Interior, type InteriorKind, type Stand,
} from './interior';
import {
  CLIMB_OUT, doorPoint, driverSide, enterPose, enterTime, EXIT_TIME, exitPose, stepTime,
  type MovePose, type Spot,
} from './carentry';
import { PoliceOps } from './police';
import { JOB_NAME, jobFor, Jobs } from './jobs';
import {
  createHumanoid, disposeHumanoid, Humanoid, poseHumanoid, seatMetrics, setHumanoidDetail, SKINS,
  type SeatMetrics,
} from './humanoid';
import { Ped, PedManager } from './peds';
import { initCharacters } from './characters';
import { Traffic } from './traffic';
import { Combat } from './combat';
import { CameraRig } from './camerarig';
import { GameAudio } from './audio';
import { MapEnt, MapRenderer } from './minimap';
import { getHud, setHud } from './hudstore';
import { keyLabel, QUALITY, QualityPreset, Settings } from './settings';
import { Input } from './input';
import { fetchOpenRooms, KillEvent, NetClient } from './netclient';
import { packFlags, RemotePlayers } from './remoteplayers';
import {
  HIT_HEAD, HIT_MELEE, HIT_VEHICLE, Hit as NetHit, MATCH_LIVE, MATCH_OVER, MatchState, MAX_SYNC_CARS,
  MODE_TDM, PROTOCOL_VERSION, TEAM_A, TEAM_B, TEAM_NONE, VEH_KINDS, makeRoomCode, normaliseRoomCode,
} from './protocol';
import { createWeaponModel, WeaponId, WeaponModel, WEAPON_ORDER, WEAPONS, WeaponSpec } from './weapons';
import {
  CAR_COLOURS, createVehicle, initVehicleModels, paintVehicle, placeVehicle, seatWorld,
  setSurfaceGrip, stepVehicle, updateAlarm, updateVehicleBox, Vehicle, VehKind, vehicleSpeedKmh,
} from './vehicle';

/** Where the hips sit in the seated pose, and how far the top of the head is above them. */
/**
 * Where to put a seated character's root inside a car body.
 *
 * This used to be a hand-tuned drop per vehicle class, and it did not survive contact with
 * the low cars: a hypercar roof is 1.14m and the table put the top of the head at 1.30m,
 * so the driver's head was outside the car. Derived instead — sit the hips on the seat,
 * then, if the head would still clip the roof, sink the whole body until it does not.
 *
 * The second thing it did not survive was having two rigs. The numbers were the capsule
 * fallback's, and the mannequin that actually ships folds up 37cm more compactly when it
 * sits, so every driver was planted a foot below their own seat with their legs through
 * the floor pan. `seatMetrics` asks the character instead of assuming.
 */
function seatHeight(v: Vehicle, m: SeatMetrics): number {
  let y = v.spec.seat[1] - m.hip;
  const roof = v.spec.height - 0.1;
  if (y + m.head > roof) y -= y + m.head - roof;
  return y;
}

/** Seconds under water before the canal has finished with you. */
const DROWN_SECONDS = 4.2;

/** Click again inside this many seconds and the strike chains instead of restarting. */
const COMBO_WINDOW = 0.75;

const WALK_SPEED = 2.3;
const CROUCH_SPEED = 1.35;
const RUN_SPEED = 6.1;
const AIM_SPEED = 1.5;
const PLAYER_R = 0.34;
const PLAYER_H = 1.78;
const STEP_UP = 0.45;
const GRAVITY = 17;
/**
 * The shirts in the wardrobe at home. Gold first, because that is what the hero starts in
 * and the one thing on screen you should never lose track of.
 */
const OUTFITS = [0xf2c14e, 0xe8e4d8, 0x9fb0bb, 0xc9bda6, 0x8fa3a8, 0xb3564e, 0x7f9a72];

/** Darken a packed colour: trousers sit a shade under the shirt. */
function shade(hex: number, k: number): number {
  return (Math.round(((hex >> 16) & 255) * k) << 16)
    | (Math.round(((hex >> 8) & 255) * k) << 8)
    | Math.round((hex & 255) * k);
}
/** RANGBIRANGI. Loud on purpose — a repaint you cannot see is not a cheat. */
const CHEAT_PAINT = [
  0xff2f6d, 0x00d6c2, 0xffd21e, 0x7a3cff, 0x21e05a,
  0xff7a18, 0x00a5ff, 0xff4de0, 0xc8ff2b, 0xff1f1f,
];
const JUMP_V = 5.6;

interface MissionItem {
  name: string;
  x: number;
  y: number;
  z: number;
  group: THREE.Group;
  found: boolean;
  anim: number;
}

interface Pickup {
  kind: 'cash' | 'ammo' | 'health' | 'armour';
  x: number;
  z: number;
  value: number;
  group: THREE.Group;
  taken: boolean;
  respawn: number;
}

/**
 * What the Pay 'n' Spray has in stock.
 *
 * All deep, saturated colours, and that is not a style choice. A downloaded car body is
 * one baked texture atlas, so a respray *multiplies* it — which can darken a panel but
 * can never lighten one. A white or pastel in this list would read as "nothing happened"
 * on any car that was not already white.
 */
const SPRAY_COLOURS = [
  { name: 'Midnight Purple', hex: 0x3a2166 },
  { name: 'Racing Red', hex: 0xb0231d },
  { name: 'Matte Black', hex: 0x24262b },
  { name: 'Gold', hex: 0xc19426 },
  { name: 'Cobalt Blue', hex: 0x1c4c8a },
  { name: 'Forest Green', hex: 0x1f5c34 },
];

const ITEM_NAMES = [
  'Teddy Bear', 'Cricket Ball', 'House Keys', 'Story Book',
  'Lucky Sock', 'Toy Car', 'Nani\'s Glasses', 'Rubber Duck',
];

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private phys = new Physics();
  private mats!: Mats;
  private sky!: Sky;
  private city!: City;
  private peds!: PedManager;
  private traffic!: Traffic;
  private combat!: Combat;
  private rig = new CameraRig();
  private audio = new GameAudio();
  private mapR!: MapRenderer;
  private input: Input;
  private rng: Rng = mulberry32(4711);
  private preset: QualityPreset;

  // player state
  private hero!: Humanoid;
  private px = 0;
  private py = 0;
  private pz = 0;
  private pyaw = 0;
  private vx = 0;
  private vz = 0;
  private vy = 0;
  private grounded = true;
  private crouching = false;
  private health = 100;
  private armour = 0;
  private money = 500;
  private speed = 0;
  private dead = false;
  private deadT = 0;
  private punchT = 0;
  /** Which hand throws the next strike, and whether it is a blade arc. */
  private punchSide = 1;
  private punchSlash = false;
  /** Where we are in a three-hit combo, and when the last strike landed. */
  private combo = 0;
  private lastMeleeT = -99;
  private flinch = 0;
  private footPhase = 0;

  // weapons
  private weapon: WeaponId = 'fists';
  private models: Partial<Record<WeaponId, WeaponModel>> = {};
  private mag: Record<WeaponId, number> = {
    fists: 0, knife: 0, sword: 0,
    pistol: 15, smg: 30, ak47: 30, shotgun: 8, sniper: 5, rpg: 1, minigun: 100,
  };
  private reserve: Record<WeaponId, number> = {
    fists: 0, knife: 0, sword: 0,
    pistol: 75, smg: 120, ak47: 120, shotgun: 32, sniper: 20, rpg: 5, minigun: 200,
  };
  private owned: Record<WeaponId, boolean> = {
    fists: true, knife: true, sword: true,
    pistol: true, smg: true, ak47: true, shotgun: true, sniper: true, rpg: true, minigun: true,
  };
  private fireCd = 0;
  private reloadT = 0;
  private aiming = false;
  private hitMarker = 0;
  private lastShotT = -99;

  // heat
  /**
   * Getting in or out of a car, mid-move.
   *
   * The car is claimed the moment this starts — off the traffic AI, and off the room if
   * we are online — so nobody drives away with it while the door is still opening. The
   * seating itself waits until the move finishes.
   */
  private carMove: {
    v: Vehicle;
    out: boolean;
    t: number;
    side: number;
    from: MovePose;
    spot: Spot;
    /** How long the walk to the door gets; scaled to how far away it is. */
    stepT: number;
  } | null = null;
  /**
   * The room the player is stood in, and the pavement they left to get there.
   *
   * While this is set the player is six kilometres from the city, so every world system
   * that streams to the player's position — traffic, the crowd, the police, drowning —
   * is skipped rather than pointed at a phantom. The minimap and the wanted level are
   * fed the outside position instead, which is what makes hiding in a shop cool you off.
   */
  private interior: {
    it: Interior;
    outX: number;
    outZ: number;
    outYaw: number;
    name: string;
    /** stops the doorway you just walked in through from throwing you straight back out */
    grace: number;
  } | null = null;
  private interiors = new Map<InteriorKind, Interior>();
  private outfitIdx = 0;
  /** Door transition: counts down, and the swap happens at the halfway point. */
  private fadeT = 0;
  private fadeDur = 0;
  private fadeGo: (() => void) | null = null;
  private wanted = 0;
  /**
   * Where the meter is heading. Crimes move this; `wanted` climbs towards it at
   * RISE_RATE in updateHeat. Never assign `wanted` on its own — use setWanted, or the
   * displayed level and the police response drift apart.
   */
  private wantedTarget = 0;
  private wantedCool = 0;
  /** Rate limit on gunfire heat, so an automatic weapon is not thirty crimes a second. */
  private gunHeatT = 0;
  private copTimer = 0;
  private bustedT = 0;

  // world objects
  private vehicle: Vehicle | null = null;
  private items: MissionItem[] = [];
  private pickups: Pickup[] = [];
  private found = 0;
  private waypoint: { x: number; z: number } | null = null;
  private prompt = '';
  private promptAction: (() => void) | null = null;
  private toastT = 0;
  private alarmChirpT = 0;
  private cheatMsgT = 0;
  /** UNLIMITEDHEALTH: damage is ignored entirely. */
  private invincible = false;
  private speedFreak = false;
  /** BULLETTIME. Scales the whole simulation, so physics, animation and AI all slow. */
  private timeScale = 1;
  private lowGrav = false;
  private infiniteAmmo = false;
  private ironFist = false;
  private carArmour = false;
  /** Console open? While it is, every gameplay bind is dead and the mouse is free. */
  private consoleOpen = false;
  /** How long we have been under water, in seconds. */
  private drownT = 0;
  /** WALKONWATER: the canal stops being lethal. */
  private waterproof = false;
  /** Rain, dust, wet tarmac and thunder. */
  private weather!: Weather;
  /** Roadblocks, spike strips and the search helicopter. */
  private ops!: PoliceOps;
  /** Taxi, vigilante and paramedic shifts. */
  private jobs!: Jobs;
  /** Cooldown so bumping a crowd does not produce a wall of shouting. */
  private aggroCd = 0;
  /** Cooldown on the Pay 'n' Spray, so one pass through the bay is one respray. */
  private sprayCd = 0;
  /** Round-robin pool of dropped cash bundles. */
  private drops: Pickup[] = [];
  private dropNext = 0;
  /** The map currently built. Exactly one world exists at a time. */
  private map: GameMap = mapById(DEFAULT_MAP_ID);
  private worldBuilt = false;
  /** Clock hour the chosen map opens on; the day/night cycle counts up from it. */
  private startHour = 9.5;

  // loop
  private raf = 0;
  private clock = new THREE.Clock();
  private elapsed = 0;
  private startT = 0;
  private paused = true;
  private running = false;
  private mapOpen = false;
  private frameTimes: number[] = [];
  private resScale: number;
  private resTimer = 0;
  private hudTimer = 0;
  private radarTimer = 0;
  private streamTimer = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private camDir = new THREE.Vector3();
  private ents: MapEnt[] = [];

  radarCanvas: HTMLCanvasElement | null = null;
  mapCanvas: HTMLCanvasElement | null = null;

  /* ── multiplayer ─────────────────────────────────────────────────────────
     The net client is created up front but stays offline until the player joins
     a room, so single-player costs nothing at all. */
  readonly net = new NetClient();
  private remotes!: RemotePlayers;
  /**
   * Who shot us most recently, and when. A kill is credited to whoever landed a hit in the
   * last few seconds — long enough that finishing someone with a car after shooting them
   * still counts, short enough that a bullet from two streets ago does not.
   */
  private lastAttacker = 0;
  private lastAttackerT = -99;
  /** Ambient car we are currently driving, so we can hand it back when we get out. */
  private claimedCar = 0;
  /** Downloaded CC0 assets (textures, HDRI, models, audio); empty when offline. */
  private bank = new AssetBank();
  /** Every city material, so the day/night cycle can dim the HDRI ambient light. */
  private envMats: THREE.MeshStandardMaterial[] = [];

  constructor(private canvas: HTMLCanvasElement, private settings: Settings) {
    this.preset = QUALITY[settings.quality];
    this.resScale = this.preset.pixelRatio;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.preset.antialias,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.resScale));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = this.preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.15, this.preset.drawDistance + 400);
    this.input = new Input(canvas, settings.binds);
  }

  /* ── boot ──────────────────────────────────────────────────────────────── */

  async init(): Promise<void> {
    const step = async (pct: number, msg: string) => {
      setHud({ loadPct: pct, loadMsg: msg });
      await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    };

    await step(2, 'unloading the trucks…');
    await this.bank.preload(
      (frac) => setHud({ loadPct: 2 + Math.round(frac * 4), loadMsg: 'unpacking real materials…' }),
      Math.min(8, this.renderer.capabilities.getMaxAnisotropy()),
    );

    await step(8, 'mixing paint and concrete…');
    initTextures(this.renderer);
    this.mats = buildMaterials(this.bank);
    initVehicleModels(this.bank);
    initCharacters(this.bank);
    this.envMats = [this.mats.asphalt, this.mats.concrete, this.mats.grass, this.mats.dirt,
      this.mats.brick, this.mats.roof, this.mats.metal, this.mats.wood, this.mats.curb,
      ...this.mats.plaster, ...this.mats.facade];

    await step(18, 'raising the sky…');
    this.sky = new Sky(this.scene, this.preset.clouds, this.preset.shadowSize, this.preset.shadows);
    this.sky.setHour(this.settings.dayNight ? 9.5 : 12);
    this.scene.fog = new THREE.Fog(this.sky.fogColor().getHex(), this.preset.drawDistance * 0.45, this.preset.drawDistance);
    // Real HDRI ambient + reflections, dimmed through the day so nights stay dark.
    const env = this.bank.environment(this.renderer);
    if (env) {
      this.scene.environment = env;
      this.setEnvIntensity(this.sky.hour);
    }

    await step(60, 'loading the guns…');
    this.remotes = new RemotePlayers(this.scene);
    this.net.onChange = () => this.onNetChange();
    // We own our own health, so damage arrives as a request and is applied here.
    this.net.onHit = (h) => this.takeNetHit(h);
    this.net.onKill = (e, killer, victim) => this.onNetKill(e, killer, victim);
    this.net.onMatch = (m, prev) => this.onMatchChange(m, prev);
    this.net.onClaim = (car, taken) => this.traffic.setClaimed(car, taken);
    this.combat = new Combat(this.scene, this.phys);
    this.combat.bloodEnabled = this.settings.blood;
    this.combat.onExplosion = (ex, ey, ez, damage, radius) => this.onExplosion(ex, ey, ez, damage, radius);
    this.setWeapon('fists', true);

    // No world yet: the map the player picks on the title screen is built by start(),
    // so only the one they chose ever occupies memory.
    await step(100, 'ready');
    // Put the asset tally on the title screen. It is the first thing to check when two
    // players say the game "looks different": a client whose downloads failed falls back
    // to the procedural textures silently, and otherwise nobody can tell.
    const assets = this.bank.report();
    setHud({
      loadMsg: assets.text, assetsOk: assets.ok, netVersion: PROTOCOL_VERSION,
      phase: 'title', money: this.money, health: 100,
    });

    this.input.attach();
    this.input.onLockChange = (locked) => {
      // Esc releases the pointer: treat that as "pause" so the player never loses control.
      // The cheat console and the shop release the pointer on purpose — only an
      // unexplained loss (Esc, alt-tab) means the player wants out.
      if (!locked && this.running && !this.paused && !this.consoleOpen
        && !getHud().shopOpen && getHud().phase === 'playing') this.setPaused(true);
    };
    addEventListener('resize', this.onResize);
  }

  /**
   * The HDRI is a fixed midday capture, so it must fade with the sun or nights
   * would glow. Scaled to near-black at midnight, full strength at noon.
   */
  private setEnvIntensity(hour: number): void {
    const el = Math.sin(((hour - 6) / 12) * Math.PI);            // sun elevation proxy
    const day = clamp((el + 0.12) * 3.2, 0, 1);                  // mirrors sky.night
    const i = 0.06 + day * 0.94;
    for (const m of this.envMats) m.envMapIntensity = i;
  }

  private spawnPlayer(): void {
    this.hero = createHumanoid({
      // gold shirt — the one thing on screen you should never lose track of
      skin: SKINS[1], shirt: 0xf2c14e, pants: 0x2f4a6d, hair: 0x1d130c, shoes: 0xb3352a, scale: 1,
    });
    this.scene.add(this.hero.root);
    // Re-run the equip now that there is a hero: setWeapon ran during init, before this.
    this.setWeapon(this.weapon, true);
    const s = this.city.playerStart;
    this.px = s.x;
    this.pz = s.z;
    this.pyaw = s.yaw;
    this.py = this.phys.groundHeight(this.px, this.pz, PLAYER_R, 2);
    this.rig.reset(s.yaw, this.px, this.py, this.pz);
  }

  private spawnItems(): void {
    const spots = this.city.itemSpots.slice();
    // Spread the eight objectives out, relaxing the spacing rule until we have all eight
    // (and never picking the same spot twice).
    spots.sort(() => this.rng() - 0.5);
    const chosen: typeof spots = [];
    const used = new Set<(typeof spots)[number]>();
    for (const minDist of [70, 46, 24, 0]) {
      for (const s of spots) {
        if (chosen.length >= 8) break;
        if (used.has(s)) continue;
        if (chosen.some((c) => dist2(c.x, c.z, s.x, s.z) < minDist * minDist)) continue;
        chosen.push(s);
        used.add(s);
      }
    }

    for (let i = 0; i < chosen.length; i++) {
      const s = chosen[i];
      const g = new THREE.Group();
      g.position.set(s.x, s.y + 0.45, s.z);
      const colour = [0x8a5a33, 0xd94f3d, 0xd8b64c, 0x3f6fb5, 0xf2f0ea, 0xf7c948, 0x2b313a, 0xf7c948][i];
      const shape = new THREE.Mesh(
        i === 1 || i === 7 ? new THREE.SphereGeometry(0.16, 12, 9)
          : i === 2 || i === 6 ? new THREE.TorusGeometry(0.12, 0.035, 8, 14)
            : new THREE.BoxGeometry(0.26, 0.18, 0.3),
        new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6 }),
      );
      shape.castShadow = true;
      g.add(shape);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: 0xffd166, transparent: true, opacity: 0.55,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      halo.scale.setScalar(1.5);
      g.add(halo);
      // a tall thin beacon so objectives read from across a block
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.16, 7, 6, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide }),
      );
      beam.position.y = 3.4;
      g.add(beam);
      this.scene.add(g);
      this.items.push({ name: ITEM_NAMES[i], x: s.x, y: s.y + 0.45, z: s.z, group: g, found: false, anim: 0 });
    }
    this.pickWaypoint();
  }

  private spawnPickups(): void {
    const spots = this.city.pickupSpots.slice().sort(() => this.rng() - 0.5).slice(0, 34);
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      const kind: Pickup['kind'] = i % 7 === 0 ? 'armour' : i % 5 === 0 ? 'health' : i % 3 === 0 ? 'ammo' : 'cash';
      const g = new THREE.Group();
      g.position.set(s.x, LOT_Y + 0.3, s.z);
      const colour = kind === 'cash' ? 0x4e8a5a : kind === 'ammo' ? 0x6b5a2a : kind === 'armour' ? 0x2f6f9c : 0xc0392b;
      const m = new THREE.Mesh(
        kind === 'cash' ? new THREE.BoxGeometry(0.3, 0.06, 0.16) : new THREE.BoxGeometry(0.34, 0.24, 0.24),
        new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6 }),
      );
      m.castShadow = true;
      g.add(m);
      if (kind === 'health') {
        const cross = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.06), new THREE.MeshStandardMaterial({ color: 0xffffff }));
        cross.position.y = 0.13;
        g.add(cross);
        const cross2 = cross.clone();
        cross2.rotation.y = Math.PI / 2;
        g.add(cross2);
      }
      if (kind === 'armour') {
        const strap = new THREE.Mesh(
          new THREE.BoxGeometry(0.38, 0.1, 0.28),
          new THREE.MeshStandardMaterial({ color: 0x1c4a6b, roughness: 0.5 }),
        );
        strap.position.y = 0.16;
        g.add(strap);
      }
      this.scene.add(g);
      this.pickups.push({
        kind, x: s.x, z: s.z, group: g, taken: false, respawn: 0,
        value: kind === 'cash' ? 60 + Math.floor(this.rng() * 5) * 40 : kind === 'ammo' ? 24 : kind === 'armour' ? 50 : 30,
      });
    }
  }

  /**
   * A small pool of dropped cash bundles.
   *
   * Built once so that a defeated pedestrian never allocates anything: a drop is the
   * next slot in a ring being moved and made visible. Ten is plenty — by the time the
   * eleventh body hits the floor the first bundle has been walked over or lapped.
   */
  private spawnDrops(): void {
    for (let i = 0; i < 10; i++) {
      const g = new THREE.Group();
      const notes = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.09, 0.17),
        new THREE.MeshStandardMaterial({ color: 0x3f8a4e, roughness: 0.7 }),
      );
      notes.castShadow = true;
      g.add(notes);
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.1, 0.19),
        new THREE.MeshStandardMaterial({ color: 0xd8c86a, roughness: 0.6 }),
      );
      g.add(band);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: 0x6cff9a, transparent: true, opacity: 0.6,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      halo.scale.setScalar(1.1);
      g.add(halo);
      g.visible = false;
      this.scene.add(g);
      const p: Pickup = { kind: 'cash', x: 0, z: 0, group: g, taken: true, respawn: 0, value: 0 };
      this.drops.push(p);
      this.pickups.push(p);
    }
  }

  /** Put a bundle on the ground where someone fell. */
  private dropCash(x: number, y: number, z: number, value: number): void {
    const p = this.drops[this.dropNext % this.drops.length];
    this.dropNext++;
    p.taken = false;
    p.x = x;
    p.z = z;
    p.value = value;
    p.respawn = 0;
    p.group.position.set(x, y + 0.28, z);
    p.group.visible = true;
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  /**
   * Build the chosen map, then play.
   *
   * The world is generated here rather than during init() so that picking a map on the
   * title screen means only that map exists: one set of meshes, one collider grid, one
   * crowd, one traffic fleet. Calling start() again is a no-op once a world is up —
   * switching maps is a page reload, which is also how the restart button works.
   */
  async start(mapId = DEFAULT_MAP_ID): Promise<void> {
    if (this.running) return;
    // In a room, the map is the room's — the picker on the title screen only decides what
    // we *ask* for, and only the first player through the door gets their way.
    const want = this.net.status === 'online' ? mapAt(this.net.roomMap).id : mapId;
    if (!this.worldBuilt) await this.buildWorld(want);
    if (!this.traffic || !this.hero) return;
    this.running = true;
    this.paused = false;
    this.startT = performance.now();
    this.clock.start();
    this.audio.init();
    this.audio.setVolumes(this.settings.master, this.settings.sfx, this.settings.music);
    setHud({ phase: 'playing' });
    this.input.enabled = true;
    this.input.requestLock();
    this.loop();
  }

  private async buildWorld(mapId: string): Promise<void> {
    const step = async (pct: number, msg: string) => {
      setHud({ phase: 'loading', loadPct: pct, loadMsg: msg });
      await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    };
    this.map = mapById(mapId);
    this.worldBuilt = true;

    await step(8, `surveying ${this.map.name}…`);
    this.city = this.map.build(this.scene, this.phys, this.mats, this.preset);
    this.mapR = new MapRenderer(this.city);
    this.startHour = this.map.hour;
    this.sky.setHour(this.settings.dayNight ? this.map.hour : 12);
    this.setEnvIntensity(this.sky.hour);

    await step(42, 'moving the neighbours in…');
    this.peds = new PedManager(this.scene, this.phys, this.city);
    this.peds.populate(this.preset.peds);

    await step(62, 'starting the traffic…');
    this.traffic = new Traffic(this.scene, this.city, this.phys);
    this.traffic.spawn(this.preset.traffic);
    this.traffic.spawnParked(Math.round(this.preset.traffic * 0.9));
    // seed the crowd and the traffic around where the player will actually start
    this.peds.streamTo(this.city.playerStart.x, this.city.playerStart.z, 95);
    this.traffic.streamTo(this.city.playerStart.x, this.city.playerStart.z, 170);
    if (this.net.status !== 'offline') this.traffic.resizeLanes(MAX_SYNC_CARS);

    await step(80, "hiding Mom's things…");
    this.spawnPlayer();
    this.spawnItems();
    this.spawnPickups();
    this.spawnDrops();

    await step(88, 'checking the forecast…');
    this.weather = new Weather(this.scene, this.mats);
    this.weather.enabled = this.settings.weather;
    // Karachi at night in the rain is a mood; the desert never has any.
    if (this.map.id === 'thal') this.weather.set('dust', true);
    this.ops = new PoliceOps(this.scene, this.phys, this.city, this.mats);
    this.jobs = new Jobs(this.scene, this.city, this.peds);
    this.jobs.onPayout = (amount, msg) => {
      this.money += amount;
      this.audio.cash();
      this.toast(msg);
      setHud({ money: this.money });
    };
    this.jobs.onFail = (msg) => {
      this.audio.deny();
      this.toast(msg);
    };
    this.peds.onChatter = (p, line) => {
      this.audio.chatter(0.85 + Math.random() * 0.4);
      this.toast(`“${line}”`);
      void p;
    };
    this.peds.onSwing = (p) => {
      this.audio.punch();
      this.damagePlayer(6, p.x, p.z, true);
    };

    await step(94, 'warming up the renderer…');
    this.renderer.compile(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);

    setHud({
      loadPct: 100, total: this.items.length,
      triangles: Math.round(this.city.triangles), mapName: this.city.mapName,
    });
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    if (p) this.toggleConsole(false);
    this.paused = p;
    this.input.enabled = !p && !this.consoleOpen;
    setHud({ phase: p ? 'paused' : 'playing' });
    if (p) {
      this.audio.suspend();
      this.input.releaseLock();
    } else {
      this.audio.resume();
      if (!this.consoleOpen) this.input.requestLock();
      this.clock.getDelta();
    }
  }

  toggleMap(force?: boolean): void {
    this.mapOpen = force ?? !this.mapOpen;
    setHud({ mapOpen: this.mapOpen });
    if (this.mapOpen) this.drawMap();
  }

  applySettings(s: Settings): void {
    const qualityChanged = s.quality !== this.settings.quality;
    this.settings = s;
    this.input.binds = s.binds;
    this.preset = QUALITY[s.quality];
    this.audio.setVolumes(s.master, s.sfx, s.music);
    this.combat.bloodEnabled = s.blood;
    if (this.weather) this.weather.enabled = s.weather;
    this.renderer.shadowMap.enabled = this.preset.shadows;
    this.sky.sun.castShadow = this.preset.shadows;
    this.resScale = this.preset.pixelRatio;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.resScale));
    this.camera.far = this.preset.drawDistance + 400;
    this.camera.updateProjectionMatrix();
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = this.preset.drawDistance * 0.45;
      this.scene.fog.far = this.preset.drawDistance;
    }
    if (qualityChanged) {
      // trim or top up the crowd without rebuilding the city
      const want = this.preset.peds;
      while (this.peds.peds.length > want) {
        const p = this.peds.peds.pop();
        if (p) disposeHumanoid(p.h);
      }
      while (this.peds.peds.length < want) this.peds.spawnPed(false);
    }
    if (!s.dayNight) this.sky.setHour(12);
  }

  private onResize = () => {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight, false);
  };

  /* ── multiplayer API for the UI ─────────────────────────────────────────── */

  /**
   * Host a new room and return the code to share. Public rooms also appear in Quick Match.
   * `mode` decides whether the room starts as free-roam or as a team deathmatch lobby.
   */
  hostRoom(name: string, isPublic = false, mode: 'freeroam' | 'tdm' = 'freeroam'): string {
    const code = makeRoomCode();
    this.goOnline();
    this.net.connect(code, name, { isPublic, mode, map: mapIndex(this.map.id) });
    return code;
  }

  /**
   * Which map we intend to play. Set from the title picker *before* hosting or joining,
   * because the map has to be on the wire in the very first frame we send.
   */
  setMap(id: string): void {
    if (this.worldBuilt) return;          // too late: the city is already standing
    this.map = mapById(id);
  }

  /** The map actually in force — the room's once we are in one. */
  get mapId(): string {
    return this.map.id;
  }

  /**
   * Everyone must run the same number of ambient cars, because the host sends all of them
   * and the count cannot depend on one player's quality preset. Resizing here rather than
   * at load keeps single-player exactly as it was.
   */
  private goOnline(): void {
    // The fleet does not exist until a map is built; buildWorld() re-applies this.
    this.traffic?.resizeLanes(MAX_SYNC_CARS);
  }

  /** Returns false if the code could not possibly be a room code. */
  joinRoom(code: string, name: string): boolean {
    const clean = normaliseRoomCode(code);
    if (!clean) return false;
    this.goOnline();
    this.net.connect(clean, name, { map: mapIndex(this.map.id) });
    return true;
  }

  /** Drop into any public room with space; hosts a new public one if there are none. */
  async quickMatch(name: string): Promise<string> {
    const rooms = await fetchOpenRooms();
    const pick = rooms.find((r) => r.players < r.max);
    if (pick) {
      this.goOnline();
      this.net.connect(pick.code, name, { mode: pick.mode, map: mapIndex(this.map.id) });
      return pick.code;
    }
    return this.hostRoom(name, true);
  }

  leaveRoom(): void {
    this.net.disconnect();
  }

  /** Start a team deathmatch in the room we are in. Host only — the server enforces it. */
  startMatch(): void {
    this.net.startMatch(MODE_TDM);
  }

  /** Back to free-roam: teams cleared, scores dropped, nobody can shoot anybody. */
  endMatch(): void {
    this.net.endMatch();
  }

  /** Ask to switch sides. Refused by the server if it would make the match lopsided. */
  chooseTeam(team: number): void {
    this.net.sendTeam(team);
  }

  private onNetChange(): void {
    // The room's map is authoritative. Adopt it before the world is built; refuse the
    // room outright if it is already too late, because a player standing in a different
    // city is worse than a player who could not join.
    if (this.net.status === 'online') {
      const room = mapAt(this.net.roomMap);
      if (room.id !== this.map.id) {
        if (this.worldBuilt) {
          const mine = this.map.name;
          this.net.disconnect();
          this.toast(`That room is playing ${room.name} — restart to join (you are in ${mine})`);
          setHud({ netError: `This room plays ${room.name}. Restart the game and pick it to join.` });
          this.pushNetHud();
          return;
        }
        this.map = room;
        setHud({ mapName: room.name });
      }
    }

    // Going offline hands the ambient traffic back to us, and the world has to be whole
    // again — the online set is capped, so a solo player would otherwise be left with the
    // thinner traffic they had in the room.
    if (this.net.status !== 'online' && this.traffic?.isPuppet) {
      this.traffic.setPuppet(false, this.preset.traffic);
    }
    // Only on the way out. onChange also fires on every join, kill and team switch, and
    // releasing here unconditionally handed our car back to the host while we were still
    // driving it — which put a second copy of it on everyone else's screen.
    if (this.net.status !== 'online') this.claimedCar = 0;
    this.pushNetHud();
  }

  /**
   * Someone shot us. We apply it ourselves — nobody else can, because health lives here.
   * The shooter is remembered so that if this is the blow that kills us, the kill is
   * credited to them rather than to the pavement.
   */
  private takeNetHit(h: NetHit): void {
    if (this.dead || !this.net.pvp) return;
    const st = this.remotes.stateOf(h.shooter);
    this.damagePlayer(h.damage, st ? st.x : this.px, st ? st.z : this.pz, true, h.shooter);
    if ((h.flags & HIT_MELEE) === 0) this.audio.bodyHit();
  }

  private onNetKill(e: KillEvent, killer: number, victim: number): void {
    if (victim === this.net.myId) return;                 // our own death already toasted
    if (killer === this.net.myId) {
      this.hitMarker = 0.35;
      this.audio.hitMarker();
      this.toast(`You killed ${e.victim}`);
    }
    this.pushNetHud();
  }

  private onMatchChange(m: MatchState, prev: MatchState): void {
    if (m.state === MATCH_LIVE && prev.state !== MATCH_LIVE) {
      // A match starts everyone fresh, wherever they happened to be standing.
      this.setWanted(0);
      this.peds.removeCops();
      this.audio.sirenOff();
      this.health = 100;
      this.armour = 0;
      if (this.dead) this.respawnInMatch();
      this.toast('MATCH ON — first to ' + m.target);
    } else if (m.state === MATCH_OVER && prev.state === MATCH_LIVE) {
      const winner = m.scoreA >= m.target ? TEAM_A : TEAM_B;
      this.toast(this.net.myTeam === winner ? 'YOUR TEAM WINS' : 'YOUR TEAM LOSES');
    }
    this.pushNetHud();
  }

  /** Hand our car back to the ambient set, if we had claimed one. */
  private releaseCar(): void {
    if (!this.claimedCar) return;
    this.traffic?.setClaimed(this.claimedCar, false);
    this.net.sendClaim(this.claimedCar, false);
    this.claimedCar = 0;
  }

  private pushNetHud(): void {
    const m = this.net.match;
    setHud({
      netMap: this.net.status === 'online' ? mapAt(this.net.roomMap).name : '',
      netStatus: this.net.status,
      netRoom: this.net.roomCode,
      netError: this.net.error,
      netPeers: this.net.peerCount,
      netNames: [...this.net.peers.values()].map((p) => p.name),
      netTeam: this.net.myTeam,
      netHost: this.net.isHost,
      netMode: m.mode,
      netMatch: m.state,
      netScoreA: m.scoreA,
      netScoreB: m.scoreB,
      netTarget: m.target,
      netRoster: this.net.roster(),
      netFeed: this.net.feed.slice(),
    });
  }

  dispose(): void {
    this.net.disconnect();
    this.remotes?.dispose();
    cancelAnimationFrame(this.raf);
    this.running = false;
    removeEventListener('resize', this.onResize);
    this.input.detach();
    this.audio.dispose();
    this.combat?.dispose();
    this.peds?.dispose();
    this.traffic?.dispose();
    this.weather?.dispose();
    this.ops?.dispose();
    this.jobs?.dispose();
    this.renderer.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }

  /* ── main loop ─────────────────────────────────────────────────────────── */

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const raw = this.clock.getDelta();
    if (this.paused) {
      this.renderer.render(this.scene, this.camera);
      this.input.endFrame();
      return;
    }
    // BULLETTIME scales here rather than in each system: everything downstream takes dt,
    // so one multiply slows the cars, the crowd, the animation and the weather together.
    const dt = Math.min(raw, 0.05) * this.timeScale;
    this.elapsed += dt;
    const t0 = performance.now();

    this.updateFrame(dt);

    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();

    // adaptive resolution: protect the frame budget before quality
    const ft = performance.now() - t0;
    this.frameTimes.push(ft);
    if (this.frameTimes.length > 40) this.frameTimes.shift();
    this.resTimer -= dt;
    if (this.settings.adaptiveRes && this.resTimer <= 0 && this.frameTimes.length > 20) {
      this.resTimer = 0.8;
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      const cap = this.preset.pixelRatio;
      if (avg > 19 && this.resScale > 0.66) this.resScale = Math.max(0.66, this.resScale - 0.12);
      else if (avg < 11 && this.resScale < cap) this.resScale = Math.min(cap, this.resScale + 0.08);
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.resScale));
    }
  };

  private updateFrame(dt: number): void {
    if (!this.traffic || !this.hero || !this.peds) return;
    const t = this.elapsed;

    // map toggle + pause keys
    if (this.input.justPressed('map')) this.toggleMap();
    if (this.input.justPressed('job')) {
      const msg = this.jobs.toggle(this.vehicle, this.px, this.pz, this.traffic.cars);
      if (msg) this.toast(msg);
    }

    // camera look
    const wantAim = this.input.buttons[2] && !this.vehicle && !this.dead;
    this.aiming = wantAim;
    this.rig.applyMouse(this.input.mouseDX, this.input.mouseDY, this.settings, this.aiming);
    if (this.input.wheel !== 0) this.rig.zoomStep(this.input.wheel);

    // rebuild the dynamic collider list from last frame's vehicle positions
    this.phys.dyn.length = 0;
    for (const v of this.traffic.cars) this.phys.dyn.push(v.box);
    // Cars other players are driving are solid too, so you can crash into a friend and
    // shoot at the car they are sitting in rather than through it.
    if (this.net.status !== 'offline') this.remotes.collisionBoxes(this.phys.dyn);
    this.ops.addColliders(this.phys.dyn);

    if (this.settings.dayNight) {
      this.sky.setHour(this.startHour + t / 90);   // a full day every 36 minutes
      this.city.setNight(this.sky.night);
      if (this.scene.environment) this.setEnvIntensity(this.sky.hour);
      if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(this.sky.fogColor());
    }

    // Weather runs after the sky, because it dims the sun and thickens the fog the
    // day/night pass has just set — and before the vehicles, because it sets their grip.
    this.rig.getPivot(this.tmp2);
    this.weather.update(
      dt, t, this.tmp2.x, this.tmp2.y, this.tmp2.z, this.sky,
      this.scene.fog instanceof THREE.Fog ? this.scene.fog : null, this.preset.drawDistance,
    );
    setSurfaceGrip(this.weather.gripScale());
    if (this.weather.thunderCue) this.audio.thunder(0.35 + this.rng() * 0.6);
    this.audio.rainLevel(this.weather.hiss);

    if (this.dead) {
      if (this.carMove) this.cancelCarMove();
      this.updateDead(dt);
    } else if (this.carMove) this.updateCarMove(dt, t);
    else if (this.vehicle) this.updateDriving(dt, t);
    else this.updateOnFoot(dt, t);

    this.updateWeapons(dt, t);
    this.updateHeat(dt);

    this.updateFade(dt);
    if (this.interior) this.interior.grace = Math.max(0, this.interior.grace - dt);

    // The world, which is only there while you are in it.
    //
    // Indoors the player is six kilometres from the city, so pointing the streaming
    // systems at them would spawn a traffic jam in the void and walk the crowd off the
    // edge of the map. Freezing the street for the length of a shopping trip is both
    // cheaper and what every GTA has done. Combat particles and the prompt still run,
    // because both of those are about the room you are actually stood in.
    if (!this.interior) {
      this.streamTimer -= dt;
      if (this.streamTimer <= 0) {
        this.streamTimer = 2.5;
        this.traffic.streamTo(this.px, this.pz);
      }
      this.traffic.update(dt, t, this.vehicle, this.px, this.pz, this.wanted > 0 ? { x: this.px, z: this.pz } : null);
      this.runOverCheck(dt);
      this.peds.update(
        dt, t, this.px, this.py, this.pz, !this.dead, this.wanted,
        (cop) => this.copShoot(cop),
        this.preset.drawDistance * 0.6,
      );
      this.updateItems(dt, t);
      this.updateDrowning(dt);
      this.updateWrecks(dt);
      this.updateOps(dt, t);
      this.updateGarage(dt);
      this.jobs.update(dt, this.vehicle, this.px, this.pz, this.traffic.cars);
    }
    this.combat.update(dt);
    this.updateInteraction();

    if (this.cheatMsgT > 0) {
      this.cheatMsgT -= dt;
      if (this.cheatMsgT <= 0) setHud({ cheatMessage: null });
    }

    // Living world: wind through the leaves and light on the water. Two uniform writes —
    // no extra render passes, which is why they cost nothing measurable.
    updateFoliage(this.mats.foliage, t);
    updateWater(this.mats.water, {
      time: t,
      night: this.sky.night,
      sunDir: this.sky.sunDir(),
      sunColour: this.sky.sun.color,
      skyTop: this.sky.topColour(),
      skyHorizon: this.sky.horizonColour(),
    });

    // ── multiplayer: report our own state, draw everyone else's
    if (this.net.status !== 'offline') {
      const now = Date.now();
      const v = this.vehicle;
      this.net.sendState(now, {
        x: this.px, y: this.py, z: this.pz,
        yaw: v ? v.yaw : this.pyaw,
        flags: packFlags({
          sprint: this.speed > WALK_SPEED + 0.4,
          aiming: this.aiming,
          inVehicle: !!v,
          dead: this.dead,
          grounded: this.grounded,
          crouching: this.crouching,
        }),
        speed: this.speed,
        weapon: Math.max(0, WEAPON_ORDER.indexOf(this.weapon)),
        team: this.net.myTeam,
        health: Math.max(0, Math.round(this.health)),
        // The car we are in travels with us, which is the whole fix for a driving player
        // being invisible to everyone else.
        vkind: v ? Math.max(0, VEH_KINDS.indexOf(v.kind)) : 0,
        vcolour: v ? Math.max(0, CAR_COLOURS.indexOf(v.colour)) : 0,
      });

      // Ambient traffic: exactly one client simulates it, everyone else replays it.
      // Only while actually online — a socket that is still connecting, or has errored,
      // has no host, and puppeting a host that does not exist freezes the whole street.
      if (this.net.online) {
        this.traffic.setPuppet(!this.net.isHost, MAX_SYNC_CARS);
        if (this.net.isHost) this.net.sendTraffic(now, this.traffic.netCars());
        else this.traffic.applyNetwork(this.net.traffic.sample(now), dt);
      }

      this.remotes.update(this.net, dt, t, now, this.px, this.pz, this.preset.drawDistance * 0.75);
    }

    this.sky.update(dt, this.camera.position.x, this.camera.position.z, this.tmp.set(this.px, this.py, this.pz));
    this.pushHud(dt);
  }

  /* ── on foot ───────────────────────────────────────────────────────────── */

  private updateOnFoot(dt: number, t: number): void {
    if (this.input.justPressed('crouch')) {
      this.crouching = !this.crouching;
    }
    const fwd = this.input.axis('back', 'forward');
    const strafe = this.input.axis('left', 'right');
    let wx = this.rig.forwardX() * fwd + this.rig.rightX() * strafe;
    let wz = this.rig.forwardZ() * fwd + this.rig.rightZ() * strafe;
    const l = Math.hypot(wx, wz);
    if (l > 1) { wx /= l; wz /= l; }
    const sprint = this.input.isDown('sprint') && !this.aiming && !this.crouching && l > 0;
    if (sprint || !this.grounded) {
      this.crouching = false;
    }
    const mult = this.speedFreak ? 2.0 : 1.0;
    const maxSpeed = this.crouching ? CROUCH_SPEED : this.aiming ? AIM_SPEED : sprint ? RUN_SPEED * mult : WALK_SPEED * mult;
    const targetX = wx * maxSpeed, targetZ = wz * maxSpeed;
    const accel = l > 0 ? 16 : 12;
    this.vx = damp(this.vx, targetX, accel, dt);
    this.vz = damp(this.vz, targetZ, accel, dt);
    this.speed = Math.hypot(this.vx, this.vz);

    // horizontal motion, sub-stepped so fast movement can't tunnel
    const move = this.speed * dt;
    const steps = Math.max(1, Math.ceil(move / (PLAYER_R * 0.7)));
    for (let i = 0; i < steps; i++) {
      const nx = this.px + (this.vx * dt) / steps;
      const nz = this.pz + (this.vz * dt) / steps;
      this.phys.resolveCircle(nx, nz, PLAYER_R, this.py, this.py + PLAYER_H, STEP_UP, true);
      if (this.interior) {
        // Interiors are parked far outside the city on purpose; clamping to the city's
        // bounds in here would drag the player back to the edge of the map the instant
        // they took a step, which is precisely what it did the first time.
        this.px = this.phys.outX;
        this.pz = this.phys.outZ;
      } else {
        const B = this.city.bounds;
        this.px = clamp(this.phys.outX, B.minX, B.maxX);
        this.pz = clamp(this.phys.outZ, B.minZ, B.maxZ);
      }
    }

    // vertical
    const ground = this.phys.groundHeight(this.px, this.pz, PLAYER_R, this.py + STEP_UP + 0.05);
    if (this.grounded) {
      this.py = damp(this.py, ground, 22, dt);
      if (this.py < ground) this.py = ground;
      if (this.input.justPressed('jump')) {
        this.vy = JUMP_V;
        this.grounded = false;
        this.crouching = false;
        this.audio.jump();
      } else if (this.py - ground > 0.55) {
        this.grounded = false;
        this.vy = 0;
      }
    } else {
      this.vy -= GRAVITY * (this.lowGrav ? 0.3 : 1) * dt;
      this.py += this.vy * dt;
      const g2 = this.phys.groundHeight(this.px, this.pz, PLAYER_R, this.py + 0.3);
      if (this.py <= g2 && this.vy <= 0) {
        this.py = g2;
        this.vy = 0;
        this.grounded = true;
        this.audio.land();
      }
    }

    // Facing: strafe while aiming, otherwise turn towards travel.
    const firing = this.input.buttons[0];
    const lookOff = wrapPi(this.rig.yaw - this.pyaw);
    if (this.aiming || (firing && this.weapon !== 'fists')) {
      this.pyaw = angleDamp(this.pyaw, this.rig.yaw, 18, dt);
    } else if (this.speed > 0.25) {
      this.pyaw = angleDamp(this.pyaw, Math.atan2(this.vx, this.vz), 12, dt);
    } else if (Math.abs(lookOff) > 1.85) {
      // Standing still with the camera swung round behind us: shuffle round to face it,
      // rather than standing with our back to the player for ever.
      this.pyaw = angleDamp(this.pyaw, this.rig.yaw, 2.6, dt);
    }

    // footsteps
    if (this.grounded && this.speed > 0.4) {
      this.footPhase += dt * (2.4 + this.speed * 0.9);
      if (this.footPhase >= 1) {
        this.footPhase = 0;
        this.audio.footstep(clamp(this.speed / RUN_SPEED, 0.25, 1));
      }
    }

    this.hero.root.position.set(this.px, this.py, this.pz);
    this.hero.root.rotation.y = this.pyaw;
    this.flinch = Math.max(0, this.flinch - dt);
    this.punchT = Math.max(0, this.punchT - dt);
    poseHumanoid(this.hero, {
      dt, t, speed: this.speed, runSpeed: RUN_SPEED, grounded: this.grounded, airVy: this.vy,
      // A blade is swung, not aimed. Firing used to drop every weapon except bare fists
      // into the two-handed rifle stance, which is why the knife and the katana were
      // held out in front like pistols.
      aiming: this.aiming || (firing && !WEAPONS[this.weapon].melee),
      aimPitch: -this.rig.pitch, dead: 0, seated: false,
      crouching: this.crouching,
      punch: this.punchT > 0.22 ? 1 : 0,
      punchSide: this.punchSide,
      slash: this.punchSlash,
      flinch: this.flinch, steer: 0,
      // the head tracks the camera, so looking around actually looks around
      lookYaw: wrapPi(this.rig.yaw - this.pyaw),
      lookPitch: this.rig.pitch - 0.24,
    });
    setHumanoidDetail(this.hero, true, this.preset.shadows);

    this.rig.updateOnFoot(
      this.camera, dt, this.px, this.py, this.pz,
      this.aiming, WEAPONS[this.weapon].zoom, this.phys, this.settings,
      this.crouching,
    );
  }

  /* ── driving ───────────────────────────────────────────────────────────── */

  private updateDriving(dt: number, t: number): void {
    const v = this.vehicle!;
    const c = v.ctrl;
    c.throttle = this.input.isDown('forward') ? 1 : 0;
    c.brake = this.input.isDown('back') ? 1 : 0;
    c.steer = this.input.axis('left', 'right');
    c.handbrake = this.input.isDown('jump');
    const wasBoosting = v.boosting;
    c.boost = this.input.isDown('sprint');
    if (v.boosting && !wasBoosting) this.audio.boost();
    if (this.input.justPressed('horn')) {
      v.hornT = 0.3;
      this.audio.horn();
      this.peds.panic(v.x, v.z, 9, 2.5);
      // Lean on it and somebody eventually takes it personally.
      const heard = this.peds.nearestCivilian(v.x, v.z, 11);
      if (heard) this.peds.provoke(heard, v.x, v.z, 0.3);
    }

    stepVehicle(v, dt, this.phys);
    this.px = v.x;
    this.pz = v.z;
    this.py = v.y;
    this.audio.engineRpm(v.speed, v.spec.maxSpeed, c.throttle + (v.boosting ? 0.4 : 0));

    updateAlarm(v, dt, t);
    if (v.alarmT > 0) {
      this.alarmChirpT -= dt;
      if (this.alarmChirpT <= 0) {
        this.audio.carAlarm(0.9);
        this.alarmChirpT = 0.28;
      }
    }

    if (v.crashT > 0.3) {
      this.audio.crash(Math.abs(v.speed) + 6);
      this.rig.shake = Math.min(1.2, this.rig.shake + 0.5);
      this.damagePlayer(Math.min(14, Math.abs(v.speed) * 0.5), v.x, v.z, false);
      this.roadRage(v);
    }

    // driver animation inside the car
    poseHumanoid(this.hero, {
      dt, t, speed: 0, runSpeed: RUN_SPEED, grounded: true, airVy: 0,
      aiming: false, aimPitch: 0, dead: 0, seated: true, punch: 0, flinch: this.flinch,
      steer: c.steer,
    });

    this.rig.updateInVehicle(this.camera, dt, v, this.phys, this.settings);

    if (this.input.justPressed('use')) {
      this.input.consume('use');       // don't let updateInteraction re-enter the same car
      this.exitVehicle();
    }
  }

  /**
   * Start getting into a car.
   *
   * Pressing E used to put you in the driver's seat on the same frame you were stood on
   * the pavement. Now it opens a move: round to the door, then in. The claim happens here
   * rather than when the move lands, so the traffic AI — or another player — cannot drive
   * off with the car you are halfway into.
   */
  private enterVehicle(v: Vehicle): void {
    if (this.carMove || this.vehicle) return;
    const held = this.models[this.weapon];
    if (held) held.group.visible = false;
    v.isPlayer = true;
    v.ai = null;
    v.ctrl.throttle = 0;
    v.ctrl.brake = 1;
    v.ctrl.steer = 0;
    if (this.carArmour) v.armoured = true;
    this.traffic.release(v);
    // Tell the room this car is ours: the host stops simulating and broadcasting it, and
    // everyone else drops their copy, so nobody sees two of the taxi we just stole.
    if (this.net.online && v.netId) {
      this.claimedCar = v.netId;
      this.traffic.setClaimed(v.netId, true);
      this.net.sendClaim(v.netId, true);
    }
    const side = this.pickDoorSide(v);
    const d = doorPoint(v.x, v.z, v.yaw, v.spec.halfW, v.spec.seat[2], side);
    this.carMove = {
      v, out: false, t: 0, side,
      from: { x: this.px, y: this.py, z: this.pz, yaw: this.pyaw, crouch: 0 },
      spot: { x: this.px, z: this.pz },
      stepT: stepTime(Math.hypot(d.x - this.px, d.z - this.pz)),
    };
    this.audio.carDoorOpen();
  }

  /**
   * Which side to use. The driver's door if there is room to stand at it, and the other
   * side if there is not — otherwise parking with your nearside against a wall makes the
   * car unusable, which is exactly where you park in a city.
   */
  private pickDoorSide(v: Vehicle): number {
    const want = driverSide(v.spec.seat[0]);
    for (const side of [want, -want]) {
      const d = doorPoint(v.x, v.z, v.yaw, v.spec.halfW, v.spec.seat[2], side);
      const gy = this.phys.groundHeight(d.x, d.z, PLAYER_R, v.y + 1.2);
      if (this.phys.isFree(d.x, d.z, PLAYER_R, gy, gy + PLAYER_H, v)) return side;
    }
    return want;
  }

  /** The move has landed: actually sit down. */
  private seatIn(v: Vehicle): void {
    this.vehicle = v;
    this.hero.root.removeFromParent();
    v.bodyPivot.add(this.hero.root);
    this.hero.root.position.set(v.spec.seat[0], seatHeight(v, seatMetrics(this.hero)), v.spec.seat[2]);
    this.hero.root.rotation.set(0, 0, 0);
    this.audio.carDoorSlam();
    this.audio.engineOn();
    setHud({ inVehicle: true, vehicleName: v.spec.name, vehicleClass: v.spec.cls.toUpperCase() });
  }

  private hijackVehicle(v: Vehicle): void {
    // Eject civilian driver onto the ground beside the vehicle
    const rx = rgtX(v.yaw), rz = rgtZ(v.yaw);
    const throwX = v.x - rx * (v.spec.halfW + 0.95);
    const throwZ = v.z - rz * (v.spec.halfW + 0.95);
    const ped = this.peds.spawnPed(false, throwX, throwZ);
    ped.flinch = 0.85;
    ped.state = 'flee';
    ped.fleeT = 14;
    ped.fleeFromX = this.px;
    ped.fleeFromZ = this.pz;
    this.combat.bloodBurst(throwX, v.y + 0.55, throwZ, -rx, 0.4, -rz, 4);

    this.audio.punch();
    this.audio.bodyHit();
    this.audio.carDoorSlam();

    // 25% chance of car alarm triggering
    const alarm = Math.random() < 0.25;
    if (alarm) {
      v.alarmT = 12.0;
      this.toast('⚠️ CAR ALARM TRIGGERED!');
      this.audio.carAlarm(1.0);
      this.addWanted(CRIME.carAlarm);
      this.peds.panic(v.x, v.z, 32, 8);
    } else {
      this.toast(`Hijacked the ${v.spec.name}!`);
      this.addWanted(CRIME.hijack);
      this.peds.panic(v.x, v.z, 16, 5);
    }

    this.enterVehicle(v);
  }

  private exitVehicle(): void {
    const v = this.vehicle!;
    const held = this.models[this.weapon];
    if (held) held.group.visible = true;
    this.releaseCar();
    // Bailing out at speed is allowed — it just hurts. Blocking it instead made E look
    // broken whenever you were moving.
    const bail = Math.abs(v.speed) > 9;
    // look for a clear patch beside the car: the door you are sitting at, then the other
    // side, then the ends. Which side that is comes from where the seat actually is in
    // the model, not from an assumption about which way round the country drives.
    const side = driverSide(v.spec.seat[0]);
    const rx = rgtX(v.yaw), rz = rgtZ(v.yaw);
    const fx = fwdX(v.yaw), fz = fwdZ(v.yaw);
    const cands: [number, number][] = [
      [v.x + rx * side * (v.spec.halfW + 0.9), v.z + rz * side * (v.spec.halfW + 0.9)],
      [v.x - rx * side * (v.spec.halfW + 0.9), v.z - rz * side * (v.spec.halfW + 0.9)],
      [v.x - fx * (v.spec.halfL + 1.1), v.z - fz * (v.spec.halfL + 1.1)],
      [v.x + fx * (v.spec.halfL + 1.1), v.z + fz * (v.spec.halfL + 1.1)],
    ];
    let spot = cands[0];
    for (const c of cands) {
      const gy = this.phys.groundHeight(c[0], c[1], PLAYER_R, v.y + 1.2);
      if (this.phys.isFree(c[0], c[1], PLAYER_R + 0.05, gy, gy + PLAYER_H, v)) { spot = c; break; }
    }
    this.hero.root.removeFromParent();
    this.scene.add(this.hero.root);
    this.hero.root.scale.setScalar(1);
    // Bailing out at speed throws you clear; stepping out starts from the seat and walks
    // the rest, so the pavement is somewhere you arrive rather than somewhere you appear.
    seatWorld(v, this.tmp2);
    this.px = bail ? spot[0] : this.tmp2.x;
    this.pz = bail ? spot[1] : this.tmp2.z;
    this.py = bail
      ? this.phys.groundHeight(spot[0], spot[1], PLAYER_R, v.y + 1.5)
      : v.y + seatHeight(v, seatMetrics(this.hero));
    this.vx = 0; this.vz = 0; this.vy = 0;
    this.grounded = true;
    v.isPlayer = false;
    v.ctrl.throttle = 0;
    v.ctrl.brake = bail ? 0 : 1;
    v.ctrl.handbrake = !bail;          // a car you dive out of keeps rolling
    this.vehicle = null;
    this.audio.engineOff();
    if (bail) {
      // carry the momentum, take the tarmac, and let the camera feel it
      const carry = Math.min(Math.abs(v.speed) * 0.5, 9) * Math.sign(v.speed);
      this.vx = fwdX(v.yaw) * carry;
      this.vz = fwdZ(v.yaw) * carry;
      this.flinch = 0.45;
      this.rig.shake = Math.min(1.4, this.rig.shake + 0.7);
      this.audio.land();
      this.damagePlayer(Math.min(32, (Math.abs(v.speed) - 9) * 2.2), v.x, v.z, false);
      this.toast('You bailed out!');
    } else {
      this.carMove = {
        v, out: true, t: 0, side,
        from: { x: this.px, y: this.py, z: this.pz, yaw: v.yaw, crouch: 0 },
        spot: { x: spot[0], z: spot[1] },
        stepT: 0,
      };
      this.audio.carDoorOpen();
    }
    setHud({ inVehicle: false, vehicleName: '', vehicleClass: '', speed: 0, boosting: false });
  }

  /**
   * Drive one frame of getting in or out.
   *
   * The player is off the physics for the length of it — position comes straight from the
   * curve in `carentry.ts` — but the camera and the animation carry on as normal, which
   * is what stops it feeling like a cutscene.
   */
  private updateCarMove(dt: number, t: number): void {
    const m = this.carMove;
    if (!m) return;
    const v = m.v;
    m.t += dt;

    // A car that goes up while you are climbing into it is not one you are getting into.
    if (!m.out && v.health <= 0) { this.cancelCarMove(); return; }

    // Nobody else is stepping this car — it is flagged as the player's but not being
    // driven yet — so roll it to a stop under the door.
    if (!m.out) {
      stepVehicle(v, dt, this.phys);
      updateVehicleBox(v);
    }

    const door = doorPoint(v.x, v.z, v.yaw, v.spec.halfW, v.spec.seat[2], m.side);
    const groundY = this.phys.groundHeight(door.x, door.z, PLAYER_R, v.y + 1.6);
    // seatWorld already carries the local-X-is-the-car's-left negation; do not re-derive it
    seatWorld(v, this.tmp2);
    const seat = { x: this.tmp2.x, y: v.y + seatHeight(v, seatMetrics(this.hero)), z: this.tmp2.z };
    const pose = m.out
      ? exitPose(m.t, seat, door, groundY, m.spot, v.yaw, m.side)
      : enterPose(m.t, m.from, door, groundY, seat, v.yaw, m.side, m.stepT);

    this.px = pose.x; this.py = pose.y; this.pz = pose.z;
    this.pyaw = pose.yaw;
    this.vx = 0; this.vz = 0; this.vy = 0;
    this.grounded = true;
    this.speed = 0;

    this.hero.root.position.set(this.px, this.py, this.pz);
    this.hero.root.rotation.y = this.pyaw;
    // The first leg is a walk; the second is a duck, and the crouch pose is what makes it
    // read as climbing in rather than as being winched through the door.
    const walking = m.out ? m.t >= CLIMB_OUT : m.t < m.stepT;
    poseHumanoid(this.hero, {
      dt, t, speed: walking ? 3.6 : 0, runSpeed: RUN_SPEED, grounded: true, airVy: 0,
      aiming: false, aimPitch: 0, dead: 0, seated: false,
      crouching: pose.crouch > 0.3,
      punch: 0, flinch: this.flinch, steer: 0,
      lookYaw: wrapPi(this.rig.yaw - this.pyaw),
      lookPitch: this.rig.pitch - 0.24,
    });
    setHumanoidDetail(this.hero, true, this.preset.shadows);
    this.rig.updateOnFoot(
      this.camera, dt, this.px, this.py, this.pz,
      false, 1, this.phys, this.settings, false,
    );

    if (m.t >= (m.out ? EXIT_TIME : enterTime(m.stepT))) {
      this.carMove = null;
      if (m.out) this.audio.carDoorSlam();
      else this.seatIn(v);
    }
  }

  /**
   * Abandon a half-finished move — the car exploded, or the player died on the way in.
   * Puts them on their feet at the door and gives the car back.
   */
  private cancelCarMove(): void {
    const m = this.carMove;
    if (!m) return;
    this.carMove = null;
    const v = m.v;
    if (!m.out) {
      v.isPlayer = false;
      this.releaseCar();
      const held = this.models[this.weapon];
      if (held) held.group.visible = true;
    }
    const door = doorPoint(v.x, v.z, v.yaw, v.spec.halfW, v.spec.seat[2], m.side);
    this.px = door.x;
    this.pz = door.z;
    this.py = this.phys.groundHeight(this.px, this.pz, PLAYER_R, v.y + 1.6);
    this.hero.root.position.set(this.px, this.py, this.pz);
  }

  /* ── weapons ───────────────────────────────────────────────────────────── */

  private setWeapon(id: WeaponId, silent = false): void {
    if (!this.owned[id]) {
      this.toast(`You don't have a ${WEAPONS[id].name.toLowerCase()} yet`);
      this.audio.deny();
      return;
    }
    this.weapon = id;
    this.reloadT = 0;
    for (const key of WEAPON_ORDER) {
      const m = this.models[key];
      if (m) m.group.visible = key === id;
    }
    if (!this.models[id] && id !== 'fists') {
      const m = createWeaponModel(id);
      if (m) {
        this.models[id] = m;
        // A gun rides on the chest rather than at the end of an arm; holdWeapon then
        // brings both hands to it. Blades really are held in a fist, and stay there.
        (m.pocket ? this.hero.rifleMount : this.hero.gunMount).add(m.group);
      }
    }
    const m2 = this.models[id];
    // Guns now ride on the body rather than in a fist, so a weapon that used to be
    // hidden inside the car door is in plain view on the driver's chest. There is no
    // drive-by in this game — updateWeapons returns early in a vehicle — so put it away.
    if (m2) m2.group.visible = !this.vehicle;
    // The off hand follows the weapon: nothing for fists and blades, the foregrip for a
    // long gun, and for a pistol only once the shot is being steadied.
    // init() picks a weapon before spawnPlayer() has built the hero, so this can run with
    // no hero to hang it on; spawnPlayer re-applies it once there is one.
    if (this.hero) {
      this.hero.grip = m2 && m2.foregrip ? { at: m2.foregrip, atRest: m2.supportAtRest } : null;
      this.hero.hold = m2 && m2.pocket ? m2.group : null;
      if (m2 && m2.pocket) this.hero.pocket.copy(m2.pocket);
    }
    if (!silent) this.audio.ui();
    setHud({ weapon: id, mag: this.mag[id], reserve: this.reserve[id] });
  }

  private cycleWeapon(dir: number): void {
    const idx = WEAPON_ORDER.indexOf(this.weapon);
    const n = WEAPON_ORDER.length;
    const next = (idx + dir + n) % n;
    this.setWeapon(WEAPON_ORDER[next]);
  }

  private updateWeapons(dt: number, t: number): void {
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.hitMarker = Math.max(0, this.hitMarker - dt);

    if (this.input.justPressed('fists')) this.setWeapon('fists');
    if (this.input.justPressed('knife')) this.setWeapon('knife');
    if (this.input.justPressed('sword')) this.setWeapon('sword');
    if (this.input.justPressed('pistol')) this.setWeapon('pistol');
    if (this.input.justPressed('smg')) this.setWeapon('smg');
    if (this.input.justPressed('ak47')) this.setWeapon('ak47');
    if (this.input.justPressed('shotgun')) this.setWeapon('shotgun');
    if (this.input.justPressed('sniper')) this.setWeapon('sniper');
    if (this.input.justPressed('rpg')) this.setWeapon('rpg');
    if (this.input.justPressed('minigun')) this.setWeapon('minigun');

    if (this.input.wheel !== 0 && !this.aiming) {
      this.cycleWeapon(this.input.wheel > 0 ? 1 : -1);
    }

    const spec = WEAPONS[this.weapon];
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        const need = spec.mag - this.mag[this.weapon];
        const take = Math.min(need, this.reserve[this.weapon]);
        this.mag[this.weapon] += take;
        this.reserve[this.weapon] -= take;
        setHud({ reloading: false, mag: this.mag[this.weapon], reserve: this.reserve[this.weapon] });
      }
      return;
    }
    if (this.dead || this.vehicle) return;

    if (this.input.justPressed('reload')) this.beginReload();

    const wantFire = spec.auto ? this.input.buttons[0] : this.input.buttonEdge[0];
    if (wantFire && this.fireCd <= 0) {
      if (spec.melee) this.melee(t);
      else this.shoot(spec, t);
    }

    // crosshair target highlight (one ray a frame — the reticle is up whenever a gun is out)
    if (!spec.melee) {
      this.camera.getWorldDirection(this.camDir);
      this.rig.getPivot(this.tmp);
      const h = this.combat.raycast(
        this.tmp.x, this.tmp.y, this.tmp.z,
        this.camDir.x, this.camDir.y, this.camDir.z,
        spec.range, this.peds.peds, null, null,
      );
      setHud({ crosshairHot: h.kind === 'ped' });
    } else if (getHud().crosshairHot) {
      setHud({ crosshairHot: false });
    }
  }

  private beginReload(): void {
    const spec = WEAPONS[this.weapon];
    if (spec.melee || this.mag[this.weapon] >= spec.mag || this.reserve[this.weapon] <= 0) return;
    this.reloadT = spec.reload;
    this.audio.reload();
    setHud({ reloading: true });
  }

  private shoot(spec: WeaponSpec, t: number): void {
    if (this.mag[this.weapon] <= 0) {
      this.audio.dryFire();
      this.fireCd = 0.25;
      this.beginReload();
      return;
    }
    if (!this.infiniteAmmo) this.mag[this.weapon]--;
    this.fireCd = 60 / spec.rpm;
    this.lastShotT = t;
    this.audio.gunshot(this.weapon);
    setHud({ mag: this.mag[this.weapon] });

    this.camera.getWorldDirection(this.camDir);
    this.rig.getPivot(this.tmp);
    const ox = this.tmp.x, oy = this.tmp.y, oz = this.tmp.z;

    // muzzle flash at the actual barrel tip
    const model = this.models[this.weapon];
    if (model) {
      model.muzzle.getWorldPosition(this.tmp2);
      this.combat.muzzleFlash(
        this.tmp2.x, this.tmp2.y, this.tmp2.z,
        this.weapon === 'shotgun' ? 0.85 : this.weapon === 'rpg' ? 1.2 : this.weapon === 'sniper' ? 0.75 : 0.55,
      );
    } else {
      this.tmp2.set(ox, oy, oz);
    }

    if (spec.explosive) {
      // RPG Rocket projectile
      this.combat.spawnRocket(
        this.tmp2.x, this.tmp2.y, this.tmp2.z,
        this.camDir.x, this.camDir.y, this.camDir.z,
        52, spec.damage,
      );
      this.rig.addRecoil(spec.recoilPitch, (Math.random() - 0.5) * spec.recoilYaw * 2, spec.shake);
      this.peds.panic(this.px, this.pz, 30, 8);
      // firing a rocket is loud, but the explosion it causes is the real crime
      this.addWanted(CRIME.rocketFired);
      return;
    }

    const spreadScale = (this.aiming ? 0.32 : 1.5) * (this.speed > 2 ? 1.5 : 1);
    let hitAny = false;
    let killed = false;
    for (let p = 0; p < spec.pellets; p++) {
      const sp = spec.spread * spreadScale;
      const dx = this.camDir.x + (Math.random() - 0.5) * sp;
      const dy = this.camDir.y + (Math.random() - 0.5) * sp;
      const dz = this.camDir.z + (Math.random() - 0.5) * sp;
      const inv = 1 / Math.hypot(dx, dy, dz);
      const hit = this.combat.raycast(
        ox, oy, oz, dx * inv, dy * inv, dz * inv, spec.range,
        this.peds.peds, null, null, this.remotes.hitTargets(),
      );
      this.combat.tracer(
        this.tmp2.x, this.tmp2.y, this.tmp2.z, hit.x, hit.y, hit.z,
        this.weapon === 'sniper' ? 0x7df3ff : 0xffd070,
      );

      if (hit.kind === 'ped' && hit.ped) {
        hitAny = true;
        const dmg = spec.damage * (hit.head ? spec.headMult : 1);
        const died = this.peds.damage(hit.ped, dmg, this.px, this.pz);
        this.combat.bloodBurst(hit.x, hit.y, hit.z, -dx * inv, 0.4, -dz * inv, hit.head ? 14 : 9);
        this.audio.bodyHit();
        if (died) {
          killed = true;
          this.onPedKilled(hit.ped);
        }
      } else if (hit.kind === 'player') {
        hitAny = true;
        this.net.sendHit(hit.netId, spec.damage * (hit.head ? spec.headMult : 1), hit.head ? HIT_HEAD : 0);
        this.combat.bloodBurst(hit.x, hit.y, hit.z, -dx * inv, 0.4, -dz * inv, hit.head ? 14 : 9);
        this.audio.bodyHit();
      } else if (hit.kind === 'vehicle' && hit.veh) {
        hitAny = true;
        if (!hit.veh.armoured) hit.veh.health -= spec.damage * 0.6;
        this.combat.impact(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz);
      } else if (hit.kind !== 'none') {
        this.combat.impact(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz);
      }
    }
    if (hitAny) {
      this.hitMarker = 0.22;
      this.audio.hitMarker();
    }
    this.rig.addRecoil(spec.recoilPitch, (Math.random() - 0.5) * spec.recoilYaw * 2, spec.shake);
    this.peds.panic(this.px, this.pz, 26, 7);
    if (!killed) this.reportGunfire();
  }

  /**
   * A strike, and the combo it belongs to.
   *
   * Clicking used to fire the same right-handed jab at a fixed `60 / rpm` cadence, so
   * hammering the button produced one animation on repeat and nothing chained. Now
   * successive clicks inside a short window alternate hands and speed up, and the third
   * lands noticeably harder — which is the whole rhythm of a GTA brawl. Let the window
   * lapse and the combo resets.
   */
  private melee(t: number): void {
    const spec = WEAPONS[this.weapon];
    const blade = this.weapon === 'knife' || this.weapon === 'sword';

    this.combo = t - this.lastMeleeT < COMBO_WINDOW ? (this.combo + 1) % 3 : 0;
    this.lastMeleeT = t;
    const finisher = this.combo === 2;
    // deliberately shorter than 60/rpm: a combo has to be able to chain faster than the
    // weapon's nominal rate, or the second click lands after the first has finished
    this.fireCd = finisher ? (blade ? 0.62 : 0.5) : blade ? 0.3 : 0.24;
    this.punchT = 0.4;
    this.punchSide = this.combo === 1 ? -1 : 1;
    this.punchSlash = blade;
    this.rig.shake = Math.min(1, this.rig.shake + (finisher ? 0.16 : 0.05));

    if (blade) this.audio.slash(this.weapon === 'sword' || finisher);
    else this.audio.punch();

    const damage = spec.damage * (finisher ? 1.85 : 1) * (this.ironFist ? 9 : 1);
    if (this.net.pvp && this.meleePlayer(spec.range, damage)) return;

    let best: Ped | null = null;
    let bd = spec.range * spec.range;
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;
      const d = dist2(p.x, p.z, this.px, this.pz);
      if (d > bd) continue;
      const ang = Math.abs(wrapPi(Math.atan2(p.x - this.px, p.z - this.pz) - this.rig.yaw));
      if (ang > 1.0) continue;
      bd = d;
      best = p;
    }
    if (!best) return;
    const died = this.peds.damage(best, damage, this.px, this.pz);
    // a finisher actually moves them
    if ((finisher || this.ironFist) && !died) {
      best.state = 'flee';
      best.fleeT = Math.max(best.fleeT, 6);
      best.fleeFromX = this.px;
      best.fleeFromZ = this.pz;
    }
    this.combat.bloodBurst(
      best.x, best.y + 1.3, best.z,
      Math.sin(this.rig.yaw), 0.5, Math.cos(this.rig.yaw),
      this.weapon === 'sword' ? 14 : 7,
    );
    this.audio.bodyHit();
    this.hitMarker = 0.22;
    if (died) this.onPedKilled(best);
    else this.addWanted(CRIME.brawl);
    this.peds.panic(this.px, this.pz, 14, 5);
    void t;
  }

  private onExplosion(ex: number, ey: number, ez: number, damage: number, radius: number): void {
    this.audio.explosion();
    const dPlayer = Math.hypot(this.px - ex, this.pz - ez);
    if (dPlayer < radius) {
      const dmg = damage * (1 - dPlayer / radius) * 0.45;
      this.damagePlayer(dmg, ex, ez, true);
    }
    const dRig = Math.hypot(this.camera.position.x - ex, this.camera.position.z - ez);
    if (dRig < 35) {
      this.rig.shake = Math.min(2.0, this.rig.shake + (1 - dRig / 35) * 1.6);
    }
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;
      const d = Math.hypot(p.x - ex, p.z - ez);
      if (d < radius) {
        const dmg = damage * (1 - d / radius);
        const died = this.peds.damage(p, dmg, ex, ez);
        this.combat.bloodBurst(p.x, p.y + 1.1, p.z, (p.x - ex) / (d + 0.1), 0.5, (p.z - ez) / (d + 0.1), 12);
        if (died) this.onPedKilled(p);
      }
    }
    for (const v of this.traffic.cars) {
      const d = Math.hypot(v.x - ex, v.z - ez);
      if (d < radius) {
        const factor = 1 - d / radius;
        if (!v.armoured) v.health -= damage * factor * 0.75;
        if (d > 0.1) {
          v.vx += ((v.x - ex) / d) * 12 * factor;
          v.vz += ((v.z - ez) / d) * 12 * factor;
        }
      }
    }
    if (this.net.status !== 'offline') {
      for (const target of this.remotes.hitTargets()) {
        if (target.friendly) continue;
        const d = Math.hypot(target.x - ex, target.z - ez);
        if (d < radius) {
          this.net.sendHit(target.id, damage * (1 - d / radius), HIT_VEHICLE);
        }
      }
    }
    this.peds.panic(ex, ez, 32, 8);
    this.addWanted(CRIME.explosion);
  }

  /** Swing at the nearest enemy player in front of us. Returns true if we connected. */
  private meleePlayer(range: number, damage: number): boolean {
    let bestId = 0;
    let bd = range * range;
    for (const q of this.remotes.hitTargets()) {
      if (q.friendly) continue;
      const d = dist2(q.x, q.z, this.px, this.pz);
      if (d > bd) continue;
      if (Math.abs(wrapPi(Math.atan2(q.x - this.px, q.z - this.pz) - this.rig.yaw)) > 0.9) continue;
      bd = d;
      bestId = q.id;
    }
    if (!bestId) return false;
    this.net.sendHit(bestId, damage, HIT_MELEE);
    this.audio.bodyHit();
    this.hitMarker = 0.2;
    return true;
  }

  private onPedKilled(p: Ped): void {
    this.audio.death();
    this.combat.bloodPool(p.x, p.y, p.z, 1.8);
    this.combat.bloodBurst(p.x, p.y + 1.1, p.z, 0, 1, 0, 12);
    // Killing civilians tops out at three stars however many you kill; only the police
    // being shot at brings the whole force down on you.
    this.addWanted(p.cop ? CRIME.officerKilled : CRIME.civilianKilled);
    // Wallets. Police carry more, and an angry civilian who came at you was carrying
    // enough to be worth the trouble — so a fight is never a pure loss.
    const rich = p.swat ? 3 : p.cop ? 2 : p.state === 'aggro' ? 1.6 : 1;
    if (Math.random() < (p.cop ? 0.8 : 0.6)) {
      this.dropCash(p.x, p.y, p.z, Math.round((20 + Math.floor(Math.random() * 8) * 30) * rich));
    }
  }

  /* ── police / wanted ──────────────────────────────────────────────────── */

  /** Set the level and its target together. Every reset goes through here. */
  private setWanted(v: number): void {
    this.wanted = v;
    this.wantedTarget = v;
  }

  /**
   * Apply one offence. The curve and the tuning table both live in wanted.ts.
   *
   * Note this escalates the *target*, not the visible level: resistance is charged
   * against how bad the police already think things are, so committing five crimes
   * while the meter is still filling costs what five crimes should, rather than five
   * times what the first one did.
   */
  private addWanted(c: Crime): void {
    if (this.net.pvp) return;
    const after = escalate(this.wantedTarget, c);
    if (after <= this.wantedTarget) return;
    this.wantedTarget = after;
    this.wantedCool = 0;
  }

  /**
   * A gunshot only counts if somebody is around to report it.
   *
   * This used to be a flat `addWanted(0.34)` on *every shot fired*, hit or miss, witness
   * or not — so three rounds into an empty sky was a star, and one burst from an
   * automatic weapon was the whole wanted meter. Now it needs a witness within earshot,
   * it is rate-limited so a burst counts once rather than per bullet, and it cannot take
   * you past two stars on its own.
   */
  private reportGunfire(): void {
    if (this.net.pvp || this.gunHeatT > 0) return;
    const witness = this.peds.nearestAlive(this.px, this.pz, 34);
    if (!witness) return;
    this.gunHeatT = 1.1;
    this.addWanted(witness.cop ? CRIME.gunfireSeenByCop : CRIME.gunfireHeard);
  }

  private updateHeat(dt: number): void {
    this.gunHeatT = Math.max(0, this.gunHeatT - dt);
    // The meter fills towards where the crimes have put it. The chime belongs here, not
    // in addWanted: the star is not real until it is on screen.
    if (this.wantedTarget > this.wanted) {
      const before = Math.floor(this.wanted);
      this.wanted = riseTowards(this.wanted, this.wantedTarget, dt);
      if (Math.floor(this.wanted) > before) this.audio.wanted();
    }

    if (this.wanted > 0) {
      const seen = this.peds.nearestAlive(this.px, this.pz, 45, true);
      let visible = false;
      if (seen) {
        visible = this.phys.segmentClear(seen.x, seen.y + 1.5, seen.z, this.px, this.py + 1.2, this.pz) > 0.98;
      }
      this.wantedCool = visible ? 0 : this.wantedCool + dt;
      if (this.wantedCool > 14) {
        this.setWanted(Math.max(0, this.wanted - dt * 0.16));
        if (this.wanted < 0.05) {
          this.setWanted(0);
          this.peds.removeCops();
          for (const v of [...this.traffic.cars]) if (v.siren && !v.isPlayer) this.traffic.remove(v);
          this.ops.clear();
          this.audio.sirenOff();
          this.toast('You lost the cops');
        }
      }

      // Spawn pressure scales with the star rating, and the *kind* of officer changes
      // with it: beat cops at 1-2, cruisers from 2, SWAT from 4.
      this.copTimer -= dt;
      const wantCops = Math.round(this.wanted * 1.6);
      if (this.copTimer <= 0 && this.peds.copCount() < wantCops) {
        this.copTimer = 3.5;
        this.spawnCopNearby(this.wanted >= 4);
      }
      const wantCars = this.wanted >= 2 ? Math.floor(this.wanted) - 1 : 0;
      const haveCars = this.traffic.cars.filter((v) => v.siren && !v.isPlayer).length;
      if (haveCars < wantCars) this.spawnCopCar(this.wanted >= 4 && haveCars >= 2);

      // sirens
      const nearestCar = this.traffic.cars.find((v) => v.siren && !v.isPlayer);
      if (nearestCar) {
        this.audio.sirenOn();
        const d = Math.hypot(nearestCar.x - this.px, nearestCar.z - this.pz);
        this.audio.sirenUpdate(dt, clamp(1 - d / 70, 0, 1));
      }

      // arrest: stand still next to a cop with your hands empty for too long
      const close = this.peds.nearestAlive(this.px, this.pz, 2.4, true);
      if (close && !this.vehicle && this.speed < 0.6 && this.elapsed - this.lastShotT > 3) {
        this.bustedT += dt;
        if (this.bustedT > 2.2) this.busted();
      } else this.bustedT = Math.max(0, this.bustedT - dt);
    } else {
      this.bustedT = 0;
    }
  }

  private spawnCopNearby(swat: boolean): void {
    const nodes = this.city.nodes;
    for (let i = 0; i < 30; i++) {
      const n = pick(this.rng, nodes);
      const d = dist2(n.x, n.z, this.px, this.pz);
      if (d < 34 * 34 || d > 95 * 95) continue;
      this.peds.spawnPed(true, n.x, n.z, swat);
      return;
    }
  }

  private spawnCopCar(enforcer: boolean): void {
    const nodes = this.city.nodes;
    for (let i = 0; i < 30; i++) {
      const n = pick(this.rng, nodes);
      const d = dist2(n.x, n.z, this.px, this.pz);
      if (d < 55 * 55 || d > 150 * 150) continue;
      const yaw = Math.atan2(this.px - n.x, this.pz - n.z);
      const v = enforcer
        ? this.traffic.spawnEnforcer(n.x, n.z, yaw)
        : this.traffic.spawnPolice(n.x, n.z, yaw);
      updateVehicleBox(v);
      return;
    }
  }

  private copShoot(cop: Ped): void {
    const spec = cop.swat ? WEAPONS.ak47 : WEAPONS.pistol;
    const gx = cop.x, gy = cop.y + 1.45, gz = cop.z;
    let dx = this.px - gx, dy = this.py + 1.1 - gy, dz = this.pz - gz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const scatter = 0.055 + clamp(len / 400, 0, 0.06);
    dx += (Math.random() - 0.5) * scatter;
    dy += (Math.random() - 0.5) * scatter * 0.6;
    dz += (Math.random() - 0.5) * scatter;
    const inv = 1 / Math.hypot(dx, dy, dz);
    dx *= inv; dy *= inv; dz *= inv;

    const hit = this.combat.raycast(gx, gy, gz, dx, dy, dz, spec.range, this.peds.peds, cop, null);
    this.combat.tracer(gx, gy, gz, hit.x, hit.y, hit.z);
    this.combat.muzzleFlash(gx + dx * 0.5, gy + dy * 0.5, gz + dz * 0.5, 0.4);
    const vol = clamp(1 - len / 90, 0.1, 1);
    this.audio.gunshot(cop.swat ? 'ak47' : 'pistol', vol);

    // did that bullet pass through the player?
    const ex = this.px - gx, ey = this.py + 1.05 - gy, ez = this.pz - gz;
    const along = ex * dx + ey * dy + ez * dz;
    if (along > 0 && along < hit.dist + 0.4) {
      const lat = Math.hypot(ex - dx * along, ey - dy * along, ez - dz * along);
      if (lat < 0.42) this.damagePlayer(9 + Math.random() * 7, gx, gz, true);
    }
    if (hit.kind === 'ped' && hit.ped) {
      const died = this.peds.damage(hit.ped, spec.damage, gx, gz);
      this.combat.bloodBurst(hit.x, hit.y, hit.z, dx, 0.4, dz, 8);
      if (died) {
        this.combat.bloodPool(hit.ped.x, hit.ped.y, hit.ped.z, 1.6);
        this.audio.death();
      }
    } else if (hit.kind !== 'none') {
      this.combat.impact(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz);
    }
  }

  private damagePlayer(amount: number, fromX: number, fromZ: number, shake: boolean, from = 0): void {
    if (this.dead || this.invincible) return;
    if (from) {
      this.lastAttacker = from;
      this.lastAttackerT = this.elapsed;
    }
    if (this.armour > 0) {
      const absorbed = Math.min(this.armour, amount * 0.7);
      this.armour -= absorbed;
      amount -= absorbed;
    }
    this.health -= amount;
    this.flinch = 0.3;
    if (shake) this.rig.shake = Math.min(1.3, this.rig.shake + 0.35);
    if (this.health <= 0) this.die();
    void fromX; void fromZ;
  }

  private die(): void {
    this.health = 0;
    this.dead = true;
    this.deadT = 0;
    this.drownT = 0;
    // Only we can report our own death, so the room counts it exactly once however many
    // people were shooting. Credit expires so an old bullet cannot steal a road accident.
    if (this.net.online) {
      const fresh = this.elapsed - this.lastAttackerT < 6;
      this.net.sendKill(fresh ? this.lastAttacker : 0, 0);
    }
    this.lastAttacker = 0;
    this.audio.death();
    this.audio.engineOff();
    if (this.vehicle) {
      const v = this.vehicle;
      this.releaseCar();
      this.hero.root.removeFromParent();
      this.scene.add(this.hero.root);
      this.hero.root.position.set(v.x, v.y, v.z);
      v.isPlayer = false;
      v.ctrl.handbrake = true;
      this.vehicle = null;
    }
    this.combat.bloodPool(this.px, this.py, this.pz, 1.8);
    this.jobs?.end();
    setHud({ phase: 'dead', inVehicle: false, health: 0, drowning: 0 });
  }

  private busted(): void {
    this.bustedT = 0;
    this.setWanted(0);
    this.peds.removeCops();
    for (const v of [...this.traffic.cars]) if (v.siren && !v.isPlayer) this.traffic.remove(v);
    this.ops.clear();
    this.audio.sirenOff();
    const fine = Math.round(this.money * 0.25);
    this.money = Math.max(0, this.money - fine);
    const st = this.city.policeStation;
    this.teleport(st.x, st.z);
    this.toast(`BUSTED — Rs.${fine} fine`);
    setHud({ money: this.money, wanted: 0 });
  }

  private updateDead(dt: number): void {
    this.deadT += dt;
    poseHumanoid(this.hero, {
      dt, t: this.elapsed, speed: 0, runSpeed: RUN_SPEED, grounded: true, airVy: 0,
      aiming: false, aimPitch: 0, dead: Math.min(1, this.deadT * 1.5), seated: false,
      punch: 0, flinch: 0, steer: 0,
    });
    this.hero.root.position.set(this.px, this.py, this.pz);
    // pull the camera up and away
    this.rig.pitch = damp(this.rig.pitch, 0.9, 1.5, dt);
    this.rig.updateOnFoot(this.camera, dt, this.px, this.py, this.pz, false, 1, this.phys, this.settings);
    if (this.deadT > 4) this.respawn();
  }

  private respawn(): void {
    if (this.net.pvp) return this.respawnInMatch();
    const cost = Math.round(this.money * 0.1);
    this.money = Math.max(0, this.money - cost);
    this.health = 100;
    this.armour = 0;
    this.setWanted(0);
    this.dead = false;
    this.deadT = 0;
    this.crouching = false;
    this.speed = 0;
    this.drownT = 0;
    setHud({ drowning: 0 });
    this.peds.removeCops();
    for (const v of [...this.traffic.cars]) if (v.siren && !v.isPlayer) this.traffic.remove(v);
    this.ops.clear();
    this.audio.sirenOff();
    const h = this.city.hospital;
    this.teleport(h.x, h.z);
    this.hero.tilt.rotation.set(0, 0, 0);
    poseHumanoid(this.hero, {
      dt: 0.016, t: this.elapsed, speed: 0, runSpeed: RUN_SPEED, grounded: true, airVy: 0,
      aiming: false, aimPitch: 0, dead: 0, seated: false,
      crouching: false,
      punch: 0, flinch: 0, steer: 0,
    });
    this.toast(`Patched up at the clinic — Rs.${cost}`);
    setHud({ phase: 'playing', health: 100, money: this.money, wanted: 0 });
  }

  /**
   * Match respawn: no hospital bill, no wanted level, full health, and a spot away from
   * whoever just killed you. Charging a player money for losing a gunfight — and dropping
   * them back at the same clinic every time, where the winner is waiting — is what makes
   * a deathmatch on a free-roam map unplayable.
   */
  private respawnInMatch(): void {
    this.health = 100;
    this.armour = 0;
    this.setWanted(0);
    this.dead = false;
    this.deadT = 0;
    this.crouching = false;
    this.speed = 0;
    this.lastAttacker = 0;
    this.peds.removeCops();
    this.audio.sirenOff();
    const spot = this.matchSpawn();
    this.teleport(spot.x, spot.z);
    this.hero.tilt.rotation.set(0, 0, 0);
    poseHumanoid(this.hero, {
      dt: 0.016, t: this.elapsed, speed: 0, runSpeed: RUN_SPEED, grounded: true, airVy: 0,
      aiming: false, aimPitch: 0, dead: 0, seated: false,
      crouching: false,
      punch: 0, flinch: 0, steer: 0,
    });
    this.mag[this.weapon] = WEAPONS[this.weapon].mag;
    setHud({ phase: 'playing', health: 100, wanted: 0 });
  }

  /** The plaza or park furthest from the nearest enemy, so you do not spawn under fire. */
  private matchSpawn(): { x: number; z: number } {
    const spots = this.city.pois.length ? this.city.pois : [this.city.playerStart];
    let best = spots[0];
    let bestScore = -1;
    for (const s of spots) {
      let near = Infinity;
      for (const q of this.remotes.hitTargets()) {
        if (q.friendly) continue;
        near = Math.min(near, dist2(q.x, q.z, s.x, s.z));
      }
      if (near > bestScore) { bestScore = near; best = s; }
    }
    return best;
  }

  /** The POI the bridge registered, falling back to the middle of the channel. */
  private landmark(kind: Poi['kind']): { x: number; z: number } {
    const p = this.city.pois.find((q) => q.name === this.map.bridge)
      ?? this.city.pois.find((q) => q.kind === kind);
    return p ?? { x: 0, z: 0 };
  }

  /**
   * teleport(), but it takes whatever you are driving along with you — and points it.
   *
   * `faceX/faceZ` is what the warp is *for*: landing outside a garage still facing the
   * way you were driving five seconds ago means pressing W drives you away from it.
   */
  private warp(x: number, z: number, faceX?: number, faceZ?: number): void {
    const yaw = faceX === undefined || faceZ === undefined
      ? (this.vehicle ? this.vehicle.yaw : this.pyaw)
      : Math.atan2(faceX - x, faceZ - z);
    const v = this.vehicle;
    if (v) {
      placeVehicle(v, x, z, yaw);
      v.y = this.phys.groundHeight(x, z, v.spec.halfW, 3, false);
      v.speed = 0;
      v.vx = 0;
      v.vz = 0;
      updateVehicleBox(v);
    }
    this.pyaw = yaw;
    this.teleport(x, z);
    this.rig.reset(yaw, this.px, this.py, this.pz);
  }

  private teleport(x: number, z: number): void {
    this.px = x;
    this.pz = z;
    this.py = this.phys.groundHeight(x, z, PLAYER_R, 3);
    this.vx = 0; this.vz = 0; this.vy = 0;
    this.grounded = true;
    this.rig.reset(this.pyaw, x, this.py, z);
  }

  /* ── pickups, shops, objectives ───────────────────────────────────────── */

  private updateItems(dt: number, t: number): void {
    for (const it of this.items) {
      if (it.found) {
        if (it.anim < 1) {
          it.anim = Math.min(1, it.anim + dt * 1.6);
          it.group.position.y = it.y + it.anim * 1.8;
          it.group.scale.setScalar(Math.max(0.01, 1 - it.anim));
          if (it.anim >= 1) it.group.visible = false;
        }
        continue;
      }
      it.group.position.y = it.y + Math.sin(t * 2.2 + it.x) * 0.09;
      it.group.rotation.y += dt * 1.1;
      if (!this.vehicle && !this.dead && dist2(it.x, it.z, this.px, this.pz) < 1.6 && Math.abs(this.py - it.y) < 2.2) {
        it.found = true;
        this.found++;
        this.money += 250;
        this.audio.pickup();
        this.toast(`${it.name} found — Rs.250 from Mom`);
        this.pickWaypoint();
        setHud({ found: this.found, money: this.money });
        if (this.found >= this.items.length) {
          setHud({ phase: 'won' });
          this.setPaused(true);
        }
      }
    }

    for (const p of this.pickups) {
      if (p.taken) {
        p.respawn -= dt;
        if (p.respawn <= 0 && p.kind !== 'cash') {
          p.taken = false;
          p.group.visible = true;
        }
        continue;
      }
      p.group.rotation.y += dt * 1.6;
      if (this.dead) continue;
      if (dist2(p.x, p.z, this.px, this.pz) > 1.7) continue;
      p.taken = true;
      p.group.visible = false;
      p.respawn = 45;
      if (p.kind === 'cash') {
        this.money += p.value;
        this.audio.cash();
        this.toast(`+Rs.${p.value}`);
      } else if (p.kind === 'health') {
        this.health = Math.min(100, this.health + p.value);
        this.audio.pickup();
        this.toast(`+${p.value} health`);
      } else if (p.kind === 'armour') {
        this.armour = Math.min(100, this.armour + p.value);
        this.audio.pickup();
        this.toast(`+${p.value} armour`);
      } else {
        const target: WeaponId = this.weapon === 'fists' ? 'pistol' : this.weapon;
        this.reserve[target] = Math.min(WEAPONS[target].reserveMax, this.reserve[target] + p.value);
        this.audio.pickup();
        this.toast(`+${p.value} ${WEAPONS[target].name.toLowerCase()} ammo`);
      }
      setHud({
        money: this.money, health: Math.round(this.health),
        armour: Math.round(this.armour), reserve: this.reserve[this.weapon],
      });
    }
  }

  private pickWaypoint(): void {
    // A shift outranks Mom's list: while you are working, the arrow points at the fare.
    if (this.jobs?.active) {
      const d = Math.round(Math.hypot(this.jobs.targetX - this.px, this.jobs.targetZ - this.pz));
      this.waypoint = { x: this.jobs.targetX, z: this.jobs.targetZ };
      setHud({ objective: `${this.jobs.hud().text} — ${d}m` });
      return;
    }
    let best: MissionItem | null = null;
    let bd = Infinity;
    for (const it of this.items) {
      if (it.found) continue;
      const d = dist2(it.x, it.z, this.px, this.pz);
      if (d < bd) { bd = d; best = it; }
    }
    this.waypoint = best ? { x: best.x, z: best.z } : null;
    setHud({
      objective: best
        ? `Find the ${best.name} — ${Math.round(Math.sqrt(bd))}m`
        : 'Everything found — go home to Mom',
    });
  }

  private updateInteraction(): void {
    this.promptAction = null;
    let text = '';
    // Mid-move: no prompt, and no way to press E again and start a second one.
    if (this.carMove) {
      if (this.prompt !== '') { this.prompt = ''; setHud({ prompt: '' }); }
      this.input.consume('use');
      return;
    }
    // Sitting in a taxi, a cruiser or an ambulance: say so, rather than making the job
    // key something you have to read the manual to find.
    const jv = this.vehicle;
    if (jv && !this.dead) {
      const kind = jobFor(jv);
      if (this.jobs.active) {
        this.prompt = `${keyLabel(this.settings.binds.job[0])} — end the ${JOB_NAME[this.jobs.kind!].toLowerCase()} shift`;
        setHud({ prompt: this.prompt });
        return;
      }
      if (kind) {
        this.prompt = `${keyLabel(this.settings.binds.job[0])} — start ${JOB_NAME[kind].toLowerCase()}`;
        setHud({ prompt: this.prompt });
        return;
      }
    }

    if (this.interior) {
      const stand = nearestStand(this.interior.it, this.px, this.pz);
      if (stand) {
        text = `E — ${this.standLabel(stand)}`;
        this.promptAction = () => this.useStand(stand);
      } else if (this.interior.grace <= 0 && atDoor(this.interior.it, this.px, this.pz)) {
        text = 'E — step outside';
        this.promptAction = () => this.leaveInterior();
      }
    } else if (this.vehicle) {
      text = 'E — get out';
    } else if (!this.dead) {
      const v = this.traffic.nearest(this.px, this.pz, 3.6);
      const shop = this.nearestShop();
      const home = this.nearestHome();
      // Whichever is actually nearer, rather than a fixed order. A car parked across your
      // own front door used to win outright, so the door simply stopped working — which is
      // exactly where people park.
      const carD = v ? dist2(v.x, v.z, this.px, this.pz) : Infinity;
      const doorD = Math.min(
        shop ? dist2(shop.x, shop.z, this.px, this.pz) : Infinity,
        home ? dist2(home.x, home.z, this.px, this.pz) : Infinity,
      );
      if (v && Math.abs(v.speed) < 6 && carD <= doorD) {
        const isOccupied = v.ai !== null || v.driver !== null;
        text = isOccupied
          ? `E — hijack the ${v.spec.name.toLowerCase()}`
          : `E — drive the ${v.spec.name.toLowerCase()}`;
        this.promptAction = isOccupied
          ? () => this.hijackVehicle(v)
          : () => this.enterVehicle(v);
      } else if (shop && dist2(shop.x, shop.z, this.px, this.pz) <= doorD) {
        text = `E — go into ${shop.name}`;
        this.promptAction = () => this.enterInterior(shop.kind, shop.name);
      } else if (home) {
        const mine = dist2(home.x, home.z, this.city.playerStart.x, this.city.playerStart.z) < 1;
        text = mine ? 'E — go inside' : 'E — let yourself in';
        this.promptAction = () => this.enterInterior('home', mine ? 'HOME' : 'A HOUSE');
      }
    }

    if (this.promptAction && this.input.justPressed('use')) {
      this.input.consume('use');
      this.promptAction();
      this.promptAction = null;
    }
    if (text !== this.prompt) {
      this.prompt = text;
      setHud({ prompt: text });
    }
  }

  /**
   * Go to black, do the thing, come back.
   *
   * The swap happens at the halfway point, so the player never sees the room appear
   * around them — which, without it, is exactly what a teleport looks like.
   */
  private beginFade(go: () => void): void {
    if (this.fadeT > 0) return;
    this.fadeDur = 0.62;
    this.fadeT = this.fadeDur;
    this.fadeGo = go;
  }

  private updateFade(dt: number): void {
    if (this.fadeT <= 0) return;
    this.fadeT -= dt;
    const half = this.fadeDur / 2;
    if (this.fadeGo && this.fadeT <= half) { this.fadeGo(); this.fadeGo = null; }
    const k = this.fadeT > half
      ? (this.fadeDur - this.fadeT) / half
      : Math.max(0, this.fadeT) / half;
    setHud({ fade: clamp(k, 0, 1) });
    if (this.fadeT <= 0) { this.fadeT = 0; setHud({ fade: 0 }); }
  }

  /**
   * Where the player is *as far as the city is concerned*.
   *
   * Indoors that is the doorway they came in through, not the room six kilometres away.
   * The minimap and the police both want this one; the camera and the collision want the
   * real position.
   */
  private worldX(): number { return this.interior ? this.interior.outX : this.px; }
  private worldZ(): number { return this.interior ? this.interior.outZ : this.pz; }

  /** Walk into a room. Builds it the first time anyone opens that particular door. */
  private enterInterior(kind: InteriorKind, name: string): void {
    if (this.interior || this.vehicle || this.carMove) return;
    let it = this.interiors.get(kind);
    if (!it) {
      it = buildInterior(kind, this.mats, this.phys, this.scene);
      this.interiors.set(kind, it);
    }
    const room = it;
    const outX = this.px, outZ = this.pz, outYaw = this.pyaw;
    this.beginFade(() => {
      this.interior = { it: room, outX, outZ, outYaw, name, grace: 0.7 };
      this.px = room.entry.x;
      this.pz = room.entry.z;
      this.py = room.y;
      this.pyaw = room.entry.yaw;
      this.rig.yaw = room.entry.yaw;
      this.rig.pitch = 0;
      this.vx = 0; this.vz = 0; this.vy = 0;
      this.grounded = true;
      this.audio.carDoorOpen();
      setHud({ interior: name });
    });
  }

  /** Back out onto the pavement, where you were standing. */
  private leaveInterior(): void {
    const inside = this.interior;
    if (!inside || this.fadeT > 0) return;
    this.beginFade(() => {
      this.interior = null;
      this.px = inside.outX;
      this.pz = inside.outZ;
      this.py = this.phys.groundHeight(this.px, this.pz, PLAYER_R, 40);
      this.pyaw = inside.outYaw;
      this.rig.yaw = inside.outYaw;
      this.vx = 0; this.vz = 0; this.vy = 0;
      this.grounded = true;
      this.audio.carDoorSlam();
      setHud({ interior: '' });
    });
  }

  /** The prompt for one stand, with a live price where there is one worth reading. */
  private standLabel(s: Stand): string {
    if (s.action === 'ammo') {
      const spec = WEAPONS[s.arg as WeaponId];
      return `buy ${spec.ammoPack} ${spec.name} rounds (Rs.${spec.priceAmmo})`;
    }
    if (s.action === 'armour') return this.armour >= 100 ? 'body armour (full)' : 'buy body armour (Rs.100)';
    if (s.action === 'health') return this.health >= 100 ? `${s.label} (not hurt)` : `${s.label} (Rs.50)`;
    if (s.action === 'eat') return this.health >= 100 ? 'the fridge is for later' : 'eat something';
    return s.label;
  }

  /**
   * Use whatever you are stood in front of.
   *
   * Everything here routes to a method that already existed for the old full-screen shop
   * menu — the interiors change where you buy, not what buying does — except for the four
   * things you can only do at home.
   */
  private useStand(s: Stand): void {
    switch (s.action) {
      case 'ammo': this.buyAmmo(s.arg as WeaponId); break;
      case 'armour': this.buyArmour(); break;
      case 'health': this.buyHealth(); break;
      case 'menu': this.openShop(this.interior?.name ?? 'AMMU-NATION'); break;
      case 'sleep': this.sleepAtHome(); break;
      case 'eat':
        if (this.health >= 100) { this.audio.deny(); break; }
        this.health = Math.min(100, this.health + 35);
        this.audio.purchase();
        this.toast('Leftovers. +35 health');
        setHud({ health: this.health });
        break;
      case 'wardrobe': this.changeOutfit(); break;
      case 'tv':
        this.audio.ui();
        this.toast(pick(this.rng, [
          'The news is about the traffic on the canal bridge.',
          'A cricket highlights reel. Somebody drops a catch.',
          'An advert for a supermarket you have definitely robbed.',
          'The weather: hot, then hotter, then dust.',
        ]));
        break;
    }
  }

  /**
   * Sleep. Skips to eight in the morning, patches you up, and — this being the point of
   * having a bed in a GTA — is the one place the police give up on you for free.
   */
  private sleepAtHome(): void {
    this.beginFade(() => {
      this.startHour = 8;
      this.sky.setHour(8);
      this.health = 100;
      this.setWanted(0);
      this.peds.removeCops();
      this.ops.clear();
      this.audio.sirenOff();
      this.toast('Slept until morning. Health restored, and nobody is looking for you.');
      setHud({ health: this.health, wanted: 0 });
    });
  }

  /**
   * A different shirt.
   *
   * The colour is baked into the model — vertex colours on the capsule rig, a material
   * tint on the mannequin — so the only honest way to change it is to build a new one.
   * Whatever is being carried has to be re-hung on the new body afterwards, which is what
   * the re-parent loop is for.
   */
  private changeOutfit(): void {
    const shirt = OUTFITS[(this.outfitIdx = (this.outfitIdx + 1) % OUTFITS.length)];
    const old = this.hero;
    this.hero = createHumanoid({
      skin: SKINS[1], shirt, pants: shade(shirt, 0.88), hair: 0x1d130c, shoes: 0xb3352a, scale: 1,
    });
    this.hero.root.position.copy(old.root.position);
    this.hero.root.rotation.y = old.root.rotation.y;
    this.scene.add(this.hero.root);
    for (const id of WEAPON_ORDER) {
      const mdl = this.models[id];
      if (!mdl) continue;
      (mdl.pocket ? this.hero.rifleMount : this.hero.gunMount).add(mdl.group);
    }
    disposeHumanoid(old);
    this.setWeapon(this.weapon, true);
    this.audio.ui();
    this.toast('Changed your shirt');
  }

  /**
   * The nearest front door you could walk through.
   *
   * There used to be exactly one, at whichever plot the player spawned on, so every other
   * house on a street of a hundred was scenery. They all open now — the same room behind
   * each, which is how the shops work too.
   */
  private nearestHome(): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let bd = 3.4 * 3.4;
    for (const h of this.city.homes) {
      const d = dist2(h.x, h.z, this.px, this.pz);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  private nearestShop(): Shop | null {
    let best: Shop | null = null;
    let bd = 3.5 * 3.5;
    for (const s of this.city.shops) {
      const d = dist2(s.x, s.z, this.px, this.pz);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  openShop(name = 'AMMU-NATION'): void {
    this.input.releaseLock();
    setHud({ shopOpen: true, shopName: name });
  }

  closeShop(): void {
    setHud({ shopOpen: false });
    if (!this.paused && getHud().phase === 'playing') this.input.requestLock();
  }

  buyAmmo(id: WeaponId): boolean {
    const spec = WEAPONS[id];
    if (spec.melee || this.money < spec.priceAmmo) {
      this.audio.deny();
      return false;
    }
    this.money -= spec.priceAmmo;
    this.reserve[id] = Math.min(spec.reserveMax, this.reserve[id] + spec.ammoPack);
    this.audio.purchase();
    this.toast(`Purchased +${spec.ammoPack} ${spec.name} ammo`);
    setHud({ money: this.money, reserve: this.reserve[this.weapon] });
    return true;
  }

  buyAllAmmo(): boolean {
    if (this.money < 350) {
      this.audio.deny();
      return false;
    }
    this.money -= 350;
    for (const id of WEAPON_ORDER) {
      const spec = WEAPONS[id];
      if (!spec.melee) {
        this.reserve[id] = spec.reserveMax;
        this.mag[id] = spec.mag;
      }
    }
    this.audio.purchase();
    this.toast('All weapons fully reloaded & resupplied!');
    setHud({ money: this.money, mag: this.mag[this.weapon], reserve: this.reserve[this.weapon] });
    return true;
  }

  buyArmour(): boolean {
    if (this.money < 100 || this.armour >= 100) {
      this.audio.deny();
      return false;
    }
    this.money -= 100;
    this.armour = 100;
    this.audio.purchase();
    this.toast('Heavy Kevlar Body Armour equipped (+100 Armour)');
    setHud({ money: this.money, armour: this.armour });
    return true;
  }

  buyHealth(): boolean {
    if (this.money < 50 || this.health >= 100) {
      this.audio.deny();
      return false;
    }
    this.money -= 50;
    this.health = 100;
    this.audio.purchase();
    this.toast('Health restored to 100%');
    setHud({ money: this.money, health: this.health });
    return true;
  }

  /* ── cheat console ──────────────────────────────────────── */

  /**
   * Cheats are typed into a console, not blind into the world.
   *
   * Typing them blind is what a console-era GTA did because a controller has no letters.
   * On a keyboard every letter is already a gameplay bind — B and G and the number row
   * throw grenades and swap weapons — so spelling HESOYAM mid-game emptied a magazine
   * into a wall and never registered. The backtick key opens a prompt instead: gameplay
   * input is switched off, the pointer is released, and the code is submitted with Enter.
   */
  toggleConsole(open?: boolean): void {
    const want = open ?? !this.consoleOpen;
    if (want === this.consoleOpen) return;
    this.consoleOpen = want;
    // The world keeps rendering underneath; only the player's controls go away.
    this.input.enabled = !want;
    this.input.reset();
    setHud({ cheatConsoleOpen: want });
    if (want) this.input.releaseLock();
    else if (this.running && !this.paused && !this.mapOpen && !getHud().shopOpen) this.input.requestLock();
  }

  get cheatConsoleOpen(): boolean {
    return this.consoleOpen;
  }

  /** Every cheat, its aliases, and what it does. Also drives the in-console hint list. */
  private static readonly CHEATS: { codes: string[]; label: string; hint: string }[] = [
    { codes: ['HESOYAM', 'ASPIRINE'], label: 'HEALTH + ARMOUR + Rs.250,000', hint: 'patch up and get paid' },
    { codes: ['BAGUVIX', 'UNLIMITEDHEALTH'], label: 'UNLIMITED HEALTH', hint: 'nothing can hurt you' },
    { codes: ['FULLCLIP', 'NUTTERTOOLS', 'GUNSGUNSGUNS'], label: 'MAX AMMO, EVERY WEAPON', hint: 'fill every magazine' },
    { codes: ['LEAVEMEALONE', 'TURNDOWNTHEHEAT', 'LAWYERUP'], label: 'WANTED LEVEL CLEARED', hint: 'lose the police' },
    { codes: ['BRINGITON', 'MOREPOLICE'], label: 'FIVE-STAR WANTED LEVEL', hint: 'bring the police' },
    { codes: ['SPEEDFREAK', 'CATCHME'], label: 'SPEED FREAK', hint: 'run twice as fast' },
    { codes: ['PANZER', 'GIVEPOLICE'], label: 'POLICE CRUISER SPAWNED', hint: 'spawn a cruiser' },
    { codes: ['GETTHEREFAST', 'SPAWNSUPER'], label: 'HYPERCAR SPAWNED', hint: 'spawn a hypercar' },
    { codes: ['ROCKETMAN'], label: 'ROCKETMAN', hint: 'launch yourself' },
    { codes: ['BIGBANG', 'KILLALL'], label: 'BIG BANG', hint: 'blow up nearby traffic' },
    { codes: ['TIMEFLIES', 'CLOCKON'], label: 'TIME OF DAY ADVANCED', hint: 'skip six hours' },
    { codes: ['WALKONWATER', 'DRYDOCK'], label: 'DROWNING DISABLED', hint: 'survive the canal' },
    { codes: ['TAKEMETOTHEPUL', 'GOTOBRIDGE'], label: 'AT THE BRIDGE', hint: 'jump to the big bridge' },
    { codes: ['TAKEMEHOME', 'GOHOME'], label: 'BACK AT HOME', hint: 'jump to your front door' },
    { codes: ['TAKEMETOSPRAY', 'GOTOGARAGE'], label: "AT THE PAY 'N' SPRAY", hint: 'jump to a respray bay' },
    { codes: ['TAKEMETOSHOP', 'GOSHOPPING'], label: 'AT THE SHOP', hint: 'jump to the nearest shop' },
    { codes: ['SCATTERSTORM', 'MAKEITRAIN'], label: 'MONSOON', hint: 'bring the rain' },
    { codes: ['ANDYELLOWSKY', 'DUSTUP'], label: 'DUST HAZE', hint: 'bring the dust' },
    { codes: ['BLUESKIES', 'CLEARUP'], label: 'CLEAR SKIES', hint: 'clear the weather' },
    { codes: ['BULLETTIME', 'SLOWMO'], label: 'BULLET TIME', hint: 'slow the world down' },
    { codes: ['MOONJUMP', 'CHANDPAR'], label: 'MOON JUMP', hint: 'jump over a house' },
    { codes: ['INFINITEAMMO', 'NORELOAD'], label: 'INFINITE AMMO', hint: 'never reload again' },
    { codes: ['IRONFIST', 'SUPERPUNCH'], label: 'IRON FIST', hint: 'one-punch anybody' },
    { codes: ['STUNTMAN', 'ARMOURPLATE'], label: 'ARMOURED CAR', hint: 'your car stops breaking' },
    { codes: ['RIOTACT', 'EVERYONEHATESYOU'], label: 'RIOT', hint: 'turn the whole street on you' },
    { codes: ['CLEARTHEROAD', 'NOTRAFFIC'], label: 'ROAD CLEARED', hint: 'empty the streets' },
    { codes: ['RUSHHOUR', 'TRAFFICJAM'], label: 'RUSH HOUR', hint: 'fill the streets' },
    { codes: ['RANGBIRANGI', 'PIMPMYRIDE'], label: 'REPAINTED', hint: 'repaint every car in sight' },
    { codes: ['CHINGCHI', 'GIVERICKSHAW'], label: 'RICKSHAW SPAWNED', hint: 'spawn a rickshaw' },
    { codes: ['CARRYDABA', 'GIVEBOLAN'], label: 'CARRY DABA SPAWNED', hint: 'spawn a Carry Daba' },
    { codes: ['BEDFORDBLUES', 'GIVETRUCK'], label: 'BEDFORD TRUCK SPAWNED', hint: 'spawn a painted truck' },
    { codes: ['RAATHOGAYI', 'MIDNIGHT'], label: 'MIDNIGHT', hint: 'set the clock to 00:00' },
    { codes: ['DOPEHER', 'HIGHNOON'], label: 'HIGH NOON', hint: 'set the clock to 12:00' },
  ];

  /** The list the console shows when you have not typed anything yet. */
  static cheatHints(): { code: string; hint: string }[] {
    return Game.CHEATS.map((c) => ({ code: c.codes[0], hint: c.hint }));
  }

  /**
   * Run whatever was typed. Returns false for an unknown code so the console can say so
   * rather than silently swallowing a typo.
   */
  submitCheat(raw: string): boolean {
    const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) return false;
    const entry = Game.CHEATS.find((c) => c.codes.includes(code));
    if (!entry) {
      this.cheatMsgT = 2.4;
      setHud({ cheatMessage: `UNKNOWN CHEAT “${code}”` });
      return false;
    }
    let label = entry.label;
    switch (entry.codes[0]) {
      case 'HESOYAM':
        this.money += 250000;
        this.health = 100;
        this.armour = 100;
        if (this.vehicle) this.vehicle.health = 100;
        break;
      case 'BAGUVIX':
        this.invincible = !this.invincible;
        label = `UNLIMITED HEALTH ${this.invincible ? 'ON' : 'OFF'}`;
        break;
      case 'FULLCLIP':
        for (const id of WEAPON_ORDER) {
          const spec = WEAPONS[id];
          if (spec.melee) continue;
          this.reserve[id] = spec.reserveMax;
          this.mag[id] = spec.mag;
        }
        break;
      case 'LEAVEMEALONE':
        this.setWanted(0);
        this.wantedCool = 0;
        this.peds.removeCops();
        for (const c of [...this.traffic.cars]) if (c.siren && !c.isPlayer) this.traffic.remove(c);
        this.ops.clear();
        this.audio.sirenOff();
        break;
      case 'BRINGITON':
        // A cheat is instant: set the visible level, not just the target.
        this.setWanted(5);
        // Zero, not a large number: wantedCool counts *up* towards losing the police, so
        // the old value made the cheat start shedding stars the instant it was used.
        this.wantedCool = 0;
        break;
      case 'SPEEDFREAK':
        this.speedFreak = !this.speedFreak;
        label = `SPEED FREAK ${this.speedFreak ? 'ON' : 'OFF'}`;
        break;
      case 'PANZER': this.spawnCheatVehicle('police'); break;
      case 'GETTHEREFAST': this.spawnCheatVehicle('hyper'); break;
      case 'ROCKETMAN':
        this.vy += 22;
        this.grounded = false;
        this.crouching = false;
        this.audio.jump();
        break;
      case 'BIGBANG':
        for (const v of this.traffic.cars) {
          if (v.isPlayer || dist2(v.x, v.z, this.px, this.pz) > 45 * 45) continue;
          v.health = 0;
          this.combat.explode(v.x, v.y + 0.5, v.z, 100, 7);
          this.audio.explosion();
        }
        break;
      case 'TIMEFLIES':
        this.startHour = (this.startHour + 6) % 24;
        this.sky.setHour(this.startHour);
        label = `CLOCK SET TO ${String(Math.floor(this.startHour)).padStart(2, '0')}:00`;
        break;
      case 'SCATTERSTORM': this.weather.set('rain'); break;
      case 'ANDYELLOWSKY': this.weather.set('dust'); break;
      case 'BLUESKIES': this.weather.set('clear'); break;
      case 'WALKONWATER':
        this.waterproof = !this.waterproof;
        label = `DROWNING ${this.waterproof ? 'DISABLED' : 'ENABLED'}`;
        break;
      case 'BULLETTIME':
        this.timeScale = this.timeScale === 1 ? 0.38 : 1;
        label = `BULLET TIME ${this.timeScale === 1 ? 'OFF' : 'ON'}`;
        break;
      case 'MOONJUMP':
        this.lowGrav = !this.lowGrav;
        label = `MOON JUMP ${this.lowGrav ? 'ON' : 'OFF'}`;
        break;
      case 'INFINITEAMMO':
        this.infiniteAmmo = !this.infiniteAmmo;
        label = `INFINITE AMMO ${this.infiniteAmmo ? 'ON' : 'OFF'}`;
        break;
      case 'IRONFIST':
        this.ironFist = !this.ironFist;
        label = `IRON FIST ${this.ironFist ? 'ON' : 'OFF'}`;
        break;
      case 'STUNTMAN': {
        // Applies to every car you get into from here on, not just the one you are in.
        this.carArmour = !this.carArmour;
        for (const v of this.traffic.cars) if (v.isPlayer) v.armoured = this.carArmour;
        if (this.vehicle) this.vehicle.armoured = this.carArmour;
        label = `ARMOURED CAR ${this.carArmour ? 'ON' : 'OFF'}`;
        break;
      }
      case 'RIOTACT': {
        let n = 0;
        for (const p of this.peds.peds) {
          if (p.cop || p.state === 'dead') continue;
          if (dist2(p.x, p.z, this.px, this.pz) > 60 * 60) continue;
          this.peds.provoke(p, this.px, this.pz, 1);
          n++;
        }
        label = n ? `RIOT — ${n} ANGRY LOCALS` : 'NOBODY AROUND TO RIOT';
        break;
      }
      case 'CLEARTHEROAD':
        for (const v of [...this.traffic.cars]) {
          if (v.isPlayer || v === this.vehicle) continue;
          this.traffic.remove(v);
        }
        break;
      case 'RUSHHOUR':
        this.traffic.resizeLanes(MAX_SYNC_CARS);
        break;
      case 'RANGBIRANGI': {
        let n = 0;
        for (const v of this.traffic.cars) {
          if (dist2(v.x, v.z, this.px, this.pz) > 90 * 90) continue;
          paintVehicle(v, CHEAT_PAINT[(n++) % CHEAT_PAINT.length]);
        }
        label = `REPAINTED ${n} CARS`;
        break;
      }
      case 'CHINGCHI': this.spawnCheatVehicle('rickshaw'); break;
      case 'CARRYDABA': this.spawnCheatVehicle('carry'); break;
      case 'BEDFORDBLUES': this.spawnCheatVehicle('truck'); break;
      case 'RAATHOGAYI':
      case 'DOPEHER':
        this.startHour = entry.codes[0] === 'DOPEHER' ? 12 : 0;
        this.sky.setHour(this.startHour);
        break;
      case 'TAKEMETOSHOP': {
        // The counterpart to TAKEMETOSPRAY, and the same reasoning: the shops are spread
        // right across the city and the nearest one to where you start is 350m away, so
        // without this the only way to see the inside of one is a long walk.
        let shop = this.city.shops[0];
        let sd = Infinity;
        for (const s of this.city.shops) {
          const d = dist2(s.x, s.z, this.px, this.pz);
          if (d < sd) { sd = d; shop = s; }
        }
        if (!shop) { label = 'NO SHOPS ON THIS MAP'; break; }
        this.warp(shop.x, shop.z);
        label = `AT ${shop.name}`;
        break;
      }
      case 'TAKEMETOSPRAY': {
        // Just outside the bay, facing in, so the warp lands you on the forecourt rather
        // than inside the shop with the respray already triggered.
        let best = this.city.garages[0];
        let bd = Infinity;
        for (const g of this.city.garages) {
          const d = dist2(g.x, g.z, this.px, this.pz);
          if (d < bd) { bd = d; best = g; }
        }
        if (!best) { label = 'NO RESPRAY BAY ON THIS MAP'; break; }
        this.warp(best.x, best.z - 12, best.x, best.z);
        break;
      }
      case 'TAKEMETOTHEPUL':
      case 'TAKEMEHOME': {
        // Landmark warp. GTA has always had one, and on a map that is now most of a
        // kilometre end to end it is the difference between testing the bridge and
        // walking to it. The car, if you are in one, comes with you.
        const to = entry.codes[0] === 'TAKEMEHOME'
          ? this.city.playerStart
          : this.landmark(this.city.pois.length ? 'plaza' : 'home');
        this.warp(to.x, to.z);
        label = entry.codes[0] === 'TAKEMEHOME' ? 'BACK AT HOME' : `AT ${this.map.bridge}`;
        break;
      }
    }
    this.triggerCheat(label);
    return true;
  }

  private triggerCheat(name: string): void {
    this.cheatMsgT = 3.8;
    this.audio.cheat();
    setHud({
      cheatMessage: name,
      health: this.health,
      armour: this.armour,
      money: this.money,
      wanted: this.wanted,
      mag: this.mag[this.weapon],
      reserve: this.reserve[this.weapon],
    });
  }

  private spawnCheatVehicle(kind: VehKind): void {
    const yaw = this.rig.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const spawnX = this.px + fx * 5.5;
    const spawnZ = this.pz + fz * 5.5;
    const gy = this.phys.groundHeight(spawnX, spawnZ, 1.2, this.py + 0.8);
    const v = createVehicle(kind, 0xb8342a);
    placeVehicle(v, spawnX, spawnZ, yaw);
    v.y = gy;
    this.traffic.cars.push(v);
    this.scene.add(v.group);
  }

  /**
   * You rammed somebody. They stop, get out, and come and tell you about it.
   *
   * Rate-limited hard: a scrape in traffic bumps three cars in a second, and three
   * drivers all squaring up at once turns a fender-bender into a riot.
   */
  private roadRage(v: Vehicle): void {
    if (this.aggroCd > 0 || this.wanted >= 3) return;
    let hit: Vehicle | null = null;
    let bd = 7 * 7;
    for (const other of this.traffic.cars) {
      if (other === v || other.isPlayer || other.siren || !other.ai) continue;
      const d = dist2(other.x, other.z, v.x, v.z);
      if (d < bd) { bd = d; hit = other; }
    }
    if (!hit) return;
    this.aggroCd = 9;
    hit.ctrl.throttle = 0;
    hit.ctrl.handbrake = true;
    hit.ai = null;
    this.traffic.release(hit);
    const rx = rgtX(hit.yaw), rz = rgtZ(hit.yaw);
    const driver = this.peds.summonDriver(
      hit.x - rx * (hit.spec.halfW + 1.1), hit.z - rz * (hit.spec.halfW + 1.1), this.px, this.pz,
    );
    if (driver) {
      this.audio.carDoorSlam();
      this.peds.provoke(driver, v.x, v.z, 1);
    }
  }

  /* ── escalation, roadblocks and the helicopter ───────────────────── */

  private updateOps(dt: number, t: number): void {
    this.aggroCd = Math.max(0, this.aggroCd - dt);
    // Heading, so a roadblock lands in front of the player rather than behind them.
    let dirX = Math.sin(this.pyaw), dirZ = Math.cos(this.pyaw);
    const v = this.vehicle;
    if (v && Math.abs(v.speed) > 2) {
      const l = Math.hypot(v.vx, v.vz) || 1;
      dirX = v.vx / l;
      dirZ = v.vz / l;
    }
    this.ops.update(dt, t, this.wanted, this.px, this.py, this.pz, dirX, dirZ);
    this.audio.rotorLevel(dt, this.ops.rotorVolume);

    // Spikes only bite the car you are actually driving: shredding the tyres of forty
    // ambient cars a frame would be forty rect tests for something nobody would notice.
    if (v && this.ops.spikeHit(v)) {
      v.spikeT = 22;
      this.audio.crash(6);
      this.rig.shake = Math.min(1.1, this.rig.shake + 0.55);
      this.toast('TYRES SHREDDED');
    }
  }

  /* ── Pay 'n' Spray ───────────────────────────────────────── */

  /**
   * Drive a car into a bay and it comes out whole, a different colour and off the
   * police computer. The trigger is a distance test against a handful of bays, so a
   * garage costs three walls of geometry and nothing at runtime.
   */
  private updateGarage(dt: number): void {
    this.sprayCd = Math.max(0, this.sprayCd - dt);
    const v = this.vehicle;
    if (!v || this.sprayCd > 0 || Math.abs(v.speed) > 9) return;
    for (const g of this.city.garages) {
      if (dist2(g.x, g.z, v.x, v.z) > 4.2 * 4.2) continue;
      this.sprayCd = 12;
      v.health = 100;
      v.spikeT = 0;
      const colour = pick(this.rng, SPRAY_COLOURS);
      paintVehicle(v, colour.hex);
      const hadHeat = this.wanted > 0;
      if (hadHeat) {
        this.setWanted(0);
        this.wantedCool = 0;
        this.peds.removeCops();
        for (const c of [...this.traffic.cars]) if (c.siren && !c.isPlayer) this.traffic.remove(c);
        this.ops.clear();
        this.audio.sirenOff();
      }
      this.audio.purchase();
      this.toast(`Resprayed ${colour.name}${hadHeat ? ' · heat cleared' : ''}`);
      setHud({ wanted: this.wanted });
      return;
    }
  }

  /* ── wrecks ────────────────────────────────────────────── */

  /**
   * Cars that have taken enough of a beating catch fire and then go up.
   *
   * Nothing used to happen at all: collision damage and bullets both drove `health` down
   * and *nothing read it*, so a car could be rammed into a wall all day and drive off.
   * Now zero health kills the engine, black smoke pours out, and a few seconds later it
   * explodes — with the blast hurting whoever is standing near it, including the player
   * who is still sitting in the driving seat if they leave it too late.
   */
  private updateWrecks(dt: number): void {
    const cars = this.traffic.cars;
    for (let i = cars.length - 1; i >= 0; i--) {
      const v = cars[i];
      if (v.health > 0) {
        // a badly damaged car smokes without being written off yet
        if (v.health < 34 && this.rng() < 0.5) {
          this.combat.engineSmoke(v.x, v.y + 0.85, v.z, false);
        }
        continue;
      }
      if (v.burnT <= 0) {
        v.burnT = 3.4 + this.rng() * 2.2;
        v.siren = false;
        if (v === this.vehicle) this.toast('The engine is on fire — get out!');
        else if (dist2(v.x, v.z, this.px, this.pz) < 60 * 60) this.audio.crash(9);
      }
      v.burnT -= dt;
      this.combat.engineSmoke(v.x, v.y + 0.85, v.z, true);
      if (v.burnT > 0) continue;

      // and up it goes
      const wasMine = v === this.vehicle;
      if (wasMine) this.exitVehicle();
      this.combat.explode(v.x, v.y + 0.6, v.z, 150, 8.5);
      this.audio.explosion();
      this.peds.panic(v.x, v.z, 34, 8);
      if (dist2(v.x, v.z, this.px, this.pz) < 40 * 40) {
        this.rig.shake = Math.min(1.4, this.rig.shake + 0.8);
      }
      this.traffic.remove(v);
    }
  }

  /* ── water ────────────────────────────────────────────── */

  /**
   * The canal is a real hole in the world, so it needs a real consequence.
   *
   * Both banks are walled and railed, so getting in takes a ramp or a lot of commitment;
   * once you are in, the engine drowns — you are ejected from the car, and you have a few
   * seconds to be somewhere else before the hospital claims you. Dry beds (the desert
   * wadi) are just terrain, so they never appear in waterZones at all.
   */
  private updateDrowning(dt: number): void {
    const zones = this.city.waterZones;
    if (!zones.length || this.dead) {
      // Clear the HUD as well as the timer, or the warning bar stays up over WASTED.
      if (this.drownT > 0) { this.drownT = 0; setHud({ drowning: 0 }); }
      return;
    }
    const y = this.vehicle ? this.vehicle.y : this.py;
    let depth = 0;
    for (const w of zones) {
      if (this.px < w.minX || this.px > w.maxX || this.pz < w.minZ || this.pz > w.maxZ) continue;
      depth = Math.max(depth, w.surface - (y + 0.9));
    }
    if (depth <= 0) {
      if (this.drownT > 0) setHud({ drowning: 0 });
      this.drownT = 0;
      return;
    }

    this.drownT += dt;
    if (this.vehicle) {
      // A flooded engine does not run. Stall it, then bail the driver out.
      const v = this.vehicle;
      v.ctrl.throttle = 0;
      v.ctrl.brake = 0;
      v.speed *= Math.max(0, 1 - dt * 2.5);
      if (this.drownT > 1.1) {
        this.toast('The engine has flooded — get out!');
        this.exitVehicle();
      }
    }
    if (this.waterproof) return;
    setHud({ drowning: clamp(this.drownT / DROWN_SECONDS, 0, 1) });
    if (this.drownT > DROWN_SECONDS * 0.35) {
      this.damagePlayer(38 * dt, this.px, this.pz, false);
    }
  }

  /* ── vehicles vs people ───────────────────────────────────────────────── */

  private runOverCheck(dt: number): void {
    for (const v of this.traffic.cars) {
      if (Math.abs(v.speed) < 3) continue;
      for (const p of this.peds.peds) {
        if (p.state === 'dead') continue;
        if (dist2(p.x, p.z, v.x, v.z) > 3.2 * 3.2) continue;
        // rough OBB check
        const dx = p.x - v.x, dz = p.z - v.z;
        const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
        const along = dx * fx + dz * fz;
        const side = dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw);
        if (Math.abs(along) > v.spec.halfL + 0.35 || Math.abs(side) > v.spec.halfW + 0.3) continue;
        const dmg = Math.abs(v.speed) * 9;
        const died = this.peds.damage(p, dmg, v.x, v.z);
        this.combat.bloodBurst(p.x, p.y + 0.9, p.z, fx, 0.8, fz, 10);
        if (died) {
          this.combat.bloodPool(p.x, p.y, p.z, 2.2);
          this.audio.death();
          if (v.isPlayer) this.addWanted(p.cop ? CRIME.officerKilled : CRIME.civilianRunOver);
        } else if (v.isPlayer) this.addWanted(CRIME.pedestrianStruck);
        v.speed *= 0.86;
        this.peds.panic(p.x, p.z, 18, 6);
      }
      // cars vs the player on foot
      if (!this.vehicle && !this.dead && dist2(this.px, this.pz, v.x, v.z) < 3 * 3) {
        const dx = this.px - v.x, dz = this.pz - v.z;
        const along = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
        const side = dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw);
        if (Math.abs(along) < v.spec.halfL + 0.4 && Math.abs(side) < v.spec.halfW + 0.35) {
          this.damagePlayer(Math.abs(v.speed) * 5 * dt * 6, v.x, v.z, true);
          this.vx += Math.sin(v.yaw) * Math.abs(v.speed) * 0.3;
          this.vz += Math.cos(v.yaw) * Math.abs(v.speed) * 0.3;
          v.speed *= 0.9;
        }
      }
    }
    if (this.net.pvp && this.vehicle) this.runOverPlayers(dt);
  }

  /**
   * Running an opponent down. Reported the same way a bullet is, so it lands in the same
   * kill feed and the same score — a car is just a very blunt weapon.
   */
  private runOverPlayers(dt: number): void {
    const v = this.vehicle!;
    const speed = Math.abs(v.speed);
    if (speed < 4) return;
    for (const q of this.remotes.hitTargets()) {
      if (q.friendly) continue;
      const dx = q.x - v.x, dz = q.z - v.z;
      if (dx * dx + dz * dz > 9) continue;
      const along = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
      const side = dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw);
      if (Math.abs(along) > v.spec.halfL + 0.4 || Math.abs(side) > v.spec.halfW + 0.35) continue;
      this.net.sendHit(q.id, speed * 5 * dt * 6, HIT_VEHICLE);
      this.audio.bodyHit();
      v.speed *= 0.94;
    }
  }

  /* ── HUD + maps ───────────────────────────────────────────────────────── */

  private toast(msg: string): void {
    this.toastT = 2.6;
    setHud({ toast: msg });
  }

  private pushHud(dt: number): void {
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) setHud({ toast: '' });
    }

    this.radarTimer -= dt;
    if (this.radarTimer <= 0) {
      this.radarTimer = 1 / 25;
      this.buildEnts();
      if (this.radarCanvas) {
        const ctx = this.radarCanvas.getContext('2d');
        if (ctx) this.mapR.drawRadar(ctx, this.radarCanvas.width, this.worldX(), this.worldZ(), this.rig.yaw, this.ents);
      }
      if (this.mapOpen) this.drawMap();
    }

    this.hudTimer -= dt;
    if (this.hudTimer > 0) return;
    this.hudTimer = 0.1;
    const secs = Math.floor((performance.now() - this.startT) / 1000);
    const avg = this.frameTimes.length ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length : 0;
    setHud({
      health: Math.max(0, Math.round(this.health)),
      armour: Math.round(this.armour),
      money: this.money,
      wanted: Math.floor(this.wanted),
      mag: this.mag[this.weapon],
      reserve: this.reserve[this.weapon],
      speed: this.vehicle ? vehicleSpeedKmh(this.vehicle) : 0,
      inVehicle: !!this.vehicle,
      boost: this.vehicle ? this.vehicle.boost : 1,
      boosting: !!this.vehicle?.boosting,
      aiming: this.aiming,
      hitMarker: this.hitMarker,
      clock: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`,
      hour: Math.floor(this.sky.hour),
      fps: avg > 0 ? Math.round(1000 / Math.max(avg, 1)) : 0,
      drawCalls: this.renderer.info.render.calls,
      weather: this.weather.label(),
      lightning: this.weather.flash,
      // Stars flash while the police have lost sight of you — the signal that hiding is
      // working, without which "break line of sight" is an invisible mechanic.
      wantedFading: this.wanted > 0 && this.wantedCool > 1.5,
      spotted: this.ops.spotted,
      jobName: this.jobs.kind ? JOB_NAME[this.jobs.kind] : '',
      jobTimer: this.jobs.active ? Math.ceil(this.jobs.timer) : 0,
      jobStreak: this.jobs.streak,
      jobEarned: this.jobs.earned,
    });
    if (this.waypoint) this.pickWaypoint();
  }

  private buildEnts(): void {
    this.ents.length = 0;
    for (const p of this.peds.peds) {
      if (dist2(p.x, p.z, this.px, this.pz) > 160 * 160) continue;
      this.ents.push({ x: p.x, z: p.z, kind: p.state === 'dead' ? 'corpse' : p.cop ? 'cop' : 'ped' });
    }
    for (const v of this.traffic.cars) {
      if (v.isPlayer) continue;
      if (dist2(v.x, v.z, this.px, this.pz) > 200 * 200) continue;
      this.ents.push({ x: v.x, z: v.z, kind: v.siren ? 'copcar' : 'car' });
    }
    // Other players last, so they paint over the traffic rather than under it.
    this.remotes?.forEach((x, z, team) => {
      this.ents.push({
        x, z,
        kind: this.net.myTeam === TEAM_NONE ? 'player'
          : team === this.net.myTeam ? 'mate' : 'enemy',
      });
    });
    for (const s of this.city.shops) this.ents.push({ x: s.x, z: s.z, kind: 'shop' });
    for (const p of this.pickups) if (!p.taken) this.ents.push({ x: p.x, z: p.z, kind: 'pickup' });
    for (const it of this.items) if (!it.found) this.ents.push({ x: it.x, z: it.z, kind: 'objective' });
    if (this.jobs.active) this.ents.push({ x: this.jobs.targetX, z: this.jobs.targetZ, kind: 'objective' });
  }

  private drawMap(): void {
    if (!this.mapCanvas) return;
    const ctx = this.mapCanvas.getContext('2d');
    if (!ctx) return;
    this.mapR.drawFull(ctx, this.mapCanvas.width, this.mapCanvas.height, this.worldX(), this.worldZ(), this.rig.yaw, this.ents, this.waypoint);
  }

  /** Used by the pause menu so settings changes are audible/visible immediately. */
  previewSound(): void {
    this.audio.init();
    this.audio.setVolumes(this.settings.master, this.settings.sfx, this.settings.music);
    this.audio.ui();
  }

  getInput(): Input {
    return this.input;
  }
}

import * as THREE from 'three';
import { angleDamp, clamp, damp, dist2, fwdX, fwdZ, mulberry32, pick, rgtX, rgtZ, Rng, wrapPi } from './mathx';
import { KIND, Physics } from './physics';
import { buildMaterials, glowTexture, initTextures, Mats, updateFoliage } from './materials';
import { AssetBank } from './assets';
import { updateWater } from './water';
import { Sky } from './sky';
import { buildCity, City, LOT_Y, Shop } from './city';
import {
  createHumanoid, disposeHumanoid, Humanoid, poseHumanoid, setHumanoidDetail, SKINS,
} from './humanoid';
import { Ped, PedManager } from './peds';
import { initCharacters } from './characters';
import { Traffic } from './traffic';
import { Combat } from './combat';
import { CameraRig } from './camerarig';
import { GameAudio } from './audio';
import { MapEnt, MapRenderer } from './minimap';
import { getHud, setHud } from './hudstore';
import { QUALITY, QualityPreset, Settings } from './settings';
import { Input } from './input';
import { fetchOpenRooms, KillEvent, NetClient } from './netclient';
import { packFlags, RemotePlayers } from './remoteplayers';
import {
  HIT_HEAD, HIT_MELEE, HIT_VEHICLE, Hit as NetHit, MATCH_LIVE, MATCH_OVER, MatchState, MAX_SYNC_CARS,
  MODE_TDM, TEAM_A, TEAM_B, TEAM_NONE, VEH_KINDS, makeRoomCode, normaliseRoomCode,
} from './protocol';
import { createWeaponModel, WeaponId, WeaponModel, WEAPON_ORDER, WEAPONS } from './weapons';
import {
  CAR_COLOURS, initVehicleModels, placeVehicle, seatWorld, stepVehicle, updateVehicleBox, Vehicle,
  vehicleSpeedKmh,
} from './vehicle';

const WALK_SPEED = 2.3;
const CROUCH_SPEED = 1.35;
const RUN_SPEED = 6.1;
const AIM_SPEED = 1.5;
const PLAYER_R = 0.34;
const PLAYER_H = 1.78;
const STEP_UP = 0.45;
const GRAVITY = 17;
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
  private flinch = 0;
  private footPhase = 0;

  // weapons
  private weapon: WeaponId = 'fists';
  private models: Partial<Record<WeaponId, WeaponModel>> = {};
  private mag: Record<WeaponId, number> = { fists: 0, pistol: 12, smg: 0, shotgun: 0 };
  private reserve: Record<WeaponId, number> = { fists: 0, pistol: 36, smg: 0, shotgun: 0 };
  private owned: Record<WeaponId, boolean> = { fists: true, pistol: true, smg: false, shotgun: false };
  private fireCd = 0;
  private reloadT = 0;
  private aiming = false;
  private hitMarker = 0;
  private lastShotT = -99;

  // heat
  private wanted = 0;
  private wantedCool = 0;
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

    await step(30, 'surveying Rahim Garden City…');
    this.city = buildCity(this.scene, this.phys, this.mats, this.preset);
    this.mapR = new MapRenderer(this.city);

    await step(58, 'moving the neighbours in…');
    this.peds = new PedManager(this.scene, this.phys, this.city);
    this.peds.populate(this.preset.peds);

    await step(72, 'starting the traffic…');
    this.traffic = new Traffic(this.scene, this.city, this.phys);
    this.traffic.spawn(this.preset.traffic);
    this.traffic.spawnParked(Math.round(this.preset.traffic * 0.9));

    // seed the crowd and the traffic around where the player will actually start
    this.peds.streamTo(this.city.playerStart.x, this.city.playerStart.z, 95);
    this.traffic.streamTo(this.city.playerStart.x, this.city.playerStart.z, 170);

    await step(84, 'loading the guns…');
    this.remotes = new RemotePlayers(this.scene);
    this.net.onChange = () => this.onNetChange();
    // We own our own health, so damage arrives as a request and is applied here.
    this.net.onHit = (h) => this.takeNetHit(h);
    this.net.onKill = (e, killer, victim) => this.onNetKill(e, killer, victim);
    this.net.onMatch = (m, prev) => this.onMatchChange(m, prev);
    this.net.onClaim = (car, taken) => this.traffic.setClaimed(car, taken);
    this.combat = new Combat(this.scene, this.phys);
    this.combat.bloodEnabled = this.settings.blood;
    this.spawnPlayer();
    this.setWeapon('fists', true);

    await step(92, 'hiding Mom\'s things…');
    this.spawnItems();
    this.spawnPickups();

    await step(98, 'warming up the renderer…');
    this.renderer.compile(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);

    await step(100, 'ready');
    {
      const roadImg = this.mats.asphalt.map?.image as { constructor?: { name?: string } } | undefined;
      setHud({ loadMsg: `${this.bank.status()} · road=${roadImg?.constructor?.name ?? 'none'}` });  // TEMP DEBUG
    }
    setHud({
      phase: 'title', total: this.items.length, triangles: Math.round(this.city.triangles),
      money: this.money, health: 100,
    });

    this.input.attach();
    this.input.onLockChange = (locked) => {
      // Esc releases the pointer: treat that as "pause" so the player never loses control.
      if (!locked && this.running && !this.paused && getHud().phase === 'playing') this.setPaused(true);
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
      skin: SKINS[1], shirt: 0xf2c14e, pants: 0x2f4a6d, hair: 0x1d130c, shoes: 0xb3352a, scale: 1,
    });
    this.scene.add(this.hero.root);
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

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  start(): void {
    if (this.running || !this.traffic || !this.hero) return;
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

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    this.input.enabled = !p;
    setHud({ phase: p ? 'paused' : 'playing' });
    if (p) {
      this.audio.suspend();
      this.input.releaseLock();
    } else {
      this.audio.resume();
      this.input.requestLock();
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
    this.net.connect(code, name, { isPublic, mode });
    return code;
  }

  /**
   * Everyone must run the same number of ambient cars, because the host sends all of them
   * and the count cannot depend on one player's quality preset. Resizing here rather than
   * at load keeps single-player exactly as it was.
   */
  private goOnline(): void {
    this.traffic.resizeLanes(MAX_SYNC_CARS);
  }

  /** Returns false if the code could not possibly be a room code. */
  joinRoom(code: string, name: string): boolean {
    const clean = normaliseRoomCode(code);
    if (!clean) return false;
    this.goOnline();
    this.net.connect(clean, name);
    return true;
  }

  /** Drop into any public room with space; hosts a new public one if there are none. */
  async quickMatch(name: string): Promise<string> {
    const rooms = await fetchOpenRooms();
    const pick = rooms.find((r) => r.players < r.max);
    if (pick) {
      this.goOnline();
      this.net.connect(pick.code, name, { mode: pick.mode });
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
      this.wanted = 0;
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
    const dt = Math.min(raw, 0.05);
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

    if (this.settings.dayNight) {
      this.sky.setHour(9.5 + t / 90);   // a full day every 36 minutes
      this.city.setNight(this.sky.night);
      if (this.scene.environment) this.setEnvIntensity(this.sky.hour);
      if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(this.sky.fogColor());
    }

    if (this.dead) this.updateDead(dt);
    else if (this.vehicle) this.updateDriving(dt, t);
    else this.updateOnFoot(dt, t);

    this.updateWeapons(dt, t);
    this.updateHeat(dt);

    // world
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
    this.combat.update(dt);
    this.updateItems(dt, t);
    this.updateInteraction();

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
    const sprint = this.input.isDown('sprint') && !this.aiming;
    if (sprint || !this.grounded) {
      this.crouching = false;
    }

    const fwd = this.input.axis('back', 'forward');
    const strafe = this.input.axis('left', 'right');
    let wx = this.rig.forwardX() * fwd + this.rig.rightX() * strafe;
    let wz = this.rig.forwardZ() * fwd + this.rig.rightZ() * strafe;
    const l = Math.hypot(wx, wz);
    if (l > 1) { wx /= l; wz /= l; }

    const maxSpeed = this.crouching ? CROUCH_SPEED : this.aiming ? AIM_SPEED : sprint ? RUN_SPEED : WALK_SPEED;
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
      const B = this.city.bounds;
      this.px = clamp(this.phys.outX, B.minX, B.maxX);
      this.pz = clamp(this.phys.outZ, B.minZ, B.maxZ);
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
      this.vy -= GRAVITY * dt;
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
      aiming: this.aiming || (firing && this.weapon !== 'fists'),
      aimPitch: -this.rig.pitch, dead: 0, seated: false,
      crouching: this.crouching,
      punch: this.punchT > 0.22 ? 1 : 0, flinch: this.flinch, steer: 0,
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
    }

    stepVehicle(v, dt, this.phys);
    this.px = v.x;
    this.pz = v.z;
    this.py = v.y;
    this.audio.engineRpm(v.speed, v.spec.maxSpeed, c.throttle + (v.boosting ? 0.4 : 0));

    if (v.crashT > 0.3) {
      this.audio.crash(Math.abs(v.speed) + 6);
      this.rig.shake = Math.min(1.2, this.rig.shake + 0.5);
      this.damagePlayer(Math.min(14, Math.abs(v.speed) * 0.5), v.x, v.z, false);
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

  private enterVehicle(v: Vehicle): void {
    this.vehicle = v;
    v.isPlayer = true;
    v.ai = null;
    this.traffic.release(v);
    // Tell the room this car is ours: the host stops simulating and broadcasting it, and
    // everyone else drops their copy, so nobody sees two of the taxi we just stole.
    if (this.net.online && v.netId) {
      this.claimedCar = v.netId;
      this.traffic.setClaimed(v.netId, true);
      this.net.sendClaim(v.netId, true);
    }
    v.ctrl.handbrake = false;
    // seat the hero inside the body so they roll with the suspension
    this.hero.root.removeFromParent();
    v.bodyPivot.add(this.hero.root);
    this.hero.root.position.set(v.spec.seat[0], v.spec.seat[1] - 0.72, v.spec.seat[2]);
    this.hero.root.rotation.set(0, 0, 0);
    this.audio.engineOn();
    this.audio.ui();
    setHud({ inVehicle: true, vehicleName: v.spec.name, vehicleClass: v.spec.cls.toUpperCase() });
  }

  private exitVehicle(): void {
    const v = this.vehicle!;
    this.releaseCar();
    // Bailing out at speed is allowed — it just hurts. Blocking it instead made E look
    // broken whenever you were moving.
    const bail = Math.abs(v.speed) > 9;
    // look for a clear patch beside the car: left, right, then behind
    const rx = rgtX(v.yaw), rz = rgtZ(v.yaw);
    const fx = fwdX(v.yaw), fz = fwdZ(v.yaw);
    const cands: [number, number][] = [
      // driver's side first — right-hand drive, so that is the car's right
      [v.x + rx * (v.spec.halfW + 0.9), v.z + rz * (v.spec.halfW + 0.9)],
      [v.x - rx * (v.spec.halfW + 0.9), v.z - rz * (v.spec.halfW + 0.9)],
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
    this.px = spot[0];
    this.pz = spot[1];
    this.py = this.phys.groundHeight(this.px, this.pz, PLAYER_R, v.y + 1.5);
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
    }
    setHud({ inVehicle: false, vehicleName: '', vehicleClass: '', speed: 0, boosting: false });
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
        this.hero.gunMount.add(m.group);
      }
    }
    const m2 = this.models[id];
    if (m2) m2.group.visible = true;
    if (!silent) this.audio.ui();
    setHud({ weapon: id, mag: this.mag[id], reserve: this.reserve[id] });
  }

  private updateWeapons(dt: number, t: number): void {
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.hitMarker = Math.max(0, this.hitMarker - dt);

    if (this.input.justPressed('fists')) this.setWeapon('fists');
    if (this.input.justPressed('pistol')) this.setWeapon('pistol');
    if (this.input.justPressed('smg')) this.setWeapon('smg');
    if (this.input.justPressed('shotgun')) this.setWeapon('shotgun');

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

  private shoot(spec: typeof WEAPONS[WeaponId], t: number): void {
    if (this.mag[this.weapon] <= 0) {
      this.audio.dryFire();
      this.fireCd = 0.25;
      this.beginReload();
      return;
    }
    this.mag[this.weapon]--;
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
      this.combat.muzzleFlash(this.tmp2.x, this.tmp2.y, this.tmp2.z, this.weapon === 'shotgun' ? 0.8 : 0.55);
    } else {
      this.tmp2.set(ox, oy, oz);
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
      this.combat.tracer(this.tmp2.x, this.tmp2.y, this.tmp2.z, hit.x, hit.y, hit.z);

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
        // Report it and stop. Their client subtracts the health and decides if they die —
        // see the note on Hit in protocol.ts for why that is the only place it can happen.
        this.net.sendHit(hit.netId, spec.damage * (hit.head ? spec.headMult : 1), hit.head ? HIT_HEAD : 0);
        this.combat.bloodBurst(hit.x, hit.y, hit.z, -dx * inv, 0.4, -dz * inv, hit.head ? 14 : 9);
        this.audio.bodyHit();
      } else if (hit.kind === 'vehicle' && hit.veh) {
        hitAny = true;
        hit.veh.health -= spec.damage * 0.5;
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
    // gunfire in public is a crime, and everyone nearby knows it
    this.peds.panic(this.px, this.pz, 26, 7);
    // ...but not during a match. Being chased by the police for shooting the other team
    // turns a deathmatch into a police chase, which is a different game.
    if (!this.net.pvp) this.addWanted(killed ? 0 : 0.34);
  }

  private melee(t: number): void {
    const spec = WEAPONS.fists;
    this.fireCd = 60 / spec.rpm;
    this.punchT = 0.4;
    this.audio.punch();
    // A player in range beats a pedestrian: swinging at someone and connecting with the
    // civilian behind them is the single most annoying thing melee can do.
    if (this.net.pvp && this.meleePlayer(spec.range, spec.damage)) return;

    let best: Ped | null = null;
    let bd = spec.range * spec.range;
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;
      const d = dist2(p.x, p.z, this.px, this.pz);
      if (d > bd) continue;
      const ang = Math.abs(wrapPi(Math.atan2(p.x - this.px, p.z - this.pz) - this.rig.yaw));
      if (ang > 0.9) continue;
      bd = d;
      best = p;
    }
    if (!best) return;
    const died = this.peds.damage(best, spec.damage, this.px, this.pz);
    this.combat.bloodBurst(best.x, best.y + 1.4, best.z, Math.sin(this.rig.yaw), 0.6, Math.cos(this.rig.yaw), 4);
    this.audio.bodyHit();
    this.hitMarker = 0.2;
    if (died) this.onPedKilled(best);
    else this.addWanted(0.2);
    this.peds.panic(this.px, this.pz, 12, 5);
    void t;
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
    this.addWanted(p.cop ? 2.5 : 1.4);
    // civilians sometimes drop their wallet
    if (!p.cop && Math.random() < 0.45) {
      const cash = this.pickups.find((q) => q.taken && q.kind === 'cash');
      if (cash) {
        cash.taken = false;
        cash.x = p.x;
        cash.z = p.z;
        cash.value = 40 + Math.floor(Math.random() * 6) * 30;
        cash.group.position.set(p.x, p.y + 0.3, p.z);
        cash.group.visible = true;
      }
    }
  }

  /* ── police / wanted ──────────────────────────────────────────────────── */

  private addWanted(amount: number): void {
    if (amount <= 0) return;
    const before = Math.floor(this.wanted);
    this.wanted = clamp(this.wanted + amount, 0, 5);
    this.wantedCool = 0;
    if (Math.floor(this.wanted) > before) this.audio.wanted();
  }

  private updateHeat(dt: number): void {
    if (this.wanted > 0) {
      const seen = this.peds.nearestAlive(this.px, this.pz, 45, true);
      let visible = false;
      if (seen) {
        visible = this.phys.segmentClear(seen.x, seen.y + 1.5, seen.z, this.px, this.py + 1.2, this.pz) > 0.98;
      }
      this.wantedCool = visible ? 0 : this.wantedCool + dt;
      if (this.wantedCool > 14) {
        this.wanted = Math.max(0, this.wanted - dt * 0.16);
        if (this.wanted < 0.05) {
          this.wanted = 0;
          this.peds.removeCops();
          for (const v of [...this.traffic.cars]) if (v.kind === 'police' && !v.isPlayer) this.traffic.remove(v);
          this.audio.sirenOff();
          this.toast('You lost the cops');
        }
      }

      // spawn pressure scales with the star rating
      this.copTimer -= dt;
      const wantCops = Math.round(this.wanted * 1.6);
      if (this.copTimer <= 0 && this.peds.copCount() < wantCops) {
        this.copTimer = 3.5;
        this.spawnCopNearby();
      }
      const wantCars = this.wanted >= 2 ? Math.floor(this.wanted) - 1 : 0;
      const haveCars = this.traffic.cars.filter((v) => v.kind === 'police' && !v.isPlayer).length;
      if (haveCars < wantCars) this.spawnCopCar();

      // sirens
      const nearestCar = this.traffic.cars.find((v) => v.kind === 'police' && !v.isPlayer);
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

  private spawnCopNearby(): void {
    const nodes = this.city.nodes;
    for (let i = 0; i < 30; i++) {
      const n = pick(this.rng, nodes);
      const d = dist2(n.x, n.z, this.px, this.pz);
      if (d < 34 * 34 || d > 95 * 95) continue;
      this.peds.spawnPed(true, n.x, n.z);
      return;
    }
  }

  private spawnCopCar(): void {
    const nodes = this.city.nodes;
    for (let i = 0; i < 30; i++) {
      const n = pick(this.rng, nodes);
      const d = dist2(n.x, n.z, this.px, this.pz);
      if (d < 55 * 55 || d > 150 * 150) continue;
      const v = this.traffic.spawnPolice(n.x, n.z, Math.atan2(this.px - n.x, this.pz - n.z));
      updateVehicleBox(v);
      return;
    }
  }

  private copShoot(cop: Ped): void {
    const spec = WEAPONS.pistol;
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
    this.audio.gunshot('pistol', vol);

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
    if (this.dead) return;
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
    setHud({ phase: 'dead', inVehicle: false, health: 0 });
  }

  private busted(): void {
    this.bustedT = 0;
    this.wanted = 0;
    this.peds.removeCops();
    for (const v of [...this.traffic.cars]) if (v.kind === 'police' && !v.isPlayer) this.traffic.remove(v);
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
    this.wanted = 0;
    this.dead = false;
    this.deadT = 0;
    this.peds.removeCops();
    for (const v of [...this.traffic.cars]) if (v.kind === 'police' && !v.isPlayer) this.traffic.remove(v);
    this.audio.sirenOff();
    const h = this.city.hospital;
    this.teleport(h.x, h.z);
    this.hero.tilt.rotation.set(0, 0, 0);
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
    this.wanted = 0;
    this.dead = false;
    this.deadT = 0;
    this.lastAttacker = 0;
    this.peds.removeCops();
    this.audio.sirenOff();
    const spot = this.matchSpawn();
    this.teleport(spot.x, spot.z);
    this.hero.tilt.rotation.set(0, 0, 0);
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

    if (this.vehicle) {
      text = 'E — get out';
    } else if (!this.dead) {
      const v = this.traffic.nearest(this.px, this.pz, 3.6);
      const shop = this.nearestShop();
      if (v && Math.abs(v.speed) < 6) {
        text = `E — drive the ${v.spec.name.toLowerCase()}`;
        this.promptAction = () => this.enterVehicle(v);
      } else if (shop) {
        const price = shop.kind === 'ammo' ? 350 : 120;
        text = shop.kind === 'ammo'
          ? `E — buy ammo at ${shop.name} (Rs.${price})`
          : `E — eat at ${shop.name} (Rs.${price})`;
        this.promptAction = () => this.buy(shop, price);
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

  private nearestShop(): Shop | null {
    let best: Shop | null = null;
    let bd = 3 * 3;
    for (const s of this.city.shops) {
      const d = dist2(s.x, s.z, this.px, this.pz);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  private buy(shop: Shop, price: number): void {
    if (this.money < price) {
      this.audio.deny();
      this.toast(`Need Rs.${price}`);
      return;
    }
    this.money -= price;
    if (shop.kind === 'ammo') {
      // first purchase also unlocks the weapon
      if (!this.owned.smg && this.owned.pistol && this.reserve.pistol > 40) {
        this.owned.smg = true;
        this.reserve.smg = 90;
        this.mag.smg = WEAPONS.smg.mag;
        this.toast('SMG unlocked — press 3');
      } else if (!this.owned.shotgun && this.owned.smg && this.reserve.smg > 60) {
        this.owned.shotgun = true;
        this.reserve.shotgun = 24;
        this.mag.shotgun = WEAPONS.shotgun.mag;
        this.toast('Shotgun unlocked — press 4');
      } else {
        const w: WeaponId = this.weapon === 'fists' ? 'pistol' : this.weapon;
        this.reserve[w] = Math.min(WEAPONS[w].reserveMax, this.reserve[w] + WEAPONS[w].mag * 3);
        this.toast(`Ammo restocked — Rs.${price}`);
      }
      this.audio.reload();
    } else {
      this.health = Math.min(100, this.health + 45);
      this.audio.pickup();
      this.toast('Full and happy — +45 health');
    }
    setHud({ money: this.money, health: Math.round(this.health), reserve: this.reserve[this.weapon] });
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
          if (v.isPlayer) this.addWanted(p.cop ? 2.5 : 1.6);
        } else if (v.isPlayer) this.addWanted(0.6);
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
        if (ctx) this.mapR.drawRadar(ctx, this.radarCanvas.width, this.px, this.pz, this.rig.yaw, this.ents);
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
      this.ents.push({ x: v.x, z: v.z, kind: v.kind === 'police' ? 'copcar' : 'car' });
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
  }

  private drawMap(): void {
    if (!this.mapCanvas) return;
    const ctx = this.mapCanvas.getContext('2d');
    if (!ctx) return;
    this.mapR.drawFull(ctx, this.mapCanvas.width, this.mapCanvas.height, this.px, this.pz, this.rig.yaw, this.ents, this.waypoint);
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

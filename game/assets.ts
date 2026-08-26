import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Real-asset bank.
 *
 * The game was born 100% procedural, and everything procedural still exists as a
 * fallback: if any file here fails to download (offline dev, headless tests), the
 * game builds exactly as it did before. Files live in public/assets/ and are
 * shipped with the static export.
 *
 * All assets are CC0 (Poly Haven textures + HDRI, Quaternius models, Kenney /
 * OpenGameArt audio) — see docs/assets.md.
 */

export interface PbrSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap?: THREE.Texture;
}

/** Physical metres each downloaded texture covers, so repeats match real-world scale. */
const TEX_REPEAT: Record<string, number> = {
  asphalt_02: 1.5,
  concrete_pavement_02: 1,
  leafy_grass: 1.5,
  dirt: 1,
  brick_wall_09: 1.5,
  clay_roof_tiles_02: 1,
  metal_plate: 2,
  wood_planks: 1.5,
  plastered_wall_02: 1,
  plastered_wall_03: 1,
  plastered_wall_04: 1,
  painted_plaster_wall: 1,
  clay_plaster: 1,
  yellow_plaster: 1,
};

const HDRI_URL = '/assets/hdri/urban_street_01_2k.hdr';
const FILE_TIMEOUT_MS = 20000;

/** GLTF vehicle + character models, keyed by our class names. */
const MODEL_FILES: Record<string, string> = {
  sedan: 'sedan', hatch: 'hatch', suv: 'suv', police: 'police',
  sports: 'sports', muscle: 'muscle', hyper: 'hyper', character: 'character',
};

/** True only in a real browser context — Node (tests) skips all downloads. */
function canFetch(): boolean {
  return typeof window !== 'undefined' && typeof window.location?.href === 'string'
    && window.location.protocol.startsWith('http');
}

function withTimeout<T>(p: Promise<T>, ms = FILE_TIMEOUT_MS): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

export class AssetBank {
  readonly textures = new Map<string, PbrSet>();
  readonly models = new Map<string, THREE.Object3D>();
  private env: THREE.Texture | null = null;
  private loaded = false;

  get(id: string): PbrSet | undefined {
    return this.textures.get(id);
  }

  model(id: string): THREE.Object3D | undefined {
    return this.models.get(id);
  }

  /** Debug aid for the title screen. */
  status(): string {
    return `assets: ${this.textures.size}/${Object.keys(TEX_REPEAT).length} textures, `
      + `${this.models.size}/${Object.keys(MODEL_FILES).length} models, `
      + `hdri ${this.env ? 'ok' : 'MISSING'}`;
  }

  /**
   * Fetch every real asset. Never throws: missing files just stay procedural.
   * `onProgress` gets a 0..1 fraction for the loading screen.
   */
  async preload(onProgress?: (frac: number) => void, maxAniso = 4): Promise<void> {
    if (this.loaded || !canFetch()) return;
    this.loaded = true;

    const texLoader = new THREE.TextureLoader();
    const ids = Object.keys(TEX_REPEAT);
    const total = ids.length + 1 + Object.keys(MODEL_FILES).length;
    const jobs: Promise<void>[] = [];
    let done = 0;
    const bump = () => onProgress?.(++done / total);

    const load = async (url: string, srgb: boolean, aniso: number): Promise<THREE.Texture | null> => {
      const t = await withTimeout(texLoader.loadAsync(url));
      if (!t) return null;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = aniso;
      return t;
    };

    const aniso = maxAniso;
    for (const id of ids) {
      const r = TEX_REPEAT[id];
      jobs.push((async () => {
        const [map, normalMap, roughnessMap] = await Promise.all([
          load(`/assets/textures/${id}/${id}_diff_1k.jpg`, true, aniso),
          load(`/assets/textures/${id}/${id}_nor_gl_1k.jpg`, false, aniso),
          load(`/assets/textures/${id}/${id}_rough_1k.jpg`, false, aniso),
        ]);
        if (map && normalMap) {
          map.repeat.set(r, r);
          normalMap.repeat.set(r, r);
          roughnessMap?.repeat.set(r, r);
          this.textures.set(id, { map, normalMap, roughnessMap: roughnessMap ?? undefined });
        }
        bump();
      })());
    }

    jobs.push((async () => {
      const hdr = await withTimeout(new RGBELoader().loadAsync(HDRI_URL));
      if (hdr) this.env = hdr;
      bump();
    })());

    const gltf = new GLTFLoader();
    for (const [key, file] of Object.entries(MODEL_FILES)) {
      jobs.push((async () => {
        const g = await withTimeout(gltf.loadAsync(`/assets/models/${file}.glb`));
        if (g) {
          // The mixer needs the clips; stashed on the scene so the bank stays one map.
          g.scene.userData.clips = g.animations;
          this.models.set(key, g.scene);
        }
        bump();
      })());
    }

    await Promise.all(jobs);
  }

  /**
   * PMREM-processed environment for scene.environment (real reflections + ambient
   * light). Returns null when the HDRI is unavailable — caller keeps the old look.
   */
  environment(renderer: THREE.WebGLRenderer): THREE.Texture | null {
    if (!this.env) return null;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(this.env).texture;
    pmrem.dispose();
    return env;
  }
}

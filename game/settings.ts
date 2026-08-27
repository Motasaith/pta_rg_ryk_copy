/** Persisted player settings: quality presets, mouse feel, and full key rebinding. */

export type Quality = 'low' | 'medium' | 'high';

export interface QualityPreset {
  label: string;
  /** Hard cap on devicePixelRatio — the single biggest perf lever in a browser game. */
  pixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  shadowSize: number;
  /** Camera far plane + fog end. */
  drawDistance: number;
  peds: number;
  traffic: number;
  /** 1 = every prop slot filled, 2 = every other one. */
  propStep: number;
  clouds: number;
  /** Extra decorative detail (AC units, balconies, fences). */
  detail: boolean;
}

export const QUALITY: Record<Quality, QualityPreset> = {
  low: {
    label: 'Low — old laptops / integrated GPU',
    pixelRatio: 1, antialias: false, shadows: false, shadowSize: 1024,
    drawDistance: 340, peds: 8, traffic: 6, propStep: 2, clouds: 4, detail: false,
  },
  medium: {
    label: 'Medium — recommended',
    pixelRatio: 1.35, antialias: true, shadows: true, shadowSize: 1536,
    drawDistance: 520, peds: 16, traffic: 12, propStep: 1, clouds: 7, detail: true,
  },
  high: {
    label: 'High — desktop GPU',
    pixelRatio: 2, antialias: true, shadows: true, shadowSize: 2560,
    drawDistance: 760, peds: 26, traffic: 18, propStep: 1, clouds: 10, detail: true,
  },
};

export const ACTIONS = [
  'forward', 'back', 'left', 'right', 'sprint', 'jump', 'crouch', 'use', 'reload',
  'fists', 'knife', 'sword', 'pistol', 'smg', 'ak47', 'shotgun', 'sniper', 'rpg', 'minigun',
  'horn', 'map',
] as const;

export type Action = (typeof ACTIONS)[number];

export const ACTION_LABEL: Record<Action, string> = {
  forward: 'Move forward',
  back: 'Move back',
  left: 'Strafe left',
  right: 'Strafe right',
  sprint: 'Sprint / boost',
  jump: 'Jump / handbrake',
  crouch: 'Crouch / sit',
  use: 'Interact · enter/exit vehicle · open shop',
  reload: 'Reload',
  fists: '1: Fists',
  knife: '2: Combat Knife',
  sword: '3: Katana',
  pistol: '4: 9mm Pistol',
  smg: '5: Micro SMG',
  ak47: '6: AK-47',
  shotgun: '7: Pump Shotgun',
  sniper: '8: Sniper Rifle',
  rpg: '9: RPG-7',
  minigun: '0: Minigun',
  horn: 'Horn',
  map: 'Full map',
};

export type Binds = Record<Action, string[]>;

export const DEFAULT_BINDS: Binds = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  crouch: ['KeyC'],
  use: ['KeyE', 'KeyF'],
  reload: ['KeyR'],
  fists: ['Digit1'],
  knife: ['Digit2'],
  sword: ['Digit3'],
  pistol: ['Digit4'],
  smg: ['Digit5'],
  ak47: ['Digit6'],
  shotgun: ['Digit7'],
  sniper: ['Digit8'],
  rpg: ['Digit9'],
  minigun: ['Digit0'],
  horn: ['KeyH'],
  map: ['Tab', 'KeyM'],
};

export interface Settings {
  quality: Quality;
  /** Radians of yaw per pixel of mouse movement, before the 0.001 scale. */
  sensitivity: number;
  aimSensitivity: number;
  invertY: boolean;
  fov: number;
  /** Drop resolution automatically when the frame budget is blown. */
  adaptiveRes: boolean;
  master: number;
  sfx: number;
  music: number;
  blood: boolean;
  dayNight: boolean;
  showFps: boolean;
  cameraShake: boolean;
  binds: Binds;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium',
  sensitivity: 1,
  aimSensitivity: 0.62,
  invertY: false,
  fov: 62,
  adaptiveRes: true,
  master: 0.8,
  sfx: 0.9,
  music: 0.35,
  blood: true,
  dayNight: true,
  showFps: false,
  cameraShake: true,
  binds: DEFAULT_BINDS,
};

const KEY = 'rgc.settings.v1';

export function loadSettings(): Settings {
  if (typeof localStorage === 'undefined') return structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged: Settings = { ...structuredClone(DEFAULT_SETTINGS), ...parsed };
    // Never trust persisted binds: a missing action would break input silently.
    merged.binds = { ...structuredClone(DEFAULT_BINDS), ...(parsed.binds ?? {}) };
    return merged;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode — settings just won't persist */
  }
}

/** Turn a KeyboardEvent.code into something printable on a settings row. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5).toUpperCase();
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6);
  const map: Record<string, string> = {
    ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT', ControlLeft: 'L CTRL', ControlRight: 'R CTRL',
    AltLeft: 'L ALT', AltRight: 'R ALT', Space: 'SPACE', Tab: 'TAB', Escape: 'ESC',
    Enter: 'ENTER', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  };
  return map[code] ?? code.toUpperCase();
}

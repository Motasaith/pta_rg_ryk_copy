/**
 * Customisable touch layout — the PUBG-style "drag your buttons where you like" layer.
 *
 * Every action button gets a stable id (its label). A layout is a map from that id to a
 * position, stored as a fraction of the viewport so a layout saved on a 6" phone still
 * makes sense on a 7" tablet. Buttons with no entry fall back to their default slot, so
 * a layout saved before a new button shipped keeps working.
 *
 * The stick zone and the look zone are fixed: the stick floats wherever the thumb lands
 * and the look layer is the whole screen minus buttons, so there is nothing to place.
 */

/** Fractional position of one button: 0..1 of viewport width/height. */
export interface TouchPos {
  x: number;
  y: number;
}

/** id → position. Ids are the button labels ('FIRE', 'AIM', …). */
export type TouchLayout = Record<string, TouchPos>;

const KEY = 'rgc.touchlayout.v1';

/** Default positions, as fractions of the viewport. These mirror the old flex layout. */
export const DEFAULT_LAYOUT: TouchLayout = {
  // on foot
  FIRE: { x: 0.88, y: 0.78 },
  AIM: { x: 0.72, y: 0.86 },
  JUMP: { x: 0.88, y: 0.60 },
  E: { x: 0.72, y: 0.70 },
  R: { x: 0.72, y: 0.55 },
  C: { x: 0.60, y: 0.86 },
  // driving
  GAS: { x: 0.88, y: 0.78 },
  BRAKE: { x: 0.72, y: 0.86 },
  'H/B': { x: 0.88, y: 0.60 },
  NOS: { x: 0.72, y: 0.70 },
  HORN: { x: 0.72, y: 0.55 },
  JOB: { x: 0.60, y: 0.86 },
};

export function loadLayout(): TouchLayout {
  if (typeof localStorage === 'undefined') return structuredClone(DEFAULT_LAYOUT);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_LAYOUT);
    const parsed = JSON.parse(raw) as TouchLayout;
    // Merge over defaults: a stale or partial save keeps every button on screen.
    return { ...structuredClone(DEFAULT_LAYOUT), ...parsed };
  } catch {
    return structuredClone(DEFAULT_LAYOUT);
  }
}

export function saveLayout(l: TouchLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* private mode — the layout just won't persist */
  }
}

export function resetLayout(): TouchLayout {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
  return structuredClone(DEFAULT_LAYOUT);
}
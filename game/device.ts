/**
 * What kind of machine are we on, and what can we make its screen do?
 *
 * The short answer on orientation, because it drives the whole mobile design: **a web
 * page cannot rotate a phone.** `screen.orientation.lock()` throws unless the document is
 * already fullscreen, and iOS Safari does not implement it at all. So the only honest
 * approach is the one every browser game uses:
 *
 *   1. lay the game out for landscape;
 *   2. on the Play tap — which is a user gesture, and the lock needs one — go fullscreen
 *      and *try* to lock;
 *   3. when that fails, put a "rotate your device" gate over the top until they do.
 *
 * Step 3 is not a fallback for old browsers. It is the iPhone path, permanently.
 */

/** A phone or tablet: no hover, coarse pointer. Not just "has a touchscreen". */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
}

export function isPortrait(): boolean {
  if (typeof window === 'undefined') return false;
  return innerHeight > innerWidth;
}

/** Roughly: is this a small screen that needs the compact HUD? */
export function isSmallScreen(): boolean {
  if (typeof window === 'undefined') return false;
  return Math.min(innerWidth, innerHeight) < 560;
}

interface LockableOrientation extends ScreenOrientation {
  lock?: (o: string) => Promise<void>;
}

interface FullscreenEl extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
}

/**
 * Go fullscreen and ask for landscape. Never throws: on iOS both halves are expected to
 * fail, and the rotate gate covers it.
 *
 * Must be called straight from a tap handler — both APIs require a user gesture, and a
 * promise chain that awaits anything first will have lost it.
 */
export async function enterLandscape(el: HTMLElement): Promise<boolean> {
  const target = el as FullscreenEl;
  try {
    if (!document.fullscreenElement) {
      if (target.requestFullscreen) await target.requestFullscreen({ navigationUI: 'hide' });
      else if (target.webkitRequestFullscreen) await target.webkitRequestFullscreen();
    }
  } catch {
    /* refused: we can still play, just not fullscreen */
  }
  try {
    const o = screen.orientation as LockableOrientation | undefined;
    if (o?.lock) {
      await o.lock('landscape');
      return true;
    }
  } catch {
    /* iOS, or the user has rotation locked in Control Centre */
  }
  return false;
}

export function exitFullscreen(): void {
  try {
    if (document.fullscreenElement) void document.exitFullscreen();
  } catch {
    /* nothing to undo */
  }
}

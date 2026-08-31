import { Action, Binds } from './settings';

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * Keyboard + mouse input.
 *
 * Two rules that the previous version got wrong:
 *  - mouse look is *delta* based and only consumed while the pointer is locked, so the
 *    camera never jumps when the cursor re-enters the window;
 *  - deltas are accumulated between frames and drained once per update, so a 240Hz mouse
 *    and a 60Hz update loop produce exactly the same turn rate.
 */
export class Input {
  private down = new Set<string>();
  private edge = new Set<string>();
  private capture: ((code: string) => void) | null = null;

  /* ── touch layer ──────────────────────────────────────────────────────────
     On a phone there is no keyboard and no pointer lock, so the on-screen pad
     writes into a parallel set of "virtual" presses and an analog stick. Every
     query below unions the two, which means the whole engine — walking,
     driving, shooting, the lot — is completely unaware it is being played with
     thumbs. */

  /** True once any touch has been seen: the UI switches to the on-screen pad. */
  touch = false;
  /** Analog stick, each −1..1. Zero when nothing is held. */
  stickX = 0;
  stickY = 0;
  private vDown = new Set<Action>();
  private vEdge = new Set<Action>();

  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  /** [left, middle, right] */
  buttons: [boolean, boolean, boolean] = [false, false, false];
  buttonEdge: [boolean, boolean, boolean] = [false, false, false];
  locked = false;
  /** Set false while a menu is open: movement stops, but the DOM keeps working. */
  enabled = true;

  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(
    private el: HTMLElement,
    public binds: Binds,
  ) {}

  attach(): void {
    addEventListener('keydown', this.onKeyDown, { passive: false });
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);
    addEventListener('mousemove', this.onMouseMove);
    addEventListener('mousedown', this.onMouseDown);
    addEventListener('mouseup', this.onMouseUp);
    this.el.addEventListener('wheel', this.onWheel, { passive: false });
    this.el.addEventListener('contextmenu', this.onContext);
    document.addEventListener('pointerlockchange', this.onLockEvent);
  }

  detach(): void {
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    removeEventListener('blur', this.onBlur);
    removeEventListener('mousemove', this.onMouseMove);
    removeEventListener('mousedown', this.onMouseDown);
    removeEventListener('mouseup', this.onMouseUp);
    this.el.removeEventListener('wheel', this.onWheel);
    this.el.removeEventListener('contextmenu', this.onContext);
    document.removeEventListener('pointerlockchange', this.onLockEvent);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.capture) {
      e.preventDefault();
      const cb = this.capture;
      this.capture = null;
      cb(e.code);
      return;
    }
    // Stop the browser stealing Tab/Space/arrows mid-game.
    if (this.enabled && ['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
    if (e.repeat) return;
    this.down.add(e.code);
    this.edge.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  private onBlur = () => {
    this.reset();
  };

  /**
   * Forget every held key and button.
   *
   * Called when control is handed to something that types — the cheat console, a menu —
   * because those keystrokes never produce a matching keyup for the game, and a key stuck
   * "down" is a character who walks into a wall the moment you close the console.
   */
  reset(): void {
    this.down.clear();
    this.edge.clear();
    this.buttons = [false, false, false];
    this.buttonEdge = [false, false, false];
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked || !this.enabled) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private onMouseDown = (e: MouseEvent) => {
    if (!this.locked || !this.enabled) return;
    const b = e.button === 2 ? 2 : e.button === 1 ? 1 : 0;
    if (!this.buttons[b]) this.buttonEdge[b] = true;
    this.buttons[b] = true;
  };

  private onMouseUp = (e: MouseEvent) => {
    const b = e.button === 2 ? 2 : e.button === 1 ? 1 : 0;
    this.buttons[b] = false;
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.wheel += Math.sign(e.deltaY);
  };

  private onContext = (e: Event) => e.preventDefault();

  private onLockEvent = () => {
    this.locked = document.pointerLockElement === this.el;
    if (!this.locked) {
      this.down.clear();
      this.buttons = [false, false, false];
    }
    this.onLockChange?.(this.locked);
  };

  requestLock(): void {
    const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.el) document.exitPointerLock();
  }

  /** Used by the settings screen: the next key pressed is reported instead of acted on. */
  beginCapture(cb: (code: string) => void): void {
    this.capture = cb;
  }

  cancelCapture(): void {
    this.capture = null;
  }

  /** Hold or release an on-screen button. */
  setVirtual(a: Action, down: boolean): void {
    if (down) {
      if (!this.vDown.has(a)) this.vEdge.add(a);
      this.vDown.add(a);
    } else {
      this.vDown.delete(a);
    }
  }

  /** Fire a single on-screen press, for buttons that are taps rather than holds. */
  tapVirtual(a: Action): void {
    this.vEdge.add(a);
  }

  /** Look, from a drag. Bypasses the pointer lock, which touch never has. */
  look(dx: number, dy: number): void {
    if (!this.enabled) return;
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  /** Fire / aim, from the on-screen triggers. */
  setButton(i: 0 | 1 | 2, down: boolean): void {
    if (down && !this.buttons[i]) this.buttonEdge[i] = true;
    this.buttons[i] = down;
  }

  /** Called by the pad when the first touch arrives, so the UI can switch modes. */
  markTouch(): void {
    this.touch = true;
  }

  /** Let go of everything the pad was holding — on pause, or when it unmounts. */
  clearVirtual(): void {
    this.vDown.clear();
    this.vEdge.clear();
    this.stickX = 0;
    this.stickY = 0;
    this.buttons = [false, false, false];
  }

  isDown(a: Action): boolean {
    if (!this.enabled) return false;
    if (this.vDown.has(a)) return true;
    const codes = this.binds[a];
    for (let i = 0; i < codes.length; i++) if (this.down.has(codes[i])) return true;
    return false;
  }

  justPressed(a: Action): boolean {
    if (!this.enabled) return false;
    if (this.vEdge.has(a)) return true;
    const codes = this.binds[a];
    for (let i = 0; i < codes.length; i++) if (this.edge.has(codes[i])) return true;
    return false;
  }

  /**
   * Swallow this frame's press so a single tap cannot be acted on twice.
   *
   * The frame runs several independent handlers (driving, then world interaction), and the
   * key edge lives until endFrame(). Without consuming it, tapping E in a car exits the
   * vehicle and the interaction pass immediately puts you back in it.
   */
  consume(a: Action): void {
    this.vEdge.delete(a);
    for (const code of this.binds[a]) this.edge.delete(code);
  }

  /**
   * Keys give −1, 0 or 1. The stick gives everything in between, and wins when it is
   * being held — which is what lets a thumb feather the steering instead of slamming it
   * lock to lock, without a single line of the driving code knowing about touch.
   */
  axis(neg: Action, pos: Action): number {
    const keys = (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0);
    if (!this.enabled) return 0;
    const analog = pos === 'right' ? this.stickX : pos === 'forward' ? this.stickY : 0;
    if (analog !== 0) return clampUnit(analog + keys);
    return keys;
  }

  /** Call once at the very end of a frame. */
  endFrame(): void {
    this.edge.clear();
    this.vEdge.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.buttonEdge = [false, false, false];
  }
}

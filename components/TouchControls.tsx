'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Action } from '@/game/settings';
import { Input } from '@/game/input';
import { HudState } from '@/game/hudstore';
import { WEAPONS, WEAPON_ORDER } from '@/game/weapons';

/**
 * The on-screen pad.
 *
 * It owns no game state. Every control writes into the same `Input` the keyboard writes
 * into — a virtual key set and an analog stick — so walking, driving, aiming and shooting
 * all run the identical code paths they do on a desktop. The engine never learns that it
 * is being played with thumbs.
 *
 * Two deliberate choices, both borrowed from how console-to-mobile ports actually work:
 *
 *  · **The stick floats.** Its centre is wherever your thumb first lands inside the
 *    bottom-left zone, not a painted circle you have to find. On a phone you cannot see
 *    your thumb, so a fixed stick means constantly re-finding it.
 *  · **Sprint is automatic** past 85% deflection, and there is no separate sprint button.
 *    A button you have to hold with the same thumb that is steering is a button nobody
 *    presses.
 */

/** How much camera rotation one CSS pixel of drag is worth. */
const LOOK_SCALE = 1.35;
/** Radius of full stick deflection, in CSS pixels. */
const STICK_R = 52;

interface Btn {
  a: Action | null;
  label: string;
  /** big round primary action */
  kind?: 'fire' | 'aim' | 'go' | 'stop' | 'plain';
  /** fires once on tap instead of being held */
  tap?: boolean;
  /** mouse button index, for fire/aim */
  mouse?: 0 | 2;
}

const ON_FOOT: Btn[] = [
  { a: null, label: 'FIRE', kind: 'fire', mouse: 0 },
  { a: null, label: 'AIM', kind: 'aim', mouse: 2 },
  { a: 'jump', label: 'JUMP' },
  { a: 'use', label: 'E', tap: true },
  { a: 'reload', label: 'R', tap: true },
  { a: 'crouch', label: 'C', tap: true },
];

const DRIVING: Btn[] = [
  { a: 'forward', label: 'GAS', kind: 'go' },
  { a: 'back', label: 'BRAKE', kind: 'stop' },
  { a: 'jump', label: 'H/B' },
  { a: 'sprint', label: 'NOS' },
  { a: 'use', label: 'E', tap: true },
  { a: 'horn', label: 'HORN' },
  { a: 'job', label: 'JOB', tap: true },
];

export function TouchControls({
  hud, input, onPause, onMap, onCheats,
}: {
  hud: HudState;
  input: Input | null;
  onPause: () => void;
  onMap: () => void;
  onCheats: () => void;
}) {
  const [stick, setStick] = useState<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [guns, setGuns] = useState(false);
  const stickId = useRef<number | null>(null);
  const lookId = useRef<number | null>(null);
  const lookAt = useRef({ x: 0, y: 0 });
  // Read through a ref, not the closure: the stick handler is created once, and a
  // stale `inVehicle` would fire the nitrous every time you took a hard corner.
  const driving = useRef(false);
  driving.current = hud.inVehicle;

  // Never leave a key stuck down because a finger left the screen during a pause.
  useEffect(() => () => input?.clearVirtual(), [input]);
  useEffect(() => {
    if (hud.phase !== 'playing') {
      input?.clearVirtual();
      setStick(null);
      stickId.current = null;
      lookId.current = null;
    }
  }, [hud.phase, input]);

  /**
   * Track a drag on `window` rather than with `setPointerCapture`.
   *
   * Capture is the tidier API and it is what a mouse wants, but on touch it throws
   * InvalidStateError often enough to matter — and a stick that dies the first time your
   * thumb leaves the zone is worse than no stick. Window listeners work everywhere and
   * keep following the finger off the edge of the screen.
   */
  const drag = useCallback((
    id: number, onMove: (e: PointerEvent) => void, onEnd: () => void,
  ) => {
    const move = (e: PointerEvent) => { if (e.pointerId === id) onMove(e); };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      onEnd();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  }, []);

  /* ── movement stick ─────────────────────────────────────────── */
  const stickDown = useCallback((e: React.PointerEvent) => {
    if (!input || stickId.current !== null) return;
    e.preventDefault();
    input.markTouch();
    const id = e.pointerId;
    const ox = e.clientX, oy = e.clientY;
    stickId.current = id;
    setStick({ x: 0, y: 0, ox, oy });

    drag(id, (ev) => {
      let dx = ev.clientX - ox;
      let dy = ev.clientY - oy;
      const len = Math.hypot(dx, dy);
      if (len > STICK_R) { dx = (dx / len) * STICK_R; dy = (dy / len) * STICK_R; }
      input.stickX = dx / STICK_R;
      input.stickY = -dy / STICK_R;             // screen-down is backwards
      // Full deflection is a run. On foot only: in a car `sprint` is the nitrous, and
      // spending it on every hard turn is not what the thumb meant.
      input.setVirtual('sprint',
        !driving.current && Math.hypot(input.stickX, input.stickY) > 0.85);
      setStick({ x: dx, y: dy, ox, oy });
    }, () => {
      stickId.current = null;
      input.stickX = 0;
      input.stickY = 0;
      input.setVirtual('sprint', false);
      setStick(null);
    });
  }, [input, drag]);

  /* ── look ─────────────────────────────────────────────────── */
  const lookDown = useCallback((e: React.PointerEvent) => {
    if (!input || lookId.current !== null) return;
    e.preventDefault();
    input.markTouch();
    const id = e.pointerId;
    lookId.current = id;
    lookAt.current = { x: e.clientX, y: e.clientY };
    drag(id, (ev) => {
      input.look((ev.clientX - lookAt.current.x) * LOOK_SCALE, (ev.clientY - lookAt.current.y) * LOOK_SCALE);
      lookAt.current = { x: ev.clientX, y: ev.clientY };
    }, () => {
      lookId.current = null;
    });
  }, [input, drag]);

  /* ── buttons ────────────────────────────────────────────────────────────── */
  const press = useCallback((b: Btn, down: boolean) => {
    if (!input) return;
    input.markTouch();
    if (b.mouse !== undefined) { input.setButton(b.mouse, down); return; }
    if (!b.a) return;
    if (b.tap) { if (down) input.tapVirtual(b.a); return; }
    input.setVirtual(b.a, down);
  }, [input]);

  /**
   * Hold a button. The release is tracked on `window`, not on the button, so sliding a
   * thumb off the edge of FIRE stops firing instead of leaving the trigger jammed down.
   */
  const holdDown = useCallback((b: Btn, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    press(b, true);
    if (b.tap) return;
    drag(e.pointerId, () => {}, () => press(b, false));
  }, [press, drag]);

  if (hud.phase !== 'playing') return null;
  const set = hud.inVehicle ? DRIVING : ON_FOOT;

  return (
    <div className="touch">
      {/* look: everything on the right that is not a button */}
      <div className="tlook" onPointerDown={lookDown} />

      {/* movement */}
      <div className="tstickzone" onPointerDown={stickDown}>
        {stick && (
          <div className="tstick" style={{ left: stick.ox, top: stick.oy }}>
            <i style={{ transform: `translate(${stick.x}px, ${stick.y}px)` }} />
          </div>
        )}
      </div>

      {/* utility row */}
      <div className="tutil">
        <button type="button" onPointerDown={onPause} aria-label="Pause">II</button>
        <button type="button" onPointerDown={onMap} aria-label="Map">MAP</button>
        <button type="button" onPointerDown={onCheats} aria-label="Cheats">☰</button>
        {!hud.inVehicle && (
          <button
            type="button"
            className={guns ? 'on' : ''}
            onPointerDown={() => setGuns((g) => !g)}
            aria-label="Weapons"
          >
            {WEAPONS[hud.weapon].name.split(' ')[0].slice(0, 5)}
          </button>
        )}
      </div>

      {/* weapon wheel, opened from the utility row so it is never in the way */}
      {guns && !hud.inVehicle && (
        <div className="tguns">
          {WEAPON_ORDER.map((w) => (
            <button
              key={w}
              type="button"
              className={w === hud.weapon ? 'on' : ''}
              onPointerDown={(e) => {
                e.stopPropagation();
                input?.tapVirtual(w as Action);
                setGuns(false);
              }}
            >
              {WEAPONS[w].name}
            </button>
          ))}
        </div>
      )}

      {/* actions */}
      <div className="tbtns">
        {set.map((b) => (
          <button
            key={b.label}
            type="button"
            className={`tbtn ${b.kind ?? 'plain'}`}
            onPointerDown={(e) => holdDown(b, e)}
            onContextMenu={(e) => e.preventDefault()}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

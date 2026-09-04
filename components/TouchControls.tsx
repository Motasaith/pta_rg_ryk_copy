'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Action } from '@/game/settings';
import { Input } from '@/game/input';
import { HudState } from '@/game/hudstore';
import { WEAPONS, WEAPON_ORDER } from '@/game/weapons';
import {
  DEFAULT_LAYOUT, loadLayout, saveLayout, TouchLayout,
} from '@/game/touchlayout';
import { findTouch, fromPointer, fromTouch, Grab, grabKey as key } from '@/game/touchinput';

/**
 * The on-screen pad.
 *
 * It owns no game state. Every control writes into the same `Input` the keyboard writes
 * into — a virtual key set and an analog stick — so walking, driving, aiming and shooting
 * all run the identical code paths they do on a desktop. The engine never learns that it
 * is being played with thumbs.
 *
 * Three deliberate choices, all borrowed from how console-to-mobile ports actually work:
 *
 *  · **The stick floats.** Its centre is wherever your thumb first lands inside the
 *    bottom-left zone, not a painted circle you have to find. On a phone you cannot see
 *    your thumb, so a fixed stick means constantly re-finding it.
 *  · **Sprint is automatic** past 85% deflection, and there is no separate sprint button.
 *    A button you have to hold with the same thumb that is steering is a button nobody
 *    presses.
 *  · **Look is the whole screen.** The look layer sits *under* the buttons, and a drag
 *    that starts on a button is re-routed to look once it moves further than a tap
 *    threshold. That is how every mobile shooter works: the FIRE button is also a look
 *    surface, so you can swipe to track a target without lifting the thumb that fires.
 *    Without it, running (left thumb) + looking (right thumb) dies the moment the right
 *    thumb lands on a button — which is most of the right half of the screen.
 *
 * The layout is customisable, PUBG-style: tap EDIT in the utility row, drag any button
 * anywhere, tap SAVE. Positions persist as viewport fractions, so a layout saved on one
 * phone survives a different screen size.
 */

/** How much camera rotation one CSS pixel of drag is worth. */
const LOOK_SCALE = 2.1;
/** Radius of full stick deflection, in CSS pixels. */
const STICK_R = 52;
/** A drag must move this many CSS pixels before it counts as look, not a tap. */
const TAP_SLOP = 9;

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
  const [layout, setLayout] = useState<TouchLayout>(() => loadLayout());
  const [editing, setEditing] = useState(false);
  // Tagged "<family>:<id>", because a touch identifier and a pointerId are different
  // number spaces and 0 in one is not 0 in the other.
  const stickId = useRef<string | null>(null);
  const lookId = useRef<string | null>(null);
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
      setGuns(false);
      setEditing(false);
      stickId.current = null;
      lookId.current = null;
    }
  }, [hud.phase, input]);

  /**
   * One pointer, whichever family of events delivered it.
   *
   * Chrome on Android hands a touch to a PointerEvent listener with **clientX and
   * clientY of zero** while the TouchEvent for the very same tap carries the real
   * coordinates. That is why the stick jumped to the top-left corner and walking did
   * nothing: the stick was being drawn at (0, 0) because that is genuinely what the
   * pointer event said. So touch is read from touch events, which every mobile browser
   * agrees on, and pointer events are kept for the mouse.
   */
  /**
   * Follow one finger (or the mouse) on `window` until it lifts.
   *
   * Window listeners rather than `setPointerCapture`, which throws InvalidStateError on
   * touch often enough to matter, and which would in any case stop following a thumb
   * that slides off the edge of the screen.
   */
  const drag = useCallback((
    g: Grab, onMove: (x: number, y: number) => void, onEnd: () => void,
  ) => {
    if (g.kind === 'touch') {
      const move = (e: TouchEvent) => {
        const t = findTouch(e.touches, g.id);
        if (t) onMove(t.clientX, t.clientY);
      };
      const end = (e: TouchEvent) => {
        if (!findTouch(e.changedTouches, g.id)) return;
        removeEventListener('touchmove', move);
        removeEventListener('touchend', end);
        removeEventListener('touchcancel', end);
        onEnd();
      };
      // passive: touch-action:none already stops the browser scrolling, so there is
      // nothing to preventDefault and a passive listener is cheaper.
      addEventListener('touchmove', move, { passive: true });
      addEventListener('touchend', end);
      addEventListener('touchcancel', end);
      return;
    }
    const move = (e: PointerEvent) => { if (e.pointerId === g.id) onMove(e.clientX, e.clientY); };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== g.id) return;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      onEnd();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  }, []);

  /* ── movement stick ───────────────────────────────────── */
  const startStick = useCallback((g: Grab) => {
    if (!input || stickId.current !== null) return;
    input.markTouch();
    const ox = g.x, oy = g.y;
    stickId.current = key(g);
    setStick({ x: 0, y: 0, ox, oy });

    drag(g, (cx, cy) => {
      let dx = cx - ox;
      let dy = cy - oy;
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

  /* ── look ────────────────────────────────────────────── */
  const startLook = useCallback((g: Grab) => {
    if (!input || lookId.current !== null) return;
    input.markTouch();
    lookId.current = key(g);
    lookAt.current = { x: g.x, y: g.y };
    drag(g, (cx, cy) => {
      input.look((cx - lookAt.current.x) * LOOK_SCALE, (cy - lookAt.current.y) * LOOK_SCALE);
      lookAt.current = { x: cx, y: cy };
    }, () => {
      lookId.current = null;
    });
  }, [input, drag]);

  /**
   * Touch wins when both families fire.
   *
   * A touch produces a touchstart *and* a pointerdown. Acting on both would start two
   * drags for one thumb, so once a real touch has been seen the pointer path is only
   * ever a mouse — and on a phone it never runs again.
   */
  const usingTouch = useRef(false);
  const stickTouch = useCallback((e: React.TouchEvent) => {
    usingTouch.current = true;
    startStick(fromTouch(e));
  }, [startStick]);
  const stickPointer = useCallback((e: React.PointerEvent) => {
    if (usingTouch.current || e.pointerType === 'touch') return;
    e.preventDefault();
    startStick(fromPointer(e));
  }, [startStick]);
  const lookTouch = useCallback((e: React.TouchEvent) => {
    usingTouch.current = true;
    startLook(fromTouch(e));
  }, [startLook]);
  const lookPointer = useCallback((e: React.PointerEvent) => {
    if (usingTouch.current || e.pointerType === 'touch') return;
    e.preventDefault();
    startLook(fromPointer(e));
  }, [startLook]);

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
   * Hold a button — and let a drag that grows beyond the tap slop become a look.
   *
   * The release is tracked on `window`, not on the button, so sliding a thumb off the
   * edge of FIRE stops firing instead of leaving the trigger jammed down.
   *
   * The look hand-off is what makes "run and look" work: the right thumb starts on FIRE
   * (the biggest target on the screen), swipes to track, and the camera follows — the
   * button releases the moment the drag takes over. A tap that never leaves the slop
   * radius stays a tap, so quick single shots still fire.
   */
  const holdDown = useCallback((b: Btn, g: Grab) => {
    if (editing) return;                       // in edit mode buttons are drag handles
    press(b, true);
    if (b.tap) return;
    const sx = g.x, sy = g.y;
    let handedOff = false;
    // This finger's own look origin. Not the shared lookAt, so a thumb that swipes off
    // FIRE and a thumb already looking elsewhere do not overwrite each other's origin —
    // their deltas simply add, which is what two thumbs looking together should do.
    let lx = 0, ly = 0;
    drag(g, (cx, cy) => {
      if (!handedOff) {
        if (Math.hypot(cx - sx, cy - sy) <= TAP_SLOP) return;
        handedOff = true;
        press(b, false);                      // the drag owns this finger now
        lx = cx;
        ly = cy;
        return;                               // this frame only sets the origin
      }
      input?.look((cx - lx) * LOOK_SCALE, (cy - ly) * LOOK_SCALE);
      lx = cx;
      ly = cy;
    }, () => {
      if (!handedOff) press(b, false);
    });
  }, [press, drag, editing, input]);

  /* ── layout editor ────────────────────────────────────────────────────────
     PUBG-style: while editing, every button is a drag handle. Positions are stored
     as viewport fractions so they survive rotation and different screens. */
  const editDown = useCallback((label: string, g: Grab) => {
    drag(g, (cx, cy) => {
      setLayout((l) => ({
        ...l,
        [label]: {
          x: Math.min(0.97, Math.max(0.03, cx / innerWidth)),
          y: Math.min(0.97, Math.max(0.03, cy / innerHeight)),
        },
      }));
    }, () => {});
  }, [drag]);

  const btnStart = useCallback((b: Btn, g: Grab) => {
    if (editing) editDown(b.label, g);
    else holdDown(b, g);
  }, [editing, editDown, holdDown]);
  const btnTouch = useCallback((b: Btn, e: React.TouchEvent) => {
    e.stopPropagation();
    usingTouch.current = true;
    btnStart(b, fromTouch(e));
  }, [btnStart]);
  const btnPointer = useCallback((b: Btn, e: React.PointerEvent) => {
    if (usingTouch.current || e.pointerType === 'touch') return;
    e.preventDefault();
    e.stopPropagation();
    btnStart(b, fromPointer(e));
  }, [btnStart]);

  const finishEditing = useCallback((save: boolean) => {
    setEditing(false);
    if (save) saveLayout(layout);
    else setLayout(loadLayout());
  }, [layout]);

  if (hud.phase !== 'playing') return null;
  const set = hud.inVehicle ? DRIVING : ON_FOOT;

  return (
    <div className={`touch${editing ? ' editing' : ''}`}>
      {/* look: the whole screen, *under* the buttons. A swipe that starts on a
          button is handed to look once it passes the tap slop (see holdDown). */}
      <div className="tlook" onPointerDown={lookPointer} onTouchStart={lookTouch} />

      {/* movement */}
      <div className="tstickzone" onPointerDown={stickPointer} onTouchStart={stickTouch}>
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
        <button
          type="button"
          className={editing ? 'on' : ''}
          onPointerDown={() => setEditing((v) => !v)}
          aria-label="Edit layout"
        >
          EDIT
        </button>
      </div>

      {/* edit-mode banner: the game keeps running, but taps are all layout moves */}
      {editing && (
        <div className="teditbar">
          <span>DRAG BUTTONS TO MOVE THEM</span>
          <button type="button" onPointerDown={() => finishEditing(true)}>SAVE</button>
          <button type="button" onPointerDown={() => setLayout(structuredClone(DEFAULT_LAYOUT))}>RESET</button>
          <button type="button" onPointerDown={() => finishEditing(false)}>CANCEL</button>
        </div>
      )}

      {/* weapon wheel, opened from the utility row so it is never in the way */}
      {guns && !hud.inVehicle && !editing && (
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

      {/* actions — absolutely positioned from the saved layout, so each one can
          live anywhere the player wants it. */}
      {set.map((b) => {
        const p = layout[b.label] ?? DEFAULT_LAYOUT[b.label] ?? { x: 0.8, y: 0.8 };
        return (
          <button
            key={b.label}
            type="button"
            className={`tbtn ${b.kind ?? 'plain'}`}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            onPointerDown={(e) => btnPointer(b, e)}
            onTouchStart={(e) => btnTouch(b, e)}
            onContextMenu={(e) => e.preventDefault()}
          >
            {b.label}
          </button>
        );
      })}
    </div>
  );
}

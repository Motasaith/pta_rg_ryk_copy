/**
 * Normalising a finger, whichever family of events delivered it.
 *
 * This exists because of a concrete Chrome-on-Android behaviour: a touch delivered to a
 * **PointerEvent** listener arrives with `clientX` and `clientY` of **zero**, while the
 * **TouchEvent** for the very same tap carries the real coordinates. A pad that trusted
 * the pointer event drew its stick at (0, 0) — the top-left corner of the screen — and
 * the player could not walk. Opera Mobile does not do it, which is exactly the kind of
 * difference that makes this worth pinning down in a test rather than in a comment.
 *
 * So: touch is read from touch events, and pointer events are kept for the mouse.
 *
 * Typed structurally rather than against React or the DOM, so the rules can be tested in
 * plain Node with no browser and no framework.
 */

/** One pointer: which family it came from, its id within that family, and where it is. */
export interface Grab {
  kind: 'touch' | 'pointer';
  id: number;
  x: number;
  y: number;
}

export interface PointerLike {
  pointerId: number;
  clientX: number;
  clientY: number;
  pointerType?: string;
}

export interface TouchPointLike {
  identifier: number;
  clientX: number;
  clientY: number;
}

export interface TouchLike {
  changedTouches: ArrayLike<TouchPointLike>;
}

export function fromPointer(e: PointerLike): Grab {
  return { kind: 'pointer', id: e.pointerId, x: e.clientX, y: e.clientY };
}

/**
 * Always `changedTouches[0]` — a TouchEvent has no clientX of its own, and the finger
 * that just changed is the one that started this drag.
 */
export function fromTouch(e: TouchLike): Grab {
  const t = e.changedTouches[0];
  return { kind: 'touch', id: t.identifier, x: t.clientX, y: t.clientY };
}

/**
 * A touch identifier and a pointerId are different number spaces: finger 0 and mouse 0
 * are not the same thing. Tag the family before comparing, or releasing the mouse would
 * end the stick drag a thumb was holding.
 */
export function grabKey(g: Grab): string {
  return `${g.kind}:${g.id}`;
}

/** Find the live touch matching a grab, from a TouchList. Null once the finger has gone. */
export function findTouch(list: ArrayLike<TouchPointLike>, id: number): TouchPointLike | null {
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
  return null;
}

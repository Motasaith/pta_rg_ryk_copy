import { fwdX, fwdZ, lerp, rgtX, rgtZ, smoothstep, wrapPi } from './mathx';

/**
 * Getting in and out of a car.
 *
 * Pressing E used to teleport you: one frame stood on the pavement, the next sitting in
 * the driver's seat with the engine running, and on the way out the reverse. It read as a
 * bug rather than as an action, and it is the thing people notice first because it is the
 * thing they do most.
 *
 * So it is a move now, with two legs each way — step to the door, then climb in — and the
 * geometry of it lives here rather than in the engine, because "which side is the door
 * on" and "where exactly does the hand-off happen" are the parts that are easy to get
 * subtly wrong and easy to check.
 *
 * Everything is plain numbers on purpose: no Vector3, no scene graph, so the test can
 * walk the whole move frame by frame and assert it never jumps.
 */

/** Seconds spent climbing in, once at the door. */
export const CLIMB_IN = 0.62;

/**
 * How long the walk to the door takes, for a door that far away.
 *
 * Proportional rather than fixed, because the prompt reaches 3.6m: covering that in a
 * flat third of a second is 10 m/s, which is not a step to the car, it is a lunge. 4 m/s
 * is a jog, which is what you do towards a car you are about to steal, and short
 * distances still close almost instantly.
 */
export function stepTime(dist: number): number {
  return Math.min(0.9, Math.max(0.1, dist / 4));
}

export function enterTime(stepT: number): number {
  return stepT + CLIMB_IN;
}

/** Getting out is quicker than getting in, the way it is in life. */
export const CLIMB_OUT = 0.42;
export const STEP_OUT = 0.22;
export const EXIT_TIME = CLIMB_OUT + STEP_OUT;

export interface Spot { x: number; z: number }

export interface MovePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** 0..1, how far into a duck. Peaks halfway through the climb, which is the pose. */
  crouch: number;
}

/**
 * Which side of the car the driver's door is on, as +1 for the car's right.
 *
 * Read off where the seat actually is in the model rather than assumed, and the sign is
 * genuinely confusing: `rgt(yaw)` is (−cos, sin), so a mesh group rotated by the car's yaw
 * has its **local +X pointing to the car's left**. Every seat in `SPECS` sits at a negative
 * x, which therefore puts the driver on the right — right-hand drive, as Pakistan is. Get
 * this backwards and the player walks round to the passenger door of their own car, which
 * is exactly what the first version of this did.
 */
export function driverSide(seatX: number): number {
  return seatX > 0.02 ? -1 : 1;
}

/**
 * Where you stand to open the door: beside the car, level with the seat, far enough out
 * that the body is not inside the door skin.
 */
export function doorPoint(
  carX: number, carZ: number, yaw: number, halfW: number, seatZ: number, side: number,
): Spot {
  const fx = fwdX(yaw), fz = fwdZ(yaw);
  const rx = rgtX(yaw), rz = rgtZ(yaw);
  const out = halfW + 0.52;
  return {
    x: carX + fx * seatZ + rx * out * side,
    z: carZ + fz * seatZ + rz * out * side,
  };
}

/** The heading that faces the car from outside it, standing on `side`. */
export function facingCar(yaw: number, side: number): number {
  return wrapPi(yaw - side * Math.PI / 2);
}

/** Shortest-way angle blend, so nobody spins 350° to turn 10°. */
function turn(a: number, b: number, k: number): number {
  return a + wrapPi(b - a) * k;
}

/**
 * Where the player is `t` seconds into getting in.
 *
 * Two legs. The first walks them to the door and turns them to face the car; the second
 * lifts and slides them into the seat, turning to the car's own heading. The duck peaks
 * in the middle of the second leg, which is what makes it read as climbing in rather than
 * as being winched.
 */
export function enterPose(
  t: number,
  from: MovePose,
  door: Spot,
  groundY: number,
  seat: { x: number; y: number; z: number },
  carYaw: number,
  side: number,
  stepT: number,
): MovePose {
  const atDoor = facingCar(carYaw, side);
  if (t < stepT) {
    const k = smoothstep(0, 1, t / stepT);
    return {
      x: lerp(from.x, door.x, k),
      y: lerp(from.y, groundY, k),
      z: lerp(from.z, door.z, k),
      yaw: turn(from.yaw, atDoor, k),
      crouch: 0,
    };
  }
  const k = smoothstep(0, 1, Math.min(1, (t - stepT) / CLIMB_IN));
  return {
    x: lerp(door.x, seat.x, k),
    y: lerp(groundY, seat.y, k),
    z: lerp(door.z, seat.z, k),
    yaw: turn(atDoor, carYaw, k),
    // ducking in and straightening up again
    crouch: Math.sin(Math.PI * k),
  };
}

/** Where the player is `t` seconds into getting out. The move in reverse, and faster. */
export function exitPose(
  t: number,
  seat: { x: number; y: number; z: number },
  door: Spot,
  groundY: number,
  spot: Spot,
  carYaw: number,
  side: number,
): MovePose {
  const atDoor = facingCar(carYaw, side);
  if (t < CLIMB_OUT) {
    const k = smoothstep(0, 1, t / CLIMB_OUT);
    return {
      x: lerp(seat.x, door.x, k),
      y: lerp(seat.y, groundY, k),
      z: lerp(seat.z, door.z, k),
      yaw: turn(carYaw, atDoor, k),
      crouch: Math.sin(Math.PI * k),
    };
  }
  const k = smoothstep(0, 1, Math.min(1, (t - CLIMB_OUT) / STEP_OUT));
  // Turn to face the way they are walking, so they step away rather than moonwalk.
  const away = Math.atan2(spot.x - door.x, spot.z - door.z);
  return {
    x: lerp(door.x, spot.x, k),
    y: groundY,
    z: lerp(door.z, spot.z, k),
    yaw: turn(atDoor, Math.abs(spot.x - door.x) + Math.abs(spot.z - door.z) > 1e-3 ? away : atDoor, k),
    crouch: 0,
  };
}

/**
 * How fast the police care.
 *
 * This used to be a flat accumulator: heat added straight onto a 0..5 star value where
 * every star cost exactly 1.0, and no crime had a ceiling. Two things fell out of that,
 * and both of them were the whole complaint:
 *
 *  · One dead officer was worth 2.5, so a single shot police officer was an **instant
 *    two stars** and two of them was four.
 *  · Firing a gun added 0.34 **per bullet, hit or miss, witness or not** — three rounds
 *    into an empty sky was a star, and one burst from an automatic weapon was the entire
 *    wanted meter.
 *
 * So: every star now costs more than the last, and every crime has a ceiling it cannot
 * push you past on its own. Petty offences top out at two stars however many you commit;
 * only shooting police or blowing things up reaches five.
 */

/** How much harder each successive star is to earn. */
const RESISTANCE = 1.15;

export interface Crime {
  /** raw heat, before resistance */
  heat: number;
  /** the most stars this crime can ever produce by itself */
  ceiling: number;
}

/**
 * The whole tuning surface, in one table.
 *
 * Read it as: what is the worst this single act should be able to do to you? Punching
 * someone is a one-star nuisance no matter how many times you do it. Killing civilians is
 * a three-star spree. Only the police and explosives go to five.
 */
export const CRIME = {
  /** a shot heard by someone who is not a police officer */
  gunfireHeard: { heat: 0.22, ceiling: 2 },
  /** a shot heard by an officer */
  gunfireSeenByCop: { heat: 0.5, ceiling: 2 },
  /** firing a rocket launcher: loud, but the blast is the real crime */
  rocketFired: { heat: 0.3, ceiling: 3 },
  /** a punch or a blade that did not kill */
  brawl: { heat: 0.12, ceiling: 1 },
  /** clipping someone with a car */
  pedestrianStruck: { heat: 0.25, ceiling: 1 },
  /** taking a car whose alarm went off */
  carAlarm: { heat: 0.35, ceiling: 2 },
  /** taking a car quietly */
  hijack: { heat: 0.1, ceiling: 1 },
  explosion: { heat: 0.7, ceiling: 4 },
  civilianKilled: { heat: 0.9, ceiling: 3 },
  civilianRunOver: { heat: 1.0, ceiling: 3 },
  /**
   * 1.2, so the first dead officer is *just* over one star rather than nearly two. It is
   * still by far the heaviest single act in the table, and the only route to five.
   */
  officerKilled: { heat: 1.2, ceiling: 5 },
} as const satisfies Record<string, Crime>;

/**
 * Apply one crime to a wanted level, and return the new one.
 *
 * Pure, so the escalation curve can be measured in a test rather than argued about: see
 * `tests/gameplay.test.mjs`, which asserts how many of each offence it takes to reach
 * each star.
 */
export function escalate(wanted: number, crime: Crime): number {
  if (crime.heat <= 0 || wanted >= crime.ceiling) return wanted;
  const gained = crime.heat / (1 + wanted * RESISTANCE);
  return Math.min(wanted + gained, crime.ceiling);
}

/** How many of one offence it takes to reach `stars`, or Infinity if it never can. */
export function crimesToReach(crime: Crime, stars: number): number {
  if (stars > crime.ceiling) return Infinity;
  let w = 0;
  for (let n = 1; n <= 500; n++) {
    const next = escalate(w, crime);
    if (next <= w) return Infinity;      // ceiling reached without getting there
    w = next;
    if (w >= stars) return n;
  }
  return Infinity;
}

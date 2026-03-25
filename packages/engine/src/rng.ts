/**
 * Seeded pseudo-random number generator for reproducible simulations.
 *
 * Uses Mulberry32 — fast, good distribution, 32-bit seed.
 * When no seed is provided, falls back to Math.random().
 *
 * Usage:
 *   const rng = createRNG(12345);  // deterministic
 *   const rng = createRNG();       // random (uses Math.random)
 *   rng();                         // returns 0-1, like Math.random()
 */

export type RNG = () => number;

/** Mulberry32 PRNG — fast, good quality, 32-bit state */
function mulberry32(seed: number): RNG {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Create an RNG. With a seed = deterministic. Without = Math.random. */
export function createRNG(seed?: number): RNG {
  if (seed !== undefined) return mulberry32(seed);
  return Math.random;
}

/** Generate a random integer seed from current time + entropy */
export function randomSeed(): number {
  return (Date.now() * 2654435761) ^ (Math.random() * 4294967296) >>> 0;
}

/** Utility: random integer in range [min, max] inclusive */
export function randInt(rng: RNG, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Utility: pick random element from array */
export function randPick<T>(rng: RNG, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Utility: weighted random pick — weights don't need to sum to 1 */
export function randWeighted<T>(rng: RNG, items: T[], weights: number[]): T {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** Utility: shuffle array in-place using Fisher-Yates */
export function shuffle<T>(rng: RNG, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

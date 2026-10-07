/** Small, fast seeded PRNG (mulberry32). Same seed, same sequence, on every platform. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Derives an independent seed for a sub-generator (e.g. "mountains" of world seed 42). */
export function subSeed(seed: number, salt: number): number {
  return (Math.imul(seed ^ salt, 0x9e3779b1) ^ (salt >>> 3)) >>> 0
}

/** A stable hue (0–359) for a seed, used to color things that have no explicit color. */
export const hueOf = (seed: number): number => Math.floor(rng(subSeed(seed, 0x9e37))() * 360)

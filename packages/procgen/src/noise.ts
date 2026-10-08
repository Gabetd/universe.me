import { createNoise3D, type NoiseFunction3D } from 'simplex-noise'
import { rng, subSeed } from './random'

/** 3D simplex noise for one use (`salt`) of a world's seed: same seed and salt, same noise. */
export const seededNoise = (seed: number, salt: number): NoiseFunction3D => createNoise3D(rng(subSeed(seed, salt)))

/**
 * Octaves of `noise` at x, y, z: one per frequency in `freqs` (multiplying
 * the coordinates), the first `amp` strong and each next one `gain` times as
 * strong. Returns the plain sum.
 */
export function octaves(noise: NoiseFunction3D, x: number, y: number, z: number, freqs: readonly number[], amp: number, gain: number): number {
  let sum = 0
  for (let o = 0; o < freqs.length; o++) {
    const f = freqs[o]!
    sum += amp * noise(x * f, y * f, z * f)
    amp *= gain
  }
  return sum
}

/** fbm's frequencies for 0 to 8 octaves: each 2.03 times the last. */
const FBM_FREQS = Array.from({ length: 9 }, (_, n) => {
  const freqs: number[] = []
  for (let o = 0, f = 1; o < n; o++, f *= 2.03) freqs.push(f)
  return freqs
})

/** Fractal noise in [-1, 1]: `count` octaves (up to 8), each at 2.03 times the frequency and `gain` times the strength of the last. */
export function fbm(noise: NoiseFunction3D, x: number, y: number, z: number, count: number, gain = 0.5): number {
  let norm = 0
  for (let o = 0, amp = 1; o < count; o++, amp *= gain) norm += amp
  return octaves(noise, x, y, z, FBM_FREQS[count]!, 1, gain) / norm
}

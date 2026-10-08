export const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v)

/** 0 below `a`, 1 above `b`, an S-curve between. */
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v)
export const clamp01 = (v: number) => clamp(v, 0, 1)

/** 0 below `a`, 1 above `b`, an S-curve between. */
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** Radians per degree: `deg * RAD` is in radians. */
export const RAD = Math.PI / 180
/** Degrees per radian: `rad * DEG` is in degrees. */
export const DEG = 180 / Math.PI
/** A full turn in radians. */
export const TAU = Math.PI * 2

/** A longitude in degrees, brought into [-180, 180). */
export const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180
/** An angle in radians, brought into [0, 2π). */
export const wrapTau = (a: number) => ((a % TAU) + TAU) % TAU

/** Bilinear interpolation of four corners, `v00` at (0, 0) to `v11` at (1, 1), at `fx`, `fy` in [0, 1]. */
export const bilerp = (v00: number, v10: number, v01: number, v11: number, fx: number, fy: number) =>
  (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy

/**
 * How fast a drag turns the globe: from where the camera starts (two radii
 * above the ground) at TURN_SPEED, and closer as much slower as the camera is
 * nearer the ground, so a drag moves the land under the pointer about as far
 * at any zoom.
 */
export const TURN_SPEED = 0.5
const START_HEIGHT = 2
/** The slowest and fastest it turns: right down at the ground, and from the farthest out. */
const TURN_LIMITS = [0.01, 1] as const

/** How fast a drag turns the globe with the camera `distance` from its centre (in planet radii). */
export const turnSpeed = (distance: number) => Math.min(TURN_LIMITS[1], Math.max(TURN_LIMITS[0], (TURN_SPEED * (distance - 1)) / START_HEIGHT))

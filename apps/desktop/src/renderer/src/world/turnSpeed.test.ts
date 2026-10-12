import { describe, expect, it } from 'vitest'
import { TURN_SPEED, turnSpeed } from './turnSpeed'

describe('turning the globe', () => {
  it('turns less the closer the camera is to the ground, as it starts from where the view opens', () => {
    expect(turnSpeed(3)).toBe(TURN_SPEED)
    expect(turnSpeed(2)).toBeCloseTo(TURN_SPEED / 2)
    expect(turnSpeed(1.07)).toBeLessThan(0.05)
    expect(turnSpeed(1)).toBeGreaterThan(0)
    expect(turnSpeed(8)).toBe(1)
  })
})

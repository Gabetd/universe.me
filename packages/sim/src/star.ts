import type { Star } from '@universe/core'

export const SUN_RADIUS_KM = 695_700
/** Gravitational parameters, km³/s². */
export const GM_SUN = 1.32712440018e11
export const GM_EARTH = 398_600.4418

export interface StarInfo {
  massSun: number
  luminositySun: number
  radiusSun: number
  temperatureK: number
  /** Roughly the colour of a blackbody at its temperature. */
  color: string
  /** Where liquid water can last on a planet's surface, in AU. */
  habitableAu: [number, number]
}

/** Main-sequence luminosity for a mass (solar units). */
export function luminosityOf(massSun: number): number {
  if (massSun < 0.43) return 0.23 * massSun ** 2.3
  if (massSun < 2) return massSun ** 4
  if (massSun < 55) return 1.4 * massSun ** 3.5
  return 32000 * massSun
}

/** A star's derived properties. Without a record, it's the Sun. */
export function starInfo(star?: Pick<Star, 'massSun' | 'luminositySun'>): StarInfo {
  const massSun = star?.massSun ?? 1
  const luminositySun = star?.luminositySun ?? luminosityOf(massSun)
  const radiusSun = massSun < 1 ? massSun ** 0.8 : massSun ** 0.57
  const temperatureK = 5772 * (luminositySun / radiusSun ** 2) ** 0.25
  return { massSun, luminositySun, radiusSun, temperatureK, color: blackbody(temperatureK), habitableAu: [Math.sqrt(luminositySun / 1.1), Math.sqrt(luminositySun / 0.53)] }
}

/** An sRGB colour for a temperature (after Tanner Helland's fit), lightened so dim stars stay visible. */
export function blackbody(kelvin: number): string {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100
  const clamp = (v: number) => Math.round(Math.min(255, Math.max(0, v)))
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  return `#${[r, g, b].map((v) => clamp(v * 0.85 + 38).toString(16).padStart(2, '0')).join('')}`
}

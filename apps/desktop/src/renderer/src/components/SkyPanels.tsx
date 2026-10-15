import { AU_KM, daysPerYear, planetSize, radiusOfSize, type OrbitFields, type SpatialNode, type WorldSettings } from '@universe/core'
import { surfaceTemperature, withSky } from '@universe/procgen'
import { deriveCalendar, formatPeriod, massCommand, orbitFields, worldOrbit, luminosityOf, moonsOf, planetOf, worldClimate, type BodyOrbit, type SystemModel } from '@universe/sim'
import { surfaceOf } from '../kinds'
import { useUi } from '../store'
import { useSystem, useWorldClimate } from '../world/useSky'
import { NumberInput, Swatch, TextField } from './fields'
import { hinted } from './Hint'

/** What each of a star's values changes, said when the pointer rests on it. */
const STAR_HINTS = {
  mass: 'How heavy the star is, in Suns. Heavier stars burn brighter, hotter and bluer, and their planets go round faster: years get shorter at the same distance.',
  brightness: 'How much light the star gives, in Suns (by default, what its mass gives). Brighter stars warm their planets more and push the habitable zone farther out.'
}

/** What each of a planet's or moon's orbit and spin values changes. */
const ORBIT_HINTS = {
  distanceAu: 'How far the planet is from its star, on average (1 AU is Earth’s distance). Farther out, the year is longer and the world colder; closer in, shorter and hotter.',
  distanceKm: 'How far the moon is from its planet, on average. Farther out, it goes round more slowly (a longer month, which the calendar follows) and looks smaller in the sky.',
  eccentricity: 'How stretched the orbit is: 0 is a circle, near 1 a long thin oval. The more stretched, the more its distance from what it goes round changes through the year (and its warmth with it).',
  day: 'How long it takes to turn once, in hours: the length of a day. The calendar counts its days in these.',
  tilt: 'How far its axis leans from upright. More tilt, stronger seasons (hotter summers and colder winters); 0, no seasons; past 90, it turns backwards.',
  inclination: 'How far its orbit is tipped against the plane the others go round in. Tipped further, it passes above and below them; a tipped moon lines up with its sun less often, so eclipses are rarer.',
  startAngle: 'Where along its orbit it is at the start of the timeline (0 to 360°). It moves on from there as time passes; only its starting place changes.',
  mass: 'How heavy it is, in Earths. With “Mass follows size” it sets its size too; heavier bodies hold their moons faster.',
  size: 'How big it is: Earth is 10. Sets its radius (and its mass, while mass follows size).',
  radius: 'Its radius in kilometres: how big it is drawn, and (while mass follows size) how heavy it is.',
  massFollowsSize: 'Linked, a planet weighs what a planet its size does (and setting its mass sets its size); unlinked, its mass is its own.'
}

/** Inspector for a star system: its star. Without edits it's Sun-like. */
export function StarPanel({ system: node }: { system: SpatialNode }) {
  const system = useSystem(node.id)
  const stored = useUi((s) => s.timeline.stars.find((x) => x.ownerId === node.id))
  const execute = useUi((s) => s.execute)
  if (!system) return null
  const { star } = system
  const set = (patch: Partial<{ massSun: number; luminositySun: number | null }>) =>
    void execute({ type: 'star.set', payload: { systemId: node.id, star: { massSun: star.massSun, luminositySun: stored?.luminositySun ?? null, ...patch } } })
  return (
    <section className="inspector-section" aria-label="Star">
      <h3>Star</h3>
      <div className="field-pair" key={`${star.massSun}:${star.luminositySun}`}>
        <label className="field" {...hinted(STAR_HINTS.mass)}>
          <span>Mass (Suns)</span>
          <NumberInput value={star.massSun} min={0.08} max={150} onCommit={(massSun) => set({ massSun })} />
        </label>
        <label className="field" {...hinted(STAR_HINTS.brightness)}>
          <span>Brightness (Suns)</span>
          <NumberInput value={Number(star.luminositySun.toPrecision(3))} min={0.0001} max={1e7} onCommit={(l) => set({ luminositySun: Math.abs(l - luminosityOf(star.massSun)) < 1e-9 ? null : l })} />
        </label>
      </div>
      <dl className="facts-list small">
        <dt>Surface</dt>
        <dd>
          <Swatch color={star.color} /> {Math.round(star.temperatureK).toLocaleString()} K
        </dd>
        <dt>Size</dt>
        <dd>{star.radiusSun.toFixed(2)} × the Sun</dd>
        <dt>Habitable zone</dt>
        <dd>
          {star.habitableAu[0].toFixed(2)}–{star.habitableAu[1].toFixed(2)} AU
        </dd>
      </dl>
      {stored && (
        <button className="link" onClick={() => void execute({ type: 'star.reset', payload: { systemId: node.id } })}>
          Back to a Sun-like star
        </button>
      )}
    </section>
  )
}

const HOURS_PER_DAY = 24

/** Inspector for a planet or moon: its orbit and spin, and what follows from them. */
export function OrbitPanel({ body, withSurface = false }: { body: SpatialNode; withSurface?: boolean }) {
  const system = useSystem(body.id)
  const execute = useUi((s) => s.execute)
  const nodes = useUi((s) => s.nodes)
  const orbit = system?.bodies.get(body.id)
  if (!system || !orbit) return null
  const isMoon = !!orbit.parentBodyId
  const world = surfaceOf(nodes, body.id)
  const set = (patch: Partial<OrbitFields>) => setOrbit(body.id, orbit, patch)
  const distance = isMoon ? orbit.semiMajorAxisKm : orbit.semiMajorAxisKm / AU_KM

  return (
    <section className="inspector-section" aria-label="Orbit">
      <h3>Orbit and spin</h3>
      {orbit.isDefault && <p className="muted small">Made up from the seed. Change anything to set it{world ? '; the world’s calendar and climate then follow it' : ''}.</p>}
      {/* The boxes show new stored values themselves (after an undo, say). */}
      <div className="field-pair">
        <Num label={isMoon ? 'Distance (km)' : 'Distance (AU)'} value={round(distance, isMoon ? 0 : 3)} min={isMoon ? 1000 : 0.01} max={isMoon ? 1e8 : 1e4} hint={isMoon ? ORBIT_HINTS.distanceKm : ORBIT_HINTS.distanceAu} onCommit={(v) => set({ semiMajorAxisKm: isMoon ? v : v * AU_KM })} />
        <Num label="Eccentricity" value={round(orbit.eccentricity, 4)} min={0} max={0.95} hint={ORBIT_HINTS.eccentricity} onCommit={(eccentricity) => set({ eccentricity })} />
        <Num label="Day (hours)" value={round(orbit.rotationHours, 3)} min={0.1} max={1e6} hint={ORBIT_HINTS.day} onCommit={(rotationHours) => set({ rotationHours })} />
        <Num label="Axial tilt (°)" value={round(orbit.axialTiltDeg, 2)} min={0} max={180} hint={ORBIT_HINTS.tilt} onCommit={(axialTiltDeg) => set({ axialTiltDeg })} />
        <Num label="Inclination (°)" value={round(orbit.inclinationDeg, 2)} min={0} max={180} hint={ORBIT_HINTS.inclination} onCommit={(inclinationDeg) => set({ inclinationDeg })} />
        <Num label="Start angle (°)" value={round(((orbit.phaseDeg % 360) + 360) % 360, 1)} min={0} max={360} hint={ORBIT_HINTS.startAngle} onCommit={(phaseDeg) => set({ phaseDeg })} />
        <Num label="Mass (Earths)" value={round(orbit.massEarth, 4)} min={0.0001} max={1e5} hint={ORBIT_HINTS.mass} onCommit={(massEarth) => void execute(massCommand(body.id, orbit, world?.id, massEarth))} />
        {!world && (
          <>
            <Num label="Size (Earth = 10)" value={planetSize(orbit.radiusKm)} min={0.01} max={1600} hint={ORBIT_HINTS.size} onCommit={(size) => set({ radiusKm: radiusOfSize(size) })} />
            <Num label="Radius (km)" value={Math.round(orbit.radiusKm)} min={1} max={1e6} hint={ORBIT_HINTS.radius} onCommit={(radiusKm) => set({ radiusKm })} />
          </>
        )}
      </div>
      {/* Shown with the surface, it's by the planet's size in the surface's settings. */}
      {!withSurface && <MassLink bodyId={body.id} />}
      <Derived system={system} orbit={orbit} hasWorld={!!world} />
      {!orbit.isDefault && (
        <button className="link" onClick={() => void execute({ type: 'orbit.reset', payload: { bodyId: body.id } })}>
          Back to the made-up orbit
        </button>
      )}
    </section>
  )
}

/** Sets a body's orbit, from what it is now with `patch`. */
const setOrbit = (bodyId: string, orbit: BodyOrbit, patch: Partial<OrbitFields>) =>
  void useUi.getState().execute({ type: 'orbit.set', payload: { bodyId, orbit: { ...orbitFields(orbit), ...patch } } })

/** Whether a body's mass follows its size (as it does unless unlinked), and switching that; its mass as it is. */
export function MassLink({ bodyId }: { bodyId: string }) {
  const system = useSystem(bodyId)
  const orbit = system?.bodies.get(bodyId)
  if (!orbit) return null
  const linked = orbit.massFollowsSize !== false
  return (
    <label className="checkbox small" {...hinted(ORBIT_HINTS.massFollowsSize)}>
      <input type="checkbox" checked={linked} onChange={(e) => setOrbit(bodyId, orbit, { massFollowsSize: e.target.checked })} /> Mass follows size
      <span className="muted"> · {round(orbit.massEarth, orbit.massEarth < 0.1 ? 4 : 2)} Earth masses</span>
    </label>
  )
}

/** Year, day, months, seasons and climate, worked out from the orbit. */
function Derived({ system, orbit, hasWorld }: { system: SystemModel; orbit: BodyOrbit; hasWorld: boolean }) {
  const cal = deriveCalendar(system, orbit.bodyId)
  const climate = worldClimate(system, orbit.bodyId)
  const planet = planetOf(system, orbit.bodyId)!
  const moons = moonsOf(system, orbit.bodyId)
  return (
    <dl className="facts-list small" aria-label="Worked out from the orbit">
      <dt>{orbit.parentBodyId ? 'Goes round in' : 'Year'}</dt>
      <dd>{formatPeriod(orbit.periodS)}</dd>
      <dt>Day</dt>
      <dd>{cal.tidallyLocked ? 'Always the same side to the star' : `${cal.dayHours.toFixed(2)} hours${Math.abs(cal.dayHours - HOURS_PER_DAY) > 0.01 ? '' : ' (like Earth)'}`}</dd>
      {hasWorld && (
        <>
          <dt>Calendar</dt>
          <dd>
            {daysPerYear(cal.calendar)} days in {cal.calendar.months.length} month{cal.calendar.months.length === 1 ? '' : 's'}
            {orbit.isDefault ? ' (used once the orbit is set)' : ''}
          </dd>
          <dt>Climate</dt>
          <dd>
            {degrees(climate.meanTempC)} on average, seasons ±{degrees(climate.seasonalSwingC)} {climate.inHabitableZone ? '· habitable zone' : '· outside the habitable zone'}
          </dd>
        </>
      )}
      {!orbit.parentBodyId && moons.length > 0 && cal.monthDays && (
        <>
          <dt>Moon month</dt>
          <dd>{cal.monthDays.toFixed(2)} days new moon to new moon</dd>
        </>
      )}
      {orbit.parentBodyId && (
        <>
          <dt>Planet’s year</dt>
          <dd>{formatPeriod(planet.periodS)}</dd>
        </>
      )}
    </dl>
  )
}

const round = (v: number, digits: number) => Number(v.toFixed(digits))

/** "−12 °C", with a real minus sign. */
const degrees = (c: number, digits = 0) => `${c.toFixed(digits).replace('-', '−')} °C`

function Num(props: { label: string; value: number; min: number; max: number; hint?: string; onCommit(v: number): void }) {
  return (
    <label className="field" {...hinted(props.hint)}>
      <span>{props.label}</span>
      <NumberInput value={props.value} min={props.min} max={props.max} onCommit={props.onCommit} />
    </label>
  )
}

/**
 * A world's calendar: the Earth calendar until its body's orbit is set, then
 * derived from it, with month names that can be changed.
 */
export function CalendarPanel({ world }: { world: SpatialNode }) {
  const system = useSystem(world.id)
  const nodes = useUi((s) => s.nodes)
  const orbit = worldOrbit(nodes, system, world.id)
  const derived = orbit && deriveCalendar(system!, orbit.bodyId)
  const months = derived?.calendar.months
  const rename = (k: number, name: string) => {
    const names = months!.map((m, j) => (j === k ? name : m.name))
    setOrbit(orbit!.bodyId, orbit!, { monthNames: names })
  }
  return (
    <section className="inspector-section" aria-label="Calendar">
      <h3>Calendar</h3>
      {!months || !derived ? (
        <p className="muted small">The Earth calendar, until you set the orbit of the planet this world is on (select it in the tree). Then days, years and months follow it.</p>
      ) : (
        <>
          <p className="muted small">
            {daysPerYear(derived.calendar)} days of {derived.dayHours.toFixed(2)} hours
            {derived.monthDays ? `; months follow the moon (${derived.monthDays.toFixed(1)} days)` : ''}.
          </p>
          <ol className="month-list" key={months.map((m) => m.name).join()}>
            {months.map((m, k) => (
              <li key={k}>
                <TextField label={`Month ${k + 1} name`} value={m.name} required onCommit={(name) => rename(k, name)} />
                <span className="muted small">{m.days} days</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

/** A world's climate from its star and orbit: what the automatic biomes follow. */
export function ClimatePanel({ world, settings }: { world: SpatialNode; settings: WorldSettings }) {
  const climate = useWorldClimate(world.id)
  const own = settings.terrain
  const at = (lat: number) =>
    Math.round(surfaceTemperature(lat, 0, withSky(own, climate)))
  return (
    <section className="inspector-section" aria-label="Climate">
      <h3>Climate</h3>
      <p className="muted small">
        {climate
          ? `From its star and orbit: ${degrees(climate.meanTempC)} on average (${climate.offsetC >= 0 ? '+' : ''}${degrees(climate.offsetC, 1)} against Earth), seasons ±${degrees(climate.seasonalSwingC)}${climate.inHabitableZone ? '' : ', outside the habitable zone'}.`
          : 'Earth-like until the orbit of the planet it’s on is set; then its star and distance warm or cool it.'}{' '}
        Automatic biomes follow it.
      </p>
      <dl className="facts-list small" aria-label="Temperature by latitude">
        <dt>Equator</dt>
        <dd>{degrees(at(0))}</dd>
        <dt>45°</dt>
        <dd>{degrees(at(45))}</dd>
        <dt>Poles</dt>
        <dd>{degrees(at(90))}</dd>
      </dl>
    </section>
  )
}

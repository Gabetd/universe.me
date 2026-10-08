import { AU_KM, daysPerYear, type OrbitFields, type SpatialNode, type WorldSettings } from '@universe/core'
import { surfaceTemperature, withSky } from '@universe/procgen'
import { deriveCalendar, formatPeriod, orbitFields, worldOrbit, luminosityOf, moonsOf, planetOf, worldClimate, type BodyOrbit, type SystemModel } from '@universe/sim'
import { useUi } from '../store'
import { useSystem, useWorldClimate } from '../world/useSky'
import { NumberInput, Swatch, TextField } from './fields'

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
        <label className="field">
          <span>Mass (Suns)</span>
          <NumberInput value={star.massSun} min={0.08} max={150} onCommit={(massSun) => set({ massSun })} />
        </label>
        <label className="field">
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
export function OrbitPanel({ body }: { body: SpatialNode }) {
  const system = useSystem(body.id)
  const execute = useUi((s) => s.execute)
  const nodes = useUi((s) => s.nodes)
  const orbit = system?.bodies.get(body.id)
  if (!system || !orbit) return null
  const isMoon = !!orbit.parentBodyId
  const world = nodes.find((n) => n.parentId === body.id && n.kind === 'world')
  const set = (patch: Partial<OrbitFields>) => void execute({ type: 'orbit.set', payload: { bodyId: body.id, orbit: { ...orbitFields(orbit), ...patch } } })
  const distance = isMoon ? orbit.semiMajorAxisKm : orbit.semiMajorAxisKm / AU_KM

  return (
    <section className="inspector-section" aria-label="Orbit">
      <h3>Orbit and spin</h3>
      {orbit.isDefault && <p className="muted small">Made up from the seed. Change anything to set it{world ? '; the world’s calendar and climate then follow it' : ''}.</p>}
      {/* The boxes show new stored values themselves (after an undo, say). */}
      <div className="field-pair">
        <Num label={isMoon ? 'Distance (km)' : 'Distance (AU)'} value={round(distance, isMoon ? 0 : 3)} min={isMoon ? 1000 : 0.01} max={isMoon ? 1e8 : 1e4} onCommit={(v) => set({ semiMajorAxisKm: isMoon ? v : v * AU_KM })} />
        <Num label="Eccentricity" value={round(orbit.eccentricity, 4)} min={0} max={0.95} onCommit={(eccentricity) => set({ eccentricity })} />
        <Num label="Day (hours)" value={round(orbit.rotationHours, 3)} min={0.1} max={1e6} onCommit={(rotationHours) => set({ rotationHours })} />
        <Num label="Axial tilt (°)" value={round(orbit.axialTiltDeg, 2)} min={0} max={180} onCommit={(axialTiltDeg) => set({ axialTiltDeg })} />
        <Num label="Inclination (°)" value={round(orbit.inclinationDeg, 2)} min={0} max={180} onCommit={(inclinationDeg) => set({ inclinationDeg })} />
        <Num label="Start angle (°)" value={round(((orbit.phaseDeg % 360) + 360) % 360, 1)} min={0} max={360} onCommit={(phaseDeg) => set({ phaseDeg })} />
        <Num label="Mass (Earths)" value={round(orbit.massEarth, 4)} min={0.0001} max={1e5} onCommit={(massEarth) => set({ massEarth })} />
        {!world && <Num label="Radius (km)" value={Math.round(orbit.radiusKm)} min={1} max={1e6} onCommit={(radiusKm) => set({ radiusKm })} />}
      </div>
      <Derived system={system} orbit={orbit} hasWorld={!!world} />
      {!orbit.isDefault && (
        <button className="link" onClick={() => void execute({ type: 'orbit.reset', payload: { bodyId: body.id } })}>
          Back to the made-up orbit
        </button>
      )}
    </section>
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

function Num(props: { label: string; value: number; min: number; max: number; onCommit(v: number): void }) {
  return (
    <label className="field">
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
  const execute = useUi((s) => s.execute)
  const nodes = useUi((s) => s.nodes)
  const orbit = worldOrbit(nodes, system, world.id)
  const derived = orbit && deriveCalendar(system!, orbit.bodyId)
  const months = derived?.calendar.months
  const rename = (k: number, name: string) => {
    const names = months!.map((m, j) => (j === k ? name : m.name))
    void execute({ type: 'orbit.set', payload: { bodyId: orbit!.bodyId, orbit: { ...orbitFields(orbit!), monthNames: names } } })
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

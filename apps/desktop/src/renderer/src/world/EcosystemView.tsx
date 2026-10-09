import { CUBE_FACES, DIETS, ECO_LINK_TYPES, SPECIES_KINDS, TERRAIN_RES, ecosystemWarnings, type Diet, type EcoLink, type Species, type SpeciesPatch } from '@universe/core'
import { BIOMES, suggestSpecies, type TerrainModel } from '@universe/procgen'
import { useMemo, useState } from 'react'
import { ColorField, TagsField, TextField } from '../components/fields'
import { NotesEditor } from '../components/NotesEditor'
import { useUi } from '../store'
import { openElementMenu } from '../contextMenu'
import { flagClass, useFlaggedIds } from '../flags'

/**
 * A world's species and food web (PLAN.md §5.5): a list with an editor on the
 * left, and the web on the right, producers to predators from left to right.
 * Suggestions come from the biomes the world actually has.
 */

const DIET_LABELS: Record<Diet, { one: string; many: string }> = {
  producer: { one: 'Producer', many: 'Producers' },
  herbivore: { one: 'Herbivore', many: 'Herbivores' },
  omnivore: { one: 'Omnivore', many: 'Omnivores' },
  carnivore: { one: 'Carnivore', many: 'Carnivores' },
  decomposer: { one: 'Decomposer', many: 'Decomposers' }
}
const LINK_LABELS: Record<EcoLink['type'], string> = { eats: 'Eats', pollinates: 'Pollinates', symbiosis: 'Lives with', competes: 'Competes with' }
const biomeName = (id: number) => BIOMES.find((b) => b.id === id)?.name ?? `Biome ${id}`

/** Share of the land in each biome, for suggestions and the biome picker. */
function biomeShares(model: TerrainModel | undefined): Map<number, number> {
  const counts = new Map<number, number>()
  if (!model) return counts
  let land = 0
  // Every fourth cell is plenty to measure coverage.
  for (let f = 0; f < CUBE_FACES; f++) {
    for (let c = 0; c < TERRAIN_RES * TERRAIN_RES; c += 4) {
      if (model.height(f, c) < model.settings.seaLevel) continue
      const b = model.biome(f, c)
      counts.set(b, (counts.get(b) ?? 0) + 1)
      land++
    }
  }
  return new Map([...counts].map(([b, n]) => [b, n / Math.max(1, land)]))
}

export function EcosystemView({ worldId, model, change, error }: { worldId: string; model: TerrainModel | undefined; change: unknown; error?: string }) {
  const all = useUi((s) => s.timeline.lifeforms)
  const allLinks = useUi((s) => s.timeline.ecolinks)
  const execute = useUi((s) => s.execute)
  const species = useMemo(() => all.filter((s) => s.ownerId === worldId), [all, worldId])
  const links = useMemo(() => allLinks.filter((l) => l.ownerId === worldId), [allLinks, worldId])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const flagged = useFlaggedIds()
  const selected = species.find((s) => s.id === selectedId)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `change` stands for the terrain the model holds
  const shares = useMemo(() => biomeShares(model), [model, change])
  const presentBiomes = [...shares].filter(([, share]) => share >= 0.01).sort((a, b) => b[1] - a[1])
  const warnings = useMemo(() => ecosystemWarnings(species, links), [species, links])

  const suggest = () => {
    const commands = suggestSpecies(worldId, presentBiomes.map(([b]) => b), species, links, () => crypto.randomUUID())
    if (commands.length) void execute({ type: 'batch', payload: { commands } })
  }

  const add = async () => {
    const state = await execute({ type: 'species.create', payload: { ownerId: worldId, name: 'New species', biomes: presentBiomes.slice(0, 1).map(([b]) => b) } })
    if (state?.focus?.id) setSelectedId(state.focus.id)
  }

  // Opened here, in the food web's own editor.
  const speciesMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    openElementMenu({ kind: 'species', id }, e.clientX, e.clientY, { open: () => setSelectedId(id) })
  }

  return (
    <div className="eco-view">
      <aside className="eco-side">
        <div className="eco-actions">
          <button onClick={() => void add()}>+ Species</button>
          <button onClick={suggest} disabled={!model} title="Adds typical species of this world’s biomes, with who eats whom">
            Suggest for this world
          </button>
        </div>
        <p className="muted small">
          {presentBiomes.length
            ? `Biomes here: ${presentBiomes.map(([b, share]) => `${biomeName(b)} ${Math.round(share * 100)}%`).join(', ')}.`
            : !model && error
              ? `Couldn’t measure biomes: ${error}`
              : 'Measuring biomes…'}
        </p>
        {warnings.length > 0 && (
          <ul className="warning-list" aria-label="Food web warnings">
            {warnings.map((w, i) => (
              <li key={i}>
                <button className="link" onClick={() => setSelectedId(w.ids[0]!)}>
                  {w.message}
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected ? (
          <SpeciesEditor key={selected.id} species={selected} all={species} links={links} biomes={presentBiomes.map(([b]) => b)} onClose={() => setSelectedId(null)} />
        ) : (
          <ul className="region-list" aria-label="Species">
            {species.map((s) => (
              <li key={s.id}>
                <button className={`link region-row${flagClass(flagged.has(s.id))}`} onClick={() => setSelectedId(s.id)} onContextMenu={(e) => speciesMenu(e, s.id)}>
                  <span className="swatch" style={{ background: s.color }} />
                  {s.name} <span className="muted small">· {s.diet}</span>
                </button>
              </li>
            ))}
            {species.length === 0 && <li className="muted small">No species yet. Suggest some for this world’s biomes, or add your own.</li>}
          </ul>
        )}
      </aside>
      <FoodWeb species={species} links={links} selectedId={selectedId} onSelect={setSelectedId} onMenu={speciesMenu} />
    </div>
  )
}

function SpeciesEditor({ species, all, links, biomes, onClose }: { species: Species; all: Species[]; links: EcoLink[]; biomes: number[]; onClose(): void }) {
  const execute = useUi((s) => s.execute)
  const update = (patch: SpeciesPatch) => void execute({ type: 'species.update', payload: { id: species.id, patch } })
  const own = links.filter((l) => l.fromId === species.id)
  const eatenBy = links.filter((l) => l.toId === species.id && l.type === 'eats')
  const name = (id: string) => all.find((s) => s.id === id)?.name ?? '?'
  const [linkType, setLinkType] = useState<EcoLink['type']>('eats')
  const choices = [...new Set([...biomes, ...species.biomes])].sort((a, b) => a - b)

  return (
    <section className="eco-editor" aria-label="Species">
      <div className="inspector-kind">
        <span className="swatch" style={{ background: species.color }} /> Species
        <button className="link close" aria-label="Close species" onClick={onClose}>
          ✕
        </button>
      </div>
      <TextField label="Species name" value={species.name} required onCommit={(n) => update({ name: n })} />
      <div className="field-pair">
        <label className="field">
          <span>Kind</span>
          <select value={species.kind} onChange={(e) => update({ kind: e.target.value as Species['kind'] })}>
            {SPECIES_KINDS.map((k) => (
              <option key={k} value={k}>
                {k[0]!.toUpperCase() + k.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Diet</span>
          <select value={species.diet} onChange={(e) => update({ diet: e.target.value as Diet })}>
            {DIETS.map((d) => (
              <option key={d} value={d}>
                {DIET_LABELS[d].one}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="chip-toggles" role="group" aria-label="Lives in">
        {choices.map((b) => {
          const on = species.biomes.includes(b)
          return (
            <button key={b} aria-pressed={on} onClick={() => update({ biomes: on ? species.biomes.filter((x) => x !== b) : [...species.biomes, b] })}>
              {biomeName(b)}
            </button>
          )
        })}
      </div>
      <div className="field">
        <span>Food web</span>
        <ul className="plain-list small">
          {own.map((l) => (
            <li key={l.id}>
              {LINK_LABELS[l.type]} {name(l.toId)}{' '}
              <button className="link" aria-label={`Remove: ${LINK_LABELS[l.type]} ${name(l.toId)}`} onClick={() => void execute({ type: 'ecolink.delete', payload: { id: l.id } })}>
                ✕
              </button>
            </li>
          ))}
          {eatenBy.map((l) => (
            <li key={l.id} className="muted">
              Eaten by {name(l.fromId)}
            </li>
          ))}
        </ul>
        <div className="field-row">
          <select aria-label="Link type" value={linkType} onChange={(e) => setLinkType(e.target.value as EcoLink['type'])}>
            {ECO_LINK_TYPES.map((t) => (
              <option key={t} value={t}>
                {LINK_LABELS[t]}
              </option>
            ))}
          </select>
          <select
            aria-label="Link to"
            value=""
            onChange={(e) => e.target.value && void execute({ type: 'ecolink.create', payload: { fromId: species.id, toId: e.target.value, type: linkType } })}
          >
            <option value="">…which species?</option>
            {all
              .filter((s) => s.id !== species.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>
      </div>
      <ColorField label="Species color" value={species.color} onCommit={(color) => update({ color })} />
      <TagsField label="Species tags" tags={species.tags} onCommit={(tags) => update({ tags })} />
      <div className="field">
        <span>Species notes</span>
        <NotesEditor label="Species notes" value={species.notes} onCommit={(notes) => update({ notes })} />
      </div>
      <button className="danger" onClick={() => void execute({ type: 'species.delete', payload: { id: species.id } }).then(onClose)}>
        Delete species
      </button>
    </section>
  )
}

const NODE_W = 128
const NODE_H = 28
const GAP_Y = 10

/** The food web: one column per diet, arrows from food to eater (the way energy flows). */
function FoodWeb({
  species,
  links,
  selectedId,
  onSelect,
  onMenu
}: {
  species: Species[]
  links: EcoLink[]
  selectedId: string | null
  onSelect(id: string): void
  onMenu(e: React.MouseEvent, id: string): void
}) {
  const columns = DIETS.map((d) => species.filter((s) => s.diet === d))
  const colX = (i: number) => 24 + i * (NODE_W + 72)
  const pos = new Map<string, { x: number; y: number }>()
  columns.forEach((list, i) => list.forEach((s, k) => pos.set(s.id, { x: colX(i), y: 44 + k * (NODE_H + GAP_Y) })))
  const height = Math.max(160, 64 + Math.max(0, ...columns.map((c) => c.length)) * (NODE_H + GAP_Y))
  const width = colX(DIETS.length - 1) + NODE_W + 24
  const related = new Set(selectedId ? links.filter((l) => l.fromId === selectedId || l.toId === selectedId).flatMap((l) => [l.fromId, l.toId]) : [])

  return (
    <div className="eco-web" data-testid="food-web">
      <svg width={width} height={height} role="img" aria-label="Food web">
        <defs>
          <marker id="eco-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
          </marker>
        </defs>
        {DIETS.map((d, i) => (
          <text key={d} x={colX(i)} y={24} className="eco-col-label">
            {DIET_LABELS[d].many}
          </text>
        ))}
        {links.map((l) => {
          // Energy flows from the food (toId) to the eater (fromId).
          const food = pos.get(l.toId)
          const eater = pos.get(l.fromId)
          if (!food || !eater) return null
          const forward = food.x <= eater.x
          const x1 = food.x + (forward ? NODE_W : 0)
          const x2 = eater.x + (forward ? 0 : NODE_W)
          const y1 = food.y + NODE_H / 2
          const y2 = eater.y + NODE_H / 2
          const bend = Math.max(40, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1)
          const lit = selectedId && (l.fromId === selectedId || l.toId === selectedId)
          return (
            <path
              key={l.id}
              d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`}
              className={`eco-link ${l.type}${lit ? ' lit' : ''}${selectedId && !lit ? ' dim' : ''}`}
              markerEnd={l.type === 'eats' ? 'url(#eco-arrow)' : undefined}
            />
          )
        })}
        {species.map((s) => {
          const p = pos.get(s.id)!
          const dim = selectedId && s.id !== selectedId && !related.has(s.id)
          return (
            <g key={s.id} className={`eco-node${s.id === selectedId ? ' selected' : ''}${dim ? ' dim' : ''}`} transform={`translate(${p.x},${p.y})`} onClick={() => onSelect(s.id)} onContextMenu={(e) => onMenu(e, s.id)} role="button" aria-label={s.name}>
              <rect width={NODE_W} height={NODE_H} rx={6} />
              <circle cx={12} cy={NODE_H / 2} r={5} fill={s.color} />
              <text x={24} y={NODE_H / 2 + 4}>
                {s.name.length > 16 ? `${s.name.slice(0, 15)}…` : s.name}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

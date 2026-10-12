import type { MapPin } from '@universe/core'
import { updater, useUi } from '../store'
import { latLonLabel } from '../world/useMapPins'
import { ColorField, DeleteButton, NotesField, PanelHeader, TextField } from './fields'

/** A pin on a world's surface, in the inspector: its name, colour, where it is and its notes. */
export function MapPinPanel({ pin }: { pin: MapPin }) {
  const update = updater('mapPin', pin.id)
  return (
    <section className="inspector-section" aria-label="Pin">
      <PanelHeader icon="📍" label="Pin" onClose={() => useUi.getState().selectTimeline(null)} />
      <TextField label="Pin name" value={pin.name} required onCommit={(name) => update({ name })} />
      <p className="muted small" aria-label="Where">
        {latLonLabel(pin)}
      </p>
      <ColorField label="Pin color" value={pin.color} onCommit={(color) => update({ color })} />
      <NotesField label="Pin notes" value={pin.notes} onCommit={(notes) => update({ notes })} />
      <DeleteButton kind="mapPin" ids={[pin.id]}>
        Delete pin
      </DeleteButton>
    </section>
  )
}

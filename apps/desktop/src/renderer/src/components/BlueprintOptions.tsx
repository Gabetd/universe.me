import { BUILTIN_BLUEPRINTS } from '@universe/core'
import { useUi } from '../store'

/** `<option>`s for every blueprint, the project's own first, then the built-in ones. */
export function BlueprintOptions({ prefix = '' }: { prefix?: string }) {
  const library = useUi((s) => s.timeline.blueprints)
  const options = (list: typeof library) =>
    list.map((b) => (
      <option key={b.id} value={b.id}>
        {prefix}
        {b.name}
      </option>
    ))
  return (
    <>
      {library.length > 0 && <optgroup label="This project">{options(library)}</optgroup>}
      <optgroup label="Built in">{options(BUILTIN_BLUEPRINTS)}</optgroup>
    </>
  )
}

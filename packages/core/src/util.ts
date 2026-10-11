/** Drops keys whose value is `undefined`, so spreading a patch never erases fields. */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

/**
 * `fn` worked out once per argument object. Arrays and records from the
 * store are never changed in place (a change makes a new one), so a cached
 * answer stays right for as long as its argument is around.
 */
export function memoize<K extends object, V>(fn: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>()
  return (key) => {
    if (!cache.has(key)) cache.set(key, fn(key))
    return cache.get(key)!
  }
}

/** Looks items up by id; the first of equal ids wins, as with `find`. */
export function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) if (!map.has(item.id)) map.set(item.id, item)
  return map
}

/** Items by a key of each, in their order (Map.groupBy, before ES2024). */
export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

/** The ids above something in a tree of `parentId`s (a faction's, a node's), its parent first; stops at a loop rather than going round it. */
export function* ancestors(item: { parentId: string | null }, all: ReadonlyMap<string, { parentId: string | null }>): Generator<string> {
  const seen = new Set<string>()
  for (let p = item.parentId; p && !seen.has(p); p = all.get(p)?.parentId ?? null) {
    seen.add(p)
    yield p
  }
}

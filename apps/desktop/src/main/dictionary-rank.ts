/**
 * Suggestions closest to what was typed first: fewest changes (a letter
 * added, dropped, changed, or two swapped, "teh" for "the"), then those made
 * of the same letters, then Hunspell's own order.
 */
export function rank(typed: string, suggestions: readonly string[]): string[] {
  const t = typed.toLowerCase()
  const letters = (w: string) => [...w.toLowerCase()].sort().join('')
  const same = letters(typed)
  // The sort is stable, so ties keep Hunspell's order.
  return suggestions
    .map((s) => ({ s, changes: editDistance(t, s.toLowerCase()), shuffled: letters(s) === same ? 0 : 1 }))
    .sort((a, b) => a.changes - b.changes || a.shuffled - b.shuffled)
    .map((x) => x.s)
}

/** Changes from `a` to `b`: letters added, dropped or changed, and neighbours swapped (each one change). */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
    }
  }
  return d[a.length]![b.length]!
}

/**
 * Merging two versions of a text made apart from the same one (PLAN.md §6.7,
 * M20), line by line: a line changed on one side alone is taken from it, one
 * changed alike on both is taken once, and where both changed the same lines
 * differently the later version's lines are kept (and the merge says so, for
 * the earlier to be kept as a conflict note). Notes are HTML, so a line ends
 * at a new line or after a paragraph, heading, list item or line break.
 */

/** Lines compared at most, all three versions together, past what they share at either end: past it there's no merge (each version is kept whole). */
const MAX_CELLS = 4_000_000

/** A text as lines, each with its ending: joined, they're the text again. */
export const linesOf = (text: string): string[] => text.split(/(?<=\n|<\/(?:p|h[1-6]|li|ul|ol|blockquote|pre|div)>|<br\s*\/?>)/i).filter((line) => line !== '')

/** Where each line of `x` is in `y`, for the longest run of lines they share in order. */
function matches(x: readonly string[], y: readonly string[]): Map<number, number> | undefined {
  const out = new Map<number, number>()
  let start = 0
  while (start < x.length && start < y.length && x[start] === y[start]) out.set(start, start++)
  let [xe, ye] = [x.length, y.length]
  while (xe > start && ye > start && x[xe - 1] === y[ye - 1]) out.set(--xe, --ye)
  const [n, m] = [xe - start, ye - start]
  if (n * m > MAX_CELLS) return undefined
  // Lengths of the longest shared runs from each pair of places on.
  const runs = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) runs[at(i, j)] = x[start + i] === y[start + j] ? runs[at(i + 1, j + 1)]! + 1 : Math.max(runs[at(i + 1, j)]!, runs[at(i, j + 1)]!)
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (x[start + i] === y[start + j]) out.set(start + i++, start + j++)
    else if (runs[at(i + 1, j)]! >= runs[at(i, j + 1)]!) i++
    else j++
  }
  return out
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, i) => line === b[i])

/**
 * `earlier` and `later`, both changed from `base`, as one: undefined if
 * they're too long to compare. `clean` is false where both changed the same
 * lines differently (the later one's are kept).
 */
export function mergeLines(base: string, earlier: string, later: string): { text: string; clean: boolean } | undefined {
  const [o, a, b] = [linesOf(base), linesOf(earlier), linesOf(later)]
  const [ma, mb] = [matches(o, a), matches(o, b)]
  if (!ma || !mb) return undefined
  const out: string[] = []
  let clean = true
  let [i, ia, ib] = [0, 0, 0]
  for (;;) {
    // The next line of the base both kept: what's between is changed on one side, both, or neither.
    let j = i
    while (j < o.length && !(ma.has(j) && mb.has(j))) j++
    const [ja, jb] = j < o.length ? [ma.get(j)!, mb.get(j)!] : [a.length, b.length]
    const [was, mine, theirs] = [o.slice(i, j), a.slice(ia, ja), b.slice(ib, jb)]
    if (same(mine, was) || same(mine, theirs)) out.push(...theirs)
    else if (same(theirs, was)) out.push(...mine)
    else {
      out.push(...theirs)
      clean = false
    }
    if (j >= o.length) return { text: out.join(''), clean }
    out.push(o[j]!)
    ;[i, ia, ib] = [j + 1, ja + 1, jb + 1]
  }
}

/** Two versions of a face of terrain made apart from `base`, cell by cell: each cell as the later one has it if it changed it there, and otherwise as the earlier one has it. */
export function mergeCells(base: Uint8Array, earlier: Uint8Array, later: Uint8Array, cellBytes: number): Uint8Array {
  const out = earlier.slice()
  for (let at = 0; at < later.length; at += cellBytes) {
    let changed = false
    for (let k = 0; k < cellBytes && !changed; k++) changed = later[at + k] !== base[at + k]
    if (changed) out.set(later.subarray(at, at + cellBytes), at)
  }
  return out
}

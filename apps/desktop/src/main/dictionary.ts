import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import nspell from 'nspell'
import { rank } from './dictionary-rank'
import aff from 'dictionary-en-files/index.aff?raw'
import dic from 'dictionary-en-files/index.dic?raw'

/**
 * The spelling dictionary (English, Hunspell's, through nspell): bundled with
 * the app, so it works the same everywhere and nothing is downloaded. Words
 * the user adds are kept in `dictionary.txt` in their profile, one per line;
 * the names of everything in the open universe (its places, people,
 * factions…) count as words too, without being added.
 */
export class Dictionary {
  private readonly spell = nspell(aff, dic)
  private readonly own: Set<string>
  private readonly file: string
  private names = new Set<string>()

  constructor(profile: string) {
    this.file = join(profile, 'dictionary.txt')
    this.own = new Set(read(this.file))
    for (const word of this.own) this.spell.add(word)
  }

  /** The words among `words` that aren't spelled right. */
  misspelled(words: readonly string[]): string[] {
    return words.filter((w) => !this.known(w))
  }

  /** Corrections for a word, best first (see `rank`); none for one that's spelled right. */
  suggest(word: string): string[] {
    return this.known(word) ? [] : rank(word, this.spell.suggest(word)).slice(0, 6)
  }

  /** The words the user added, A to Z. */
  words(): string[] {
    return [...this.own].sort((a, b) => a.localeCompare(b))
  }

  /** Adds a word of the user's own (kept for next time). */
  async add(word: string): Promise<string[]> {
    const w = clean(word)
    if (w && !this.own.has(w)) {
      this.own.add(w)
      this.spell.add(w)
      await this.save()
    }
    return this.words()
  }

  async remove(word: string): Promise<string[]> {
    if (this.own.delete(word)) {
      this.spell.remove(word)
      await this.save()
    }
    return this.words()
  }

  /** The names in the open universe, as words that are spelled right. */
  setNames(names: Iterable<string>): void {
    const words = new Set<string>()
    for (const name of names) for (const w of name.split(/[^\p{L}\p{M}'’-]+/u)) if (w) words.add(w.toLowerCase())
    this.names = words
  }

  private known(word: string): boolean {
    const w = word.replace(/’/g, "'")
    return this.spell.correct(w) || this.names.has(w.toLowerCase()) || this.own.has(word)
  }

  private save(): Promise<void> {
    return writeFile(this.file, this.words().join('\n') + '\n')
  }
}

/** One word, as the user's dictionary keeps it: no spaces, a sensible length. */
const clean = (word: string) => {
  const w = word.trim()
  return w && w.length <= 60 && !/\s/.test(w) ? w : ''
}

function read(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').map(clean).filter(Boolean)
  } catch {
    return []
  }
}


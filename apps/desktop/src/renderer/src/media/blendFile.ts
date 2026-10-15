/**
 * The bones of a .blend file: its header, its blocks and the SDNA that
 * describes every struct in it, so fields are found by name whatever the
 * Blender version that wrote it. Uncompressed bytes only: a compressed file
 * (gzip or zstd) is inflated before it gets here.
 */

export interface Block {
  /** Four characters: 'OB\0\0', 'ME\0\0', 'DATA', 'TEST'… */
  code: string
  /** Where its data starts in the file. */
  offset: number
  length: number
  /** The address it had in memory when saved: what pointers to it hold. */
  old: string
  /** Its struct in the SDNA (0 for raw data). */
  sdna: number
  /** How many structs it holds. */
  count: number
  /** The ID block ('OB', 'ME'…) whose data it is: itself, for one. */
  owner: number
}

export interface Field {
  name: string
  type: string
  offset: number
  pointer: boolean
  /** Elements, for an array (1 otherwise). */
  length: number
}

export interface Struct {
  name: string
  size: number
  fields: Map<string, Field>
}

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))

/** The field's name without its pointer stars, brackets and array sizes: `*next` → next, `co[3]` → co, `(*func)()` → func. */
const bareName = (name: string) => name.replace(/[*()]|\[.*$/g, '')

const arrayLength = (name: string) => [...name.matchAll(/\[(\d+)\]/g)].reduce((n, m) => n * Number(m[1]), 1)

export class BlendFile {
  readonly view: DataView
  readonly little: boolean
  readonly pointerSize: 4 | 8
  /** Blender's version, like '4.2' or '2.78'. */
  readonly version: string
  readonly blocks: Block[] = []
  /** ID blocks by address; data blocks by address within each ID's own (Blender 5 numbers them per ID, so addresses repeat across IDs). */
  private readonly ids = new Map<string, Block>()
  private readonly data = new Map<number, Map<string, Block>>()
  private readonly structs: Struct[] = []
  private readonly structByName = new Map<string, Struct>()
  private readonly typeSizes = new Map<string, number>()

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.length < 12 || ascii(bytes, 0, 7) !== 'BLENDER') throw new Error('This isn’t a Blender file')
    let at: number
    let large = false
    const kind = String.fromCharCode(bytes[7]!)
    if (kind === '_' || kind === '-') {
      // BLENDER-v402: pointer size, endianness, three digits of version.
      this.pointerSize = kind === '-' ? 8 : 4
      this.little = bytes[8] === 0x76
      const v = ascii(bytes, 9, 12)
      this.version = `${v[0]}.${Number(v.slice(1))}`
      at = 12
    } else {
      // BLENDER17-01v0502 (Blender 5 on): the header's size, the file format's version, endianness, four digits of version; always 64-bit.
      const headerSize = Number(ascii(bytes, 7, 9))
      const format = Number(ascii(bytes, 10, 12))
      if (!Number.isFinite(headerSize) || format !== 1) throw new Error('This Blender file is from a version too new to read')
      this.pointerSize = 8
      this.little = bytes[12] === 0x76
      const v = ascii(bytes, 13, 17)
      this.version = `${Number(v.slice(0, 2))}.${Number(v.slice(2))}`
      large = true
      at = headerSize
    }
    const headLength = large ? 32 : this.pointerSize === 8 ? 24 : 20
    while (at + headLength <= bytes.length) {
      const code = ascii(bytes, at, at + 4)
      let length: number, old: string, sdna: number, count: number
      if (large) {
        sdna = this.view.getInt32(at + 4, this.little)
        old = this.address(at + 8)
        length = Number(this.view.getBigInt64(at + 16, this.little))
        count = Number(this.view.getBigInt64(at + 24, this.little))
      } else {
        length = this.view.getInt32(at + 4, this.little)
        old = this.address(at + 8)
        sdna = this.view.getInt32(at + 8 + this.pointerSize, this.little)
        count = this.view.getInt32(at + 12 + this.pointerSize, this.little)
      }
      if (code === 'ENDB') break
      const isData = code === 'DATA'
      const owner = isData ? (this.blocks.at(-1)?.owner ?? 0) : this.blocks.length
      const block: Block = { code, offset: at + headLength, length, old, sdna, count, owner }
      if (block.offset + length > bytes.length || length < 0) throw new Error('This Blender file is cut short')
      this.blocks.push(block)
      if (old !== '0') {
        if (!isData) this.ids.set(old, block)
        else {
          const own = this.data.get(owner) ?? new Map<string, Block>()
          own.set(old, block)
          this.data.set(owner, own)
        }
      }
      at = block.offset + length
    }
    const dna = this.blocks.find((b) => b.code === 'DNA1')
    if (!dna) throw new Error('This Blender file has no description of its data')
    this.readDna(dna)
  }

  /** A pointer's value as a key into the blocks ('0' for null). */
  address(offset: number): string {
    if (this.pointerSize === 4) return this.view.getUint32(offset, this.little).toString(16)
    return this.view.getBigUint64(offset, this.little).toString(16)
  }

  /** The block a pointer at `offset` points to, if it's in the file: data of the same ID, or another ID. */
  follow(offset: number): Block | undefined {
    const old = this.address(offset)
    if (old === '0') return undefined
    const from = this.blockAt(offset)
    return (from && this.data.get(from.owner)?.get(old)) ?? this.ids.get(old)
  }

  /** The block whose data holds `offset`. */
  private blockAt(offset: number): Block | undefined {
    let lo = 0
    let hi = this.blocks.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const b = this.blocks[mid]!
      if (offset < b.offset) hi = mid - 1
      else if (offset >= b.offset + b.length) lo = mid + 1
      else return b
    }
    return undefined
  }

  struct(name: string): Struct | undefined {
    return this.structByName.get(name)
  }

  /** The struct a block holds. */
  structOf(block: Block): Struct | undefined {
    return this.structs[block.sdna]
  }

  private readDna(block: Block) {
    const { bytes, view, little } = this
    let at = block.offset
    const expect = (tag: string) => {
      at = block.offset + Math.ceil((at - block.offset) / 4) * 4
      if (ascii(bytes, at, at + 4) !== tag) throw new Error(`This Blender file’s description is damaged (no ${tag})`)
      at += 4
    }
    const strings = () => {
      const n = view.getInt32(at, little)
      at += 4
      const out: string[] = []
      for (let i = 0; i < n; i++) {
        let end = at
        while (bytes[end] !== 0) end++
        out.push(ascii(bytes, at, end))
        at = end + 1
      }
      return out
    }
    expect('SDNA')
    expect('NAME')
    const names = strings()
    expect('TYPE')
    const types = strings()
    expect('TLEN')
    types.forEach((t, i) => this.typeSizes.set(t, view.getInt16(at + i * 2, little)))
    at += types.length * 2
    expect('STRC')
    const n = view.getInt32(at, little)
    at += 4
    for (let i = 0; i < n; i++) {
      const name = types[view.getInt16(at, little)]!
      const count = view.getInt16(at + 2, little)
      at += 4
      const fields = new Map<string, Field>()
      let offset = 0
      for (let f = 0; f < count; f++, at += 4) {
        const type = types[view.getInt16(at, little)]!
        const raw = names[view.getInt16(at + 2, little)]!
        const pointer = raw.startsWith('*') || raw.startsWith('(*')
        const length = arrayLength(raw)
        fields.set(bareName(raw), { name: bareName(raw), type, offset, pointer, length })
        offset += (pointer ? this.pointerSize : (this.typeSizes.get(type) ?? 0)) * length
      }
      const struct = { name, size: this.typeSizes.get(name) ?? offset, fields }
      this.structs.push(struct)
      this.structByName.set(name, struct)
    }
  }

  /** Reads one number of a field's type at `offset`. */
  number(type: string, offset: number): number {
    const { view, little } = this
    switch (type) {
      case 'char':
      case 'uchar':
      case 'uint8_t':
        return view.getUint8(offset)
      case 'int8_t':
        return view.getInt8(offset)
      case 'short':
      case 'int16_t':
        return view.getInt16(offset, little)
      case 'ushort':
      case 'uint16_t':
        return view.getUint16(offset, little)
      case 'int':
      case 'int32_t':
        return view.getInt32(offset, little)
      case 'uint':
      case 'uint32_t':
        return view.getUint32(offset, little)
      case 'float':
        return view.getFloat32(offset, little)
      case 'double':
        return view.getFloat64(offset, little)
      case 'int64_t':
        return Number(view.getBigInt64(offset, little))
      case 'uint64_t':
        return Number(view.getBigUint64(offset, little))
      default:
        throw new Error(`Can’t read a ${type}`)
    }
  }

  /** A C string at `offset`, up to `max` bytes. */
  text(offset: number, max: number): string {
    let end = offset
    while (end < offset + max && this.bytes[end] !== 0) end++
    return new TextDecoder().decode(this.bytes.subarray(offset, end))
  }
}

/** One struct in a block, read field by field. */
export class StructView {
  constructor(
    readonly file: BlendFile,
    readonly struct: Struct,
    readonly offset: number
  ) {}

  /** The first of `names` the struct has (fields get renamed between versions). */
  field(...names: string[]): Field | undefined {
    for (const n of names) {
      const f = this.struct.fields.get(n)
      if (f) return f
    }
    return undefined
  }

  has = (...names: string[]) => this.field(...names) !== undefined

  number(...names: string[]): number | undefined {
    const f = this.field(...names)
    return f && !f.pointer ? this.file.number(f.type, this.offset + f.offset) : undefined
  }

  numbers(name: string): number[] | undefined {
    const f = this.field(name)
    if (!f || f.pointer) return undefined
    const size = typeSize(f.type)
    return Array.from({ length: f.length }, (_, i) => this.file.number(f.type, this.offset + f.offset + i * size))
  }

  text(name: string): string {
    const f = this.field(name)
    return f ? this.file.text(this.offset + f.offset, f.length) : ''
  }

  /** The block a pointer field points to. */
  follow(...names: string[]): Block | undefined {
    const f = this.field(...names)
    return f?.pointer ? this.file.follow(this.offset + f.offset) : undefined
  }

  /** A struct embedded in this one (not pointed to). */
  inner(name: string): StructView | undefined {
    const f = this.field(name)
    const struct = f && !f.pointer ? this.file.struct(f.type) : undefined
    return struct ? new StructView(this.file, struct, this.offset + f!.offset) : undefined
  }
}

const SIZES: Record<string, number> = { char: 1, uchar: 1, uint8_t: 1, int8_t: 1, short: 2, ushort: 2, int16_t: 2, uint16_t: 2, int: 4, uint: 4, int32_t: 4, uint32_t: 4, float: 4, double: 8, int64_t: 8, uint64_t: 8 }
const typeSize = (type: string) => SIZES[type] ?? 1

/** The structs a block holds, as records (using the block's own struct, or `as`). */
export function recordsOf(file: BlendFile, block: Block, as?: Struct): StructView[] {
  const struct = as ?? file.structOf(block)
  if (!struct || struct.size <= 0) return []
  const n = Math.min(block.count, Math.floor(block.length / struct.size))
  return Array.from({ length: n }, (_, i) => new StructView(file, struct, block.offset + i * struct.size))
}

/** The first struct in a block. */
export const recordOf = (file: BlendFile, block: Block | undefined, as?: string): StructView | undefined => {
  if (!block) return undefined
  const struct = as ? file.struct(as) : file.structOf(block)
  return struct ? new StructView(file, struct, block.offset) : undefined
}

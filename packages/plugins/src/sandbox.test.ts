import { describe, expect, it } from 'vitest'
import { defaultOptions, optionsFor, readManifest } from './manifest'
import { resolvePath, runPlugin, type PluginHost, type PluginRun } from './sandbox'

/** A host that answers every operation with what it was asked, and keeps a log. */
function testHost(answers: Record<string, unknown> = {}) {
  const calls: [string, unknown][] = []
  const log: string[] = []
  const host: PluginHost = {
    call: async (op, input) => {
      calls.push([op, input])
      if (op in answers) return answers[op]
      throw new Error(`There is no operation ${op}`)
    },
    pickFile: async () => ({ name: 'names.txt', text: 'Aldric\nEdda' }),
    // Stands in for an encoder: the pixels back, reversed.
    png: async (_w, _h, rgba) => Buffer.from(Buffer.from(rgba, 'base64').reverse()).toString('base64'),
    log: (line) => void log.push(line)
  }
  return { host, calls, log }
}

const run = (code: string, more: Partial<PluginRun> = {}) => {
  const t = testHost(more.host ? {} : { list_worlds: { worlds: [{ id: 'w1', name: 'Terra' }] }, create_event: { status: 'applied', eventId: 'e1' } })
  return { ...t, done: runPlugin({ files: { 'main.js': code }, main: 'main.js', kind: 'generators', id: 'go', input: { options: { count: 2 } }, host: t.host, ...more }) }
}

describe('plugins in the sandbox', () => {
  it('run a generator, which asks the app for things and adds to it through its operations', async () => {
    const { done, calls, log } = run(`
      export const generators = {
        async go({ options }, universe) {
          const { worlds } = await universe.call('list_worlds')
          for (let i = 0; i < options.count; i++) await universe.call('create_event', { worldId: worlds[0].id, title: 'Omen ' + i, start: 1200 + i })
          console.log('made', options.count)
          return 'Two omens on ' + worlds[0].name
        }
      }`)
    expect(await done).toEqual({ kind: 'generators', summary: 'Two omens on Terra' })
    expect(calls.map(([op]) => op)).toEqual(['list_worlds', 'create_event', 'create_event'])
    expect(calls[2]![1]).toEqual({ worldId: 'w1', title: 'Omen 1', start: 1201 })
    expect(log).toEqual(['made 2'])
  })

  it('make names the same way from the same seed', async () => {
    const code = `export const names = { go: ({ seed }, u) => { const r = u.random(seed); return ['Al', 'Be', 'Cy', 'Di'].map((s) => s + Math.floor(r() * 100)) } }`
    const once = await run(code, { kind: 'names', input: { seed: 7 } }).done
    const again = await run(code, { kind: 'names', input: { seed: 7 } }).done
    expect(once).toEqual(again)
    expect(once.kind === 'names' && once.names).toHaveLength(4)
  })

  it('export files: text, and bytes (a PNG from pixels)', async () => {
    const { done } = run(
      `export const exporters = {
        async go(_, u) {
          const png = await u.png(1, 1, new Uint8Array([1, 2, 3, 4]))
          const picked = await u.pickFile({ extensions: ['txt'] })
          return [{ name: 'wiki/index.md', text: '# ' + picked.text.split('\\n')[0] }, { name: 'map.png', bytes: png }]
        }
      }`,
      { kind: 'exporters' }
    )
    expect(await done).toEqual({
      kind: 'exporters',
      files: [
        { name: 'wiki/index.md', text: '# Aldric' },
        { name: 'map.png', base64: Buffer.from([4, 3, 2, 1]).toString('base64') }
      ]
    })
  })

  it('import their own modules, and nothing else', async () => {
    const files = { 'main.js': `import { greet } from './lib/greet.js'\nexport const names = { go: () => [greet('Edda')] }`, 'lib/greet.js': `export const greet = (n) => 'Hail, ' + n` }
    expect(await run('', { files, kind: 'names' }).done).toEqual({ kind: 'names', names: ['Hail, Edda'] })
    await expect(run(`import fs from 'fs'\nexport const names = { go: () => [] }`, { kind: 'names' }).done).rejects.toThrow(/only its own files/)
    expect(() => resolvePath('main.js', '../outside.js')).toThrow(/outside the plugin/)
    expect(resolvePath('lib/a.js', '../b.js')).toBe('b.js')
  })

  it('reach nothing of the computer: no network, no files, no Node', async () => {
    const { done } = run(`export const names = { go: () => [typeof fetch, typeof XMLHttpRequest, typeof require, typeof process, typeof WebSocket, typeof std, typeof os].map(String) }`, { kind: 'names' })
    expect(await done).toEqual({ kind: 'names', names: Array(7).fill('undefined') })
  })

  // QuickJS's first out-of-memory in a process takes some seconds; later ones are quick.
  it('are stopped when they use too much memory', { timeout: 60_000 }, async () => {
    await expect(run(`export const generators = { go() { const a = []; for (;;) a.push(new Uint8Array(1e6)) } }`, { limits: { memory: 8 * 1024 * 1024 } }).done).rejects.toThrow(/more memory/)
  })

  it('are stopped when they run too long, ask too much, or throw', async () => {
    await expect(run(`export const generators = { go() { for (;;) {} } }`, { limits: { timeMs: 300 } }).done).rejects.toThrow(/ran too long|longer than/)
    await expect(run(`export const generators = { async go(_, u) { for (;;) await u.call('list_worlds') } }`, { limits: { calls: 5 } }).done).rejects.toThrow(/more than 5 things/)
    await expect(run(`export const generators = { go() { throw new Error('No seas to name') } }`).done).rejects.toThrow(/^No seas to name/)
    await expect(run(`export const generators = { other() {} }`).done).rejects.toThrow(/exports no generators.go function/)
    await expect(run(`export const generators = { async go(_, u) { await u.call('delete_everything') } }`).done).rejects.toThrow(/no operation delete_everything/)
    await expect(run(`export const exporters = { go: () => [{ text: 'x' }] }`, { kind: 'exporters' }).done).rejects.toThrow(/File 1 has no name/)
  })
})

describe('plugin manifests', () => {
  it('read, with defaults for what is left out', () => {
    const read = readManifest(
      JSON.stringify({
        id: 'village-maker',
        name: 'Village maker',
        version: '1.0.0',
        generators: [{ id: 'villages', title: 'Scatter villages', options: [{ id: 'count', label: 'How many', type: 'number', default: 5, min: 1 }, { id: 'style', label: 'Style', type: 'choice', choices: ['Hamlets', 'Towns'] }] }],
        names: [{ id: 'elvish', title: 'Elvish names', for: ['character'] }]
      })
    )
    expect('manifest' in read && read.manifest).toMatchObject({ main: 'main.js', exporters: [], generators: [{ on: 'world' }] })
    if (!('manifest' in read)) return
    const options = read.manifest.generators[0]!.options
    expect(defaultOptions(options)).toEqual({ count: 5, style: 'Hamlets' })
    // What a run is given: values that fit, else the defaults.
    expect(optionsFor(options, { count: 0, style: 'Towns' })).toEqual({ count: 1, style: 'Towns' })
    expect(optionsFor(options, { count: 'many', style: 'Cities', other: 1 })).toEqual({ count: 5, style: 'Hamlets' })
  })

  it('say what is wrong with one that is not right', () => {
    expect(readManifest('{')).toMatchObject({ error: expect.stringMatching(/isn’t JSON/) })
    expect(readManifest(JSON.stringify({ id: 'Bad Id', name: 'x', version: '1' }))).toMatchObject({ error: expect.stringMatching(/^plugin.json: id:/) })
    expect(readManifest(JSON.stringify({ id: 'a', name: 'A', version: '1', main: '../x.js' }))).toMatchObject({ error: expect.stringMatching(/main/) })
    const twice = { id: 'a', name: 'A', version: '1', exporters: [{ id: 'wiki', title: 'Wiki' }, { id: 'wiki', title: 'Wiki again' }] }
    expect(readManifest(JSON.stringify(twice))).toEqual({ error: 'plugin.json: two exporters are called wiki' })
  })
})

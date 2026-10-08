import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Project } from '@universe/db'
import { OPERATIONS, apiContext, projectHost, type ApiHost } from './index'

/** A project file in a temp folder with one world on it (Virgo › Milky Way › Sol › Terra › Terra Surface), and a way to call operations. */
export function testProject() {
  const dir = mkdtempSync(join(tmpdir(), 'universe-api-'))
  const project = Project.create(join(dir, 'Test.universe'), 'Test')
  const root = project.info().rootId
  const make = (parentId: string, kind: string, name: string) => project.bus.execute({ type: 'node.create', payload: { parentId, kind, name } }).targetId!
  const galaxyId = make(make(root, 'galaxy_cluster', 'Virgo'), 'galaxy', 'Milky Way')
  const systemId = make(galaxyId, 'star_system', 'Sol')
  const bodyId = make(systemId, 'body', 'Terra')
  const worldId = make(bodyId, 'world', 'Terra Surface')
  const host: ApiHost = projectHost(project)
  const ctx = apiContext(host)
  const call = async <T = Record<string, unknown>>(name: string, input: object = {}): Promise<T> => {
    const op = OPERATIONS.find((o) => o.name === name)
    if (!op) throw new Error(`no operation ${name}`)
    return (await op.run(ctx, op.input.parse(input))) as T
  }
  return { project, host, ctx, call, worldId, systemId, galaxyId, bodyId, close: () => (project.close(), rmSync(dir, { recursive: true, force: true })) }
}

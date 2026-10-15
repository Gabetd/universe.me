import type { ApiHost } from './host'
import { ProjectModels } from './model'
import type { ApiContext, Operation } from './operation'
import { READS } from './reads'
import { WRITES } from './writes'
import { CANVAS_OPERATIONS } from './canvas'
import { MAP_PIN_OPERATIONS } from './map-pins'
import { MEDIA_OPERATIONS } from './media'
import { SCAR_OPERATIONS } from './scars'
import { LANGUAGE_OPERATIONS } from './languages'

/** Every operation the API serves, reads first. */
export const OPERATIONS: readonly Operation[] = [...READS, ...WRITES, ...CANVAS_OPERATIONS, ...MAP_PIN_OPERATIONS, ...MEDIA_OPERATIONS, ...LANGUAGE_OPERATIONS, ...SCAR_OPERATIONS]

/** The operation with this name, if there is one. */
export const operationNamed = (name: string) => OPERATIONS.find((o) => o.name === name)

/** Runs an operation by name, its input checked. */
export function runOperation(ctx: ApiContext, name: string, input: unknown): unknown {
  const op = operationNamed(name)
  if (!op) throw new Error(`There is no operation ${name}`)
  return op.run(ctx, op.input.parse(input))
}

/** `/worlds/:worldId` → ['worldId']: the inputs a route's path carries. */
export const pathParams = (op: Operation) => [...op.route.path.matchAll(/:(\w+)/g)].map((m) => m[1]!)

/** What operations run with, for one host. */
export const apiContext = (host: ApiHost): ApiContext => ({ host, models: new ProjectModels(host) })

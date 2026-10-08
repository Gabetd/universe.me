import type { ApiHost } from './host'
import { ProjectModels } from './model'
import type { ApiContext, Operation } from './operation'
import { READS } from './reads'
import { WRITES } from './writes'

/** Every operation the API serves, reads first. */
export const OPERATIONS: readonly Operation[] = [...READS, ...WRITES]

/** What operations run with, for one host. */
export const apiContext = (host: ApiHost): ApiContext => ({ host, models: new ProjectModels(host) })

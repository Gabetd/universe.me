import type { ApiHost } from './host'
import { ProjectModels } from './model'
import type { ApiContext, Operation } from './operation'
import { READS } from './reads'
import { WRITES } from './writes'

export * from './host'
export type { ApiContext, Operation } from './operation'
export { ProjectModels, type When } from './model'
export { htmlToText, textToHtml } from './text'
export { exportWorldBible } from './bible'
export { projectHost } from './project-host'

/** Every operation the API serves, reads first. */
export const OPERATIONS: readonly Operation[] = [...READS, ...WRITES]

/** What operations run with, for one host. */
export const apiContext = (host: ApiHost): ApiContext => ({ host, models: new ProjectModels(host) })

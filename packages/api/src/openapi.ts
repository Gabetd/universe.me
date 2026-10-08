import { z } from 'zod'
import { pathParams } from './catalog'
import type { Operation } from './operation'


/** `/worlds/:worldId` as OpenAPI writes it: `/worlds/{worldId}`. */
export const openApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}')

const schemaOf = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any', target: 'openapi-3.0' }) as Record<string, unknown>

/**
 * The OpenAPI 3 description of the REST API (PLAN.md §6.1), made from the
 * operations' input schemas: reads take their inputs from the path and the
 * query string, writes from the path and a JSON body.
 */
export function openApi(operations: readonly Operation[], version: string) {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const op of operations) {
    const inPath = pathParams(op)
    const shape = op.input.shape as Record<string, z.ZodType>
    const parameters = Object.entries(shape)
      .filter(([name]) => inPath.includes(name) || op.route.method === 'GET')
      .map(([name, s]) => ({ name, in: inPath.includes(name) ? 'path' : 'query', required: inPath.includes(name) || !s.safeParse(undefined).success, schema: schemaOf(s), description: s.description }))
    const body = op.route.method === 'POST' ? op.input.omit(Object.fromEntries(inPath.map((n) => [n, true])) as never) : undefined
    ;(paths[`/v1${openApiPath(op.route.path)}`] ??= {})[op.route.method.toLowerCase()] = {
      operationId: op.name,
      summary: op.title,
      description: op.description,
      tags: [op.write ? 'Write' : 'Read'],
      parameters,
      ...(body && { requestBody: { required: true, content: { 'application/json': { schema: schemaOf(body) } } } }),
      responses: {
        200: { description: op.write ? 'Applied, or proposed for review: `status` says which' : 'The answer', content: { 'application/json': {} } },
        400: { description: 'The input or the command is invalid' },
        401: { description: 'No token, or the wrong one' },
        404: { description: 'Something it names doesn’t exist' },
        409: { description: 'No project is open' }
      }
    }
  }
  paths['/v1/changes'] = {
    get: {
      operationId: 'changes',
      summary: 'Change feed',
      description: 'Server-sent events: a `change` event whenever the project changes (from the app or the API), with what changed and who changed it.',
      responses: { 200: { description: 'An event stream', content: { 'text/event-stream': {} } } }
    }
  }
  return {
    openapi: '3.0.3',
    info: { title: 'Universe local API', version, description: 'The open project in the Universe app. Every write is validated, tagged as an API change and can be undone in the app.' },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
    paths
  }
}

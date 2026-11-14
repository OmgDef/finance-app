import { mkdir, writeFile } from 'node:fs/promises';
import { errorSchema, routes } from './index.ts';

const vmServer = (port: string) => ({
  url: 'https://{host}:{port}', variables: { host: { default: '192.168.139.211' }, port: { default: port } },
});

const paths: Record<string, Record<string, unknown>> = {};
for (const [operationId, route] of Object.entries(routes)) {
  const admin = route.access === 'admin';
  const changes = route.method !== 'GET';
  const hasBody = route.method === 'POST' || route.method === 'PUT';
  const parameters: unknown[] = [];
  if ('params' in route) {
    for (const [name, schema] of Object.entries(route.params.properties)) {
      parameters.push({ name, in: 'path', required: true, schema });
    }
  }
  if ('query' in route) {
    const required: readonly string[] = route.query.required ?? [];
    for (const [name, schema] of Object.entries(route.query.properties)) {
      parameters.push({ name, in: 'query', required: required.includes(name), schema });
    }
  }
  if (admin && changes) parameters.push({
    name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string' },
  });
  if (route.access === 'admin-step' || (admin && changes)) parameters.push({
    name: 'Origin', in: 'header', required: true, schema: { type: 'string' },
    description: 'Must match the configured administrative HTTPS origin',
  });
  const path = route.url.replace(/:([^/]+)/g, '{$1}');
  (paths[path] ??= {})[route.method.toLowerCase()] = {
    operationId, summary: route.summary,
    ...('description' in route && { description: route.description }),
    servers: route.url.includes('/admin/') ? [vmServer('18444')] : undefined,
    security: admin ? [{ adminCookie: [] }] : route.access === 'mobile' ? [{ bearer: [] }] : [],
    parameters,
    requestBody: hasBody && !('optionalBody' in route)
      ? { required: true, content: { 'application/json': { schema: route.body } } } : undefined,
    responses: {
      200: { description: 'Success', content: { 'application/json': { schema: route.result } } },
      429: {
        description: 'Fixed rate limit exceeded', headers: { 'Retry-After': { schema: { type: 'integer' } } },
        content: { 'application/json': { schema: errorSchema } },
      },
      ...('failures' in route && Object.fromEntries(Object.entries(route.failures).map(([status, description]) => [
        status, { description, content: { 'application/json': { schema: errorSchema } } },
      ]))),
      default: { description: 'Error', content: { 'application/json': { schema: errorSchema } } },
    },
  };
}

await mkdir('dist', { recursive: true });
await writeFile('dist/openapi.json', JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'TэтаФинанс API', version: '0.1.0' },
  servers: [vmServer('18443')],
  paths,
  components: { securitySchemes: {
    bearer: { type: 'http', scheme: 'bearer' },
    adminCookie: { type: 'apiKey', in: 'cookie', name: '__Host-teta-admin' },
  } },
}, null, 2) + '\n');

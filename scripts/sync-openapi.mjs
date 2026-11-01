import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OPERATIONS = [
  ['/v1/agent-runs', 'post'],
  ['/v1/agent-runs/{id}', 'patch'],
  ['/v1/agent-runs/{id}/heartbeat', 'post'],
  ['/v1/agent-runs/{id}/events', 'post'],
  ['/v1/agent-runs/{id}/events', 'get'],
  ['/v1/agent-work/conventions', 'get'],
  ['/v1/agent-runs/pairable', 'get'],
  ['/v1/agent-runs/pair', 'post'],
];

export function slice(spec) {
  const paths = {};
  const refs = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) k === '$ref' ? refs.push(v) : walk(v);
  };
  for (const [path, method] of OPERATIONS) {
    const op = spec.paths[path]?.[method];
    if (!op) throw new Error(`missing ${method.toUpperCase()} ${path}`);
    (paths[path] ??= {})[method] = op;
    walk(op);
  }
  const components = { securitySchemes: { bearerAuth: spec.components.securitySchemes.bearerAuth } };
  while (refs.length) {
    const [, , kind, name] = refs.shift().split('/');
    if (components[kind]?.[name]) continue;
    const value = spec.components[kind][name];
    (components[kind] ??= {})[name] = value;
    walk(value);
  }
  return { openapi: spec.openapi, info: { title: spec.info.title, version: spec.info.version }, paths, components };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) throw new Error('usage: node scripts/sync-openapi.mjs <eocrm checkout>');
  const spec = JSON.parse(readFileSync(join(root, 'apps/api/openapi/openapi.json'), 'utf8'));
  const out = new URL('../test/contract/openapi.agent.json', import.meta.url);
  writeFileSync(out, `${JSON.stringify(slice(spec), null, 2)}\n`);
  console.log(`openapi.agent.json: ${spec.info.version}`);
}

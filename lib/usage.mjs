import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export function readUsage(path, offset, maxBytes = 8 * 1024 * 1024, seen = []) {
  const models = {};
  const ids = new Set(seen);
  const fresh = [];
  let buf;
  try {
    const fd = openSync(path, 'r');
    try {
      const n = Math.max(0, Math.min(maxBytes, fstatSync(fd).size - offset));
      buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, offset);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { offset, models, ids: fresh };
  }
  const end = buf.lastIndexOf(10) + 1 || (buf.length === maxBytes ? buf.length : 0);
  for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o?.message;
    const u = m?.usage;
    if (o?.type !== 'assistant' || !u || typeof m.model !== 'string' || !m.model || m.model === '<synthetic>') continue;
    if (m.id) {
      if (ids.has(m.id)) continue;
      ids.add(m.id);
      fresh.push(m.id);
    }
    const t = (models[m.model] ??= { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
    const add = (k, v) => { if (Number.isSafeInteger(v) && v > 0) t[k] += v; };
    add('input_tokens', u.input_tokens);
    add('output_tokens', u.output_tokens);
    add('cache_read_tokens', u.cache_read_input_tokens);
    add('cache_write_tokens', u.cache_creation_input_tokens);
  }
  return { offset: offset + end, models, ids: fresh };
}

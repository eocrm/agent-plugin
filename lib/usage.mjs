import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MAX_FILES = 64;

export function readUsage(path, offset, maxBytes = 8 * 1024 * 1024, seen = [], lineCap = maxBytes) {
  const models = {};
  const ids = new Set(seen);
  const fresh = [];
  let buf;
  let size;
  let reset = false;
  try {
    const fd = openSync(path, 'r');
    try {
      size = fstatSync(fd).size;
      if (size < offset) {
        offset = 0;
        reset = true;
      }
      const n = Math.max(0, Math.min(maxBytes, size - offset));
      buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, offset);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { from: offset, offset, models, ids: fresh, reset };
  }
  const end = buf.lastIndexOf(10) + 1 || (buf.length >= lineCap && offset + buf.length < size ? buf.length : 0);
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
  return { from: offset, offset: offset + end, models, ids: fresh, reset };
}

export function transcriptFiles(path) {
  const dir = join(dirname(path), basename(path, '.jsonl'), 'subagents');
  let subs = [];
  try {
    subs = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => join(dir, f));
  } catch {
    // no subagents
  }
  return [path, ...subs];
}

export function sizesOf(path) {
  const out = {};
  for (const f of transcriptFiles(path)) {
    try {
      out[f] = statSync(f).size;
    } catch {
      // gone
    }
  }
  return out;
}

export function readSession(path, offsets = {}, seen = [], maxTotal = 8 * 1024 * 1024, epochs = {}) {
  const next = { ...offsets };
  const nextEpochs = { ...epochs };
  const ids = [];
  const reads = [];
  let left = maxTotal;
  for (const f of transcriptFiles(path)) {
    if (left <= 0) break;
    const r = readUsage(f, offsets[f] ?? 0, left, [...seen, ...ids], maxTotal);
    left -= r.offset - r.from;
    ids.push(...r.ids);
    delete next[f];
    next[f] = r.offset;
    if (r.reset) nextEpochs[f] = (nextEpochs[f] ?? 0) + 1;
    reads.push({ file: f, from: r.from, epoch: nextEpochs[f] ?? 0, models: r.models });
  }
  const subs = Object.keys(next).filter((f) => f !== path).slice(-MAX_FILES);
  const keep = path in next ? [path, ...subs] : subs;
  const pick = (m) => Object.fromEntries(keep.filter((f) => f in m).map((f) => [f, m[f]]));
  return { offsets: pick(next), epochs: pick(nextEpochs), ids, reads };
}

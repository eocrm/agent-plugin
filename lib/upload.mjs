import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

export const TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
};

const TASK_KEY = /^[A-Za-z][A-Za-z0-9]{1,9}-[0-9]+$/;
const TARGET = /^([a-z][a-z0-9_]{0,63}):([^\s:]{1,64})$/;

export function parseTarget(to) {
  const t = String(to ?? '').trim();
  const key = TASK_KEY.test(t) ? t : TASK_KEY.test(t.replace(/^task:/, '')) ? t.slice(5) : null;
  if (key) throw new Error(`--to needs the task id, not its key ${key}: get the id with the MCP tasks_get tool, then pass --to task:<id>`);
  const m = TARGET.exec(t);
  if (!m) throw new Error('--to must be <entity_type>:<id>, like task:<id>');
  return { entity_type: m[1], entity_id: m[2] };
}

export const mimeOf = (file) => TYPES[extname(file).slice(1).toLowerCase()] ?? null;

// Mirrors RichMarkdown::fromDoc's attachment block: text(..., html: true), dest() and title().
const escName = (s) => s.replace(/[\\`*_[\]<>~]|(?<=<)!|!$|&(?=#?\w+;)/g, '\\$&').replaceAll('\r', '&#13;');
const dest = (u) => {
  const e = u.replace(/[\\<>]|&(?=#?\w+;)/g, '\\$&');
  return /[\s()]/.test(e) ? `<${e}>` : e;
};
const title = (s) => `"${s.replace(/[\\"]|(?<=<)!|&(?=#?\w+;)/g, '\\$&')}"`;

export const richText = (id, name, mime) => `[${escName(name)}](${dest(`attachment:/api/v1/files/${id}/content`)} ${title(JSON.stringify({ mime }))})`;

const ACCEPTED = Object.keys(TYPES).join(', ');

function refusal(r, login) {
  if (r.status === 401) return `signed out: run ${login}`;
  const msg = typeof r.body?.message === 'string' ? r.body.message : `HTTP ${r.status}`;
  if (r.body?.code === 'agent_runs_scope_required') return `${msg} (run ${login})`;
  return msg;
}

export async function uploadOne({ client, fetch = globalThis.fetch, file, target, group, login }) {
  const mime = mimeOf(file);
  if (!mime) throw new Error(`unsupported file type; accepted: ${ACCEPTED}`);
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new Error('no such file');
  }
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size === 0) throw new Error('file is empty');
  const filename = basename(file);
  const ticket = await client.requestUpload({ ...target, filename, content_type: mime, size: st.size, ...(group ? { group_id: group } : {}) });
  if (ticket.status !== 200 || typeof ticket.body?.url !== 'string') throw new Error(refusal(ticket, login));
  const { id, url, fields } = ticket.body;
  const form = new FormData();
  for (const [k, v] of Object.entries(fields ?? {})) form.append(k, v);
  form.append('file', new Blob([readFileSync(file)], { type: mime }), filename);
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(Math.max(120_000, st.size / 50)) });
  } catch (e) {
    throw new Error(`storage upload failed (${e?.name === 'TimeoutError' ? 'timeout' : 'network error'})`, { cause: e });
  }
  if (!res.ok) throw new Error(`storage upload failed (status ${res.status})`);
  const done = await client.completeUpload(id);
  if (done.status !== 200) throw new Error(refusal(done, login));
  return { id, rich_text: richText(id, done.body?.filename ?? filename, done.body?.content_type ?? mime) };
}

export async function uploadAll({ files, out, err, json, ...rest }) {
  const results = [];
  for (const file of files) {
    try {
      const r = await uploadOne({ ...rest, file });
      results.push({ file, ...r });
      if (!json) out(`${file}: ${r.id}\n${r.rich_text}`);
    } catch (e) {
      const error = String(e.message).replace(/^eocrm: /, '');
      results.push({ file, error });
      if (!json) err(`eocrm: ${file}: ${error}`);
    }
  }
  if (json) out(JSON.stringify(results));
  return results.some((r) => r.error) ? 1 : 0;
}

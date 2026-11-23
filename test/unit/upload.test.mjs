import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/eocrm.mjs';
import { parseTarget, richText } from '../../lib/upload.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), `eocrm-${p}-`));
const API = 'https://acme.eu.eocrm.io/api';
const S3 = 'https://s3.example.test/bucket';
const store = { get: async () => ({ access_token: 'tok' }), update: async () => null };

function setup(files = {}) {
  const data = tmp('data');
  writeFileSync(join(data, 'account.json'), JSON.stringify({ region: 'eu', issuer: 'https://id.eu.eocrm.io', workspace: 'acme', workspaces: { acme: 'standalone' } }));
  const dir = tmp('files');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { data, dir };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const ok = (call) => {
  if (call.url === `${API}/v1/files`) {
    const b = JSON.parse(call.body);
    return json(200, { id: `id-${b.filename}`, url: S3, fields: { key: `k/${b.filename}`, Policy: 'p' }, expires_at: 'x' });
  }
  if (call.url === S3) return new Response(null, { status: 204 });
  const id = /files\/([^/]+)\/complete$/.exec(call.url)?.[1];
  if (id) return json(200, { id, filename: id.slice(3), content_type: 'image/png' });
  return json(404, {});
};

async function run(args, { cwd, data, handler = ok }) {
  const out = [];
  const err = [];
  const m = mockFetch(handler);
  try {
    const code = await main({ argv: [...args, '--data', data], cwd, out: (l) => out.push(l), err: (l) => err.push(l), store, harness: 'cli' });
    return { code, out: out.join('\n'), err: err.join('\n'), calls: m.calls };
  } finally {
    m.restore();
  }
}

// Byte for byte with RichMarkdown::fromDoc (apps/api/app/Support/RichDoc/RichMarkdown.php 170-174: attachment
// block; 284-305 text(); 307-312 dest(); 314-317 title()), as FileUploadFinish builds it.
test('the snippet matches RichMarkdown::fromDoc for an attachment block', () => {
  assert.equal(richText('01ABC', 'shot.png', 'image/png'), '[shot.png](attachment:/api/v1/files/01ABC/content "{\\"mime\\":\\"image/png\\"}")');
  assert.equal(richText('01ABC', 'a_b*[c]<!x>&amp;!', 'text/plain'), '[a\\_b\\*\\[c\\]\\<\\!x\\>\\&amp;\\!](attachment:/api/v1/files/01ABC/content "{\\"mime\\":\\"text/plain\\"}")');
});

test('the happy path requests, posts to storage without auth, completes, and prints the snippet', async () => {
  const { data, dir } = setup({ 'shot.png': 'PNGDATA' });
  const r = await run(['upload', join(dir, 'shot.png'), '--to', 'task:01TASK', '--group', 'g1'], { cwd: dir, data });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.url}`), [`POST ${API}/v1/files`, `POST ${S3}`, `POST ${API}/v1/files/id-shot.png/complete`]);
  assert.deepEqual(JSON.parse(r.calls[0].body), { entity_type: 'task', entity_id: '01TASK', filename: 'shot.png', content_type: 'image/png', size: 7, group_id: 'g1' });
  assert.equal(r.calls[0].headers.authorization, 'Bearer tok');
  assert.equal(r.calls[1].headers.authorization, undefined);
  const form = r.calls[1].body;
  assert.deepEqual([...form.keys()], ['key', 'Policy', 'file']);
  assert.equal(await form.get('file').text(), 'PNGDATA');
  assert.equal(form.get('file').name, 'shot.png');
  assert.equal(r.out, `${join(dir, 'shot.png')}: id-shot.png\n${richText('id-shot.png', 'shot.png', 'image/png')}`);
});

test('an unknown extension, a missing file and an empty file are refused before any request', async () => {
  const { data, dir } = setup({ 'x.exe': 'MZ', 'empty.txt': '' });
  mkdirSync(join(dir, 'd.txt'));
  const r = await run(['upload', join(dir, 'x.exe'), join(dir, 'nope.pdf'), join(dir, 'empty.txt'), join(dir, 'd.txt'), '--to', 'task:1'], { cwd: dir, data });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.err, /x\.exe: unsupported file type; accepted: pdf, png/);
  assert.match(r.err, /nope\.pdf: no such file/);
  assert.match(r.err, /empty\.txt: file is empty/);
  assert.match(r.err, /d\.txt: not a regular file/);
});

test('the API\'s own message is shown on 422 and 403', async () => {
  const { data, dir } = setup({ 'a.pdf': 'A', 'b.pdf': 'B' });
  const handler = (call) => {
    const name = call.url.endsWith('/v1/files') ? JSON.parse(call.body).filename : null;
    if (name === 'a.pdf') return json(422, { message: 'The file may not be larger than 25 MB.', errors: {} });
    if (name === 'b.pdf') return json(403, { code: 'agent_runs_scope_required', message: 'Reconnect your AI assistant to let it report agent runs.' });
    return ok(call);
  };
  const r = await run(['upload', join(dir, 'a.pdf'), join(dir, 'b.pdf'), '--to', 'task:1'], { cwd: dir, data, handler });
  assert.equal(r.code, 1);
  assert.match(r.err, /a\.pdf: The file may not be larger than 25 MB\./);
  assert.match(r.err, /b\.pdf: Reconnect your AI assistant to let it report agent runs\. \(run eocrm login\)/);
});

test('one failure does not stop the rest; --json prints one array and the exit code is non-zero', async () => {
  const { data, dir } = setup({ 'a.png': 'A', 'b.png': 'B' });
  const handler = (call) => (call.url === S3 && call.body.get('key') === 'k/a.png' ? new Response('denied', { status: 403 }) : ok(call));
  const r = await run(['upload', join(dir, 'a.png'), join(dir, 'b.png'), '--to', 'contact:c1', '--json'], { cwd: dir, data, handler });
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out), [
    { file: join(dir, 'a.png'), error: 'storage upload failed (status 403)' },
    { file: join(dir, 'b.png'), id: 'id-b.png', rich_text: richText('id-b.png', 'b.png', 'image/png') },
  ]);
  assert.ok(!r.calls.some((c) => c.url.endsWith('/id-a.png/complete')));
});

test('--to takes <entity_type>:<id> and refuses a task key', async () => {
  assert.deepEqual(parseTarget('task:01HX'), { entity_type: 'task', entity_id: '01HX' });
  assert.deepEqual(parseTarget('deal:42'), { entity_type: 'deal', entity_id: '42' });
  for (const bad of ['ABC-12', 'task:ABC-12']) assert.throws(() => parseTarget(bad), /task id, not its key ABC-12.*tasks_get/);
  for (const bad of ['', 'task', 'task:', ':1', 'Task:1', 'task:a b']) assert.throws(() => parseTarget(bad), /<entity_type>:<id>/, bad);
  const { data, dir } = setup({ 'a.png': 'A' });
  const r = await run(['upload', join(dir, 'a.png'), '--to', 'ABC-12'], { cwd: dir, data });
  assert.equal(r.code, 2);
  assert.equal(r.calls.length, 0);
});

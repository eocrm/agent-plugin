import { createHash } from 'node:crypto';
import { withLock, loadRun, saveRun } from './state.mjs';
import { flush, fingerprint } from './flush.mjs';
import { clean } from './scrub.mjs';
import { endpoints } from './endpoints.mjs';
import { credentialStore } from './credentials.mjs';
import { reconcileNow, runClient, logError } from './run.mjs';

const GATE_MS = 25000;
const FLUSH_MS = 20000;
const REQUEST_MS = 3000;
// A send can outlast flush's deadline by one call, its refresh and its retry.
const OVERRUN_MS = 3 * REQUEST_MS + 1000;
const SHOWN = 5;
const REASON_MAX = 1000;
const KEEP = 500;
const LOCK_MS = 1500;
const TAIL = '. Fix what it names or tell the member; tracking continues.';

const item = (r) => `${r.type} "${r.label}" (${r.status} ${r.code ?? r.message})`;

function reason(rejected) {
  const head = `eocrm refused ${rejected.length} tracking update(s): ${rejected.slice(-SHOWN).map(item).join('; ')}`;
  return clean(head, REASON_MAX - TAIL.length) + TAIL;
}

// Signs out only if the tokens that got the 401 are still the stored ones.
async function signOut(ctx, store, key, before) {
  try {
    const latest = await store.get(key, { timeoutMs: 2500 });
    if (before?.access_token && latest?.access_token === before.access_token) await store.del(key);
  } catch (e) {
    logError(ctx.data, e);
  }
}

export async function stopGate(ctx, input) {
  const started = Date.now();
  const sid = input.session_id;
  await reconcileNow(ctx, input, 'Stop');
  const run = loadRun(ctx.data, sid);
  const store = ctx.store ?? credentialStore({ data: ctx.data });
  const key = run.region ? endpoints({ region: run.region, env: ctx.env }).key : null;
  const before = key ? await store.get(key, { timeoutMs: 2500 }).catch(() => null) : null;
  const deadlineMs = Math.max(0, Math.min(FLUSH_MS, GATE_MS - (Date.now() - started) - OVERRUN_MS));
  const result = await flush({ data: ctx.data, sessionId: sid, deadlineMs, clientFor: ctx.clientFor ?? runClient({ ...ctx, store }, { timeoutMs: REQUEST_MS }) });
  if (result.signedOut && key) await signOut(ctx, store, key, before);

  const { rejected, blockedFingerprints } = loadRun(ctx.data, sid);
  if (!rejected.length) return {};
  const fp = createHash('sha256').update(rejected.map(fingerprint).sort().join('\n')).digest('base64url');
  if (blockedFingerprints.includes(fp)) return {};
  try {
    await withLock(ctx.data, async () => {
      const seen = loadRun(ctx.data, sid).blockedFingerprints;
      saveRun(ctx.data, sid, { blockedFingerprints: [...seen, fp].slice(-KEEP) });
    }, { giveUpMs: LOCK_MS });
  } catch (e) {
    logError(ctx.data, e);
    // Unrecorded, the same block would loop through every continuation.
    if (input.stop_hook_active) return {};
  }
  return { stdout: JSON.stringify({ decision: 'block', reason: reason(rejected) }) };
}

import { createHash } from 'node:crypto';
import { withLock, loadRun, saveRun } from './state.mjs';
import { flush, fingerprint } from './flush.mjs';
import { clean } from './scrub.mjs';
import { endpoints } from './endpoints.mjs';
import { credentialStore } from './credentials.mjs';
import { until } from './reconcile.mjs';
import { reconcileNow, runClient, logError, waitMs } from './run.mjs';
import { drain, output } from './remind.mjs';

// Under the hook's 30 s timeout, with room for node to start and exit.
const GATE_MS = 24000;
const FLUSH_MS = 20000;
const REQUEST_MS = 3000;
// A send can outlast flush's deadline by one call, its refresh and its retry.
const OVERRUN_MS = 3 * REQUEST_MS + 1000;
const SHOWN = 5;
const REASON_MAX = 1000;
const LABEL_MAX = 80;
const KEEP = 500;
const LOCK_MS = 1500;
const TAIL = '. Fix what it names or tell the member; tracking continues.';
const WORD = /^[a-z_]{1,40}$/;
const FIELD = /^[a-z_.]{1,40}$/;
const UNSAFE = /["'`‘-‟\p{Cc}\p{Cf}]/gu;

// Server free text never reaches the model: only patterned tokens and the member's own label.
function item(r) {
  const label = [...clean(String(r.label ?? ''), 4000).replace(UNSAFE, '')].slice(0, LABEL_MAX).join('');
  const detail = [r.status, WORD.test(r.code) ? r.code : null, ...(Array.isArray(r.fields) ? r.fields.filter((f) => FIELD.test(f)) : [])];
  return `${WORD.test(r.type) ? r.type : 'event'} "${label}" (${detail.filter((d) => d != null).join(' ')})`;
}

function reason(rejected) {
  const head = `eocrm refused ${rejected.length} tracking update(s): ${rejected.slice(-SHOWN).map(item).join('; ')}`;
  return clean(head, REASON_MAX - TAIL.length) + TAIL;
}

async function gate(ctx, input, before, end) {
  const left = (cap) => waitMs(cap, end);
  const sid = input.session_id;
  if (!(await before(end))) return {};
  await reconcileNow(ctx, input, 'Stop', end);
  const run = loadRun(ctx.data, sid);
  const store = ctx.store ?? credentialStore({ data: ctx.data });
  const key = run.region ? endpoints({ region: run.region, env: ctx.env }).key : null;
  const failed = key ? (await store.get(key, { timeoutMs: left(2500) }).catch(() => null))?.access_token : null;
  const deadlineMs = Math.max(0, Math.min(FLUSH_MS, end - Date.now() - OVERRUN_MS));
  const clientFor = ctx.clientFor ?? runClient({ ...ctx, store }, { timeoutMs: REQUEST_MS, end });
  const result = await flush({ data: ctx.data, sessionId: sid, deadlineMs, lockWaitMs: deadlineMs, clientFor });
  // Only the tokens that got the 401: a login since then stays.
  if (result.signedOut && failed) await store.del(key, { when: (t) => t?.access_token === failed, timeoutMs: left(5000) }).catch((e) => logError(ctx.data, e));

  // An agent line at Stop would need a block.
  const shown = await drain(ctx, sid, ['member']);
  const { rejected, blockedFingerprints } = loadRun(ctx.data, sid);
  if (!rejected.length) return output({}, shown);
  const fp = createHash('sha256').update(rejected.map(fingerprint).sort().join('\n')).digest('base64url');
  if (blockedFingerprints.includes(fp)) return output({}, shown);
  try {
    await withLock(ctx.data, async () => {
      const seen = loadRun(ctx.data, sid).blockedFingerprints;
      saveRun(ctx.data, sid, { blockedFingerprints: [...seen, fp].slice(-KEEP) });
    }, { giveUpMs: Math.max(0, Math.min(LOCK_MS, end - Date.now())) });
  } catch (e) {
    logError(ctx.data, e);
    // Unrecorded, the same block would loop through every continuation.
    if (input.stop_hook_active) return output({}, shown);
  }
  return output({ decision: 'block', reason: reason(rejected) }, shown);
}

export async function stopGate(ctx, input, before = async () => true) {
  const end = Date.now() + GATE_MS;
  const body = gate(ctx, input, before, end).catch((e) => {
    logError(ctx.data, e);
    return {};
  });
  return (await until(body, end)) ?? {};
}

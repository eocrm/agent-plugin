export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const REGIONS = ['eu', 'ru'];
const PROBE = 'x0probe0x';
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const DEV_HOST = /(?:^|\.)eocrm(?:-test)?\.local$/;
const REFUSED = 'eocrm: EOCRM_ENDPOINTS needs {issuer, api} with a {workspace} placeholder, on loopback or https *.eocrm.local / *.eocrm-test.local';

// Repo-controlled env reaches hooks, so the override may only name dev hosts.
function trusted(text) {
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.username || u.password || /[?#]/.test(text)) return null;
  const ok = LOOPBACK.has(u.hostname) ? ['http:', 'https:'].includes(u.protocol) : u.protocol === 'https:' && DEV_HOST.test(u.hostname);
  return ok ? u : null;
}

export function endpoints({ region, env = process.env }) {
  if (!REGIONS.includes(region)) throw new Error(`eocrm: unknown region ${JSON.stringify(region)}`);
  let issuer = `https://id.${region}.eocrm.io`;
  let api = `https://{workspace}.${region}.eocrm.io/api`;
  if (env.EOCRM_ENDPOINTS) {
    let o;
    try {
      o = JSON.parse(env.EOCRM_ENDPOINTS);
    } catch {
      o = null;
    }
    if (typeof o?.issuer !== 'string' || typeof o.api !== 'string' || !o.api.includes('{workspace}')) throw new Error(REFUSED);
    const i = trusted(o.issuer);
    if (!i || !trusted(o.api.replaceAll('{workspace}', PROBE))) throw new Error(REFUSED);
    issuer = i.origin;
    api = o.api.replace(/\/+$/, '');
  }
  return {
    issuer,
    key: `${issuer} ${new URL(api.replaceAll('{workspace}', PROBE)).origin.replaceAll(PROBE, '{workspace}')}`,
    api(workspace) {
      if (typeof workspace !== 'string' || !SLUG.test(workspace)) throw new Error('eocrm: invalid workspace slug');
      return api.replaceAll('{workspace}', workspace);
    },
  };
}

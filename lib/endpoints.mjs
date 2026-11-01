export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REGIONS = ['eu', 'ru'];

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
    if (!/^https?:\/\//.test(o?.issuer) || typeof o.api !== 'string' || !o.api.includes('{workspace}')) {
      throw new Error('eocrm: EOCRM_ENDPOINTS needs {issuer, api} with a {workspace} placeholder');
    }
    ({ issuer, api } = o);
  }
  return {
    issuer,
    api(workspace) {
      if (typeof workspace !== 'string' || !SLUG.test(workspace)) throw new Error('eocrm: invalid workspace slug');
      return api.replace('{workspace}', workspace);
    },
  };
}

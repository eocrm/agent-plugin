import { git } from './state.mjs';
import { clean } from './scrub.mjs';

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const FORGE = /^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)$/i;
const UNSAFE = /[@:?#]/;

export function repoSlug(cwd, origin = git(cwd, ['remote', 'get-url', 'origin'])) {
  const url = origin.trim();
  let host;
  let path;
  if (SCHEME.test(url)) {
    try {
      ({ hostname: host, pathname: path } = new URL(url));
    } catch {
      return null;
    }
  } else {
    const colon = url.indexOf(':');
    if (colon < 0) return null;
    const auth = url.slice(0, colon);
    host = auth.slice(auth.lastIndexOf('@') + 1);
    path = url.slice(colon + 1);
    if (host.length < 2 || /[\\/]/.test(host)) return null;
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !path || UNSAFE.test(host + path)) return null;
  return clean(FORGE.test(host) ? path : `${host}/${path}`, 200);
}

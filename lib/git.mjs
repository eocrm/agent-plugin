import { git } from './state.mjs';
import { clean } from './scrub.mjs';

const REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d*)?\/|(?:[^@/:]*@)?([^/:]{2,}):)(.+?)(?:\.git)?\/*$/i;
const FORGE = /^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)$/i;

export function repoSlug(cwd) {
  const m = REMOTE.exec(git(cwd, ['remote', 'get-url', 'origin']));
  if (!m) return null;
  const host = m[1] ?? m[2];
  return clean(FORGE.test(host) ? m[3] : `${host}/${m[3]}`, 200);
}

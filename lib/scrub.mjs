const KEYS = '(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PWD|_PASS(?![A-Z0-9])|API[-_]?KEY|PRIVATE[-_]?KEY)';

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|(?=\n?$))/g, '[redacted]'],
  [/(?<=:\/\/)[^/ \t\r\n\f\v:@]*:[^/ \t\r\n\f\v@]+@/g, '[redacted]@'],
  [/\b(bearer|basic)(\s+)[\w.~+/=-]{8,}/gi, '$1$2[redacted]'],
  [/(\bAuthorization\s*:\s*token)(\s+)[\w.~+/=-]{8,}/gi, '$1$2[redacted]'],
  [/(?<=(["']))(Cookie\s*:\s*)(?:\\.|(?!\1)[^\\\n])*/gi, '$2[redacted]'],
  [/(?<!["'])(\bCookie\s*:\s*)[^\n]+/gi, '$1[redacted]'],
  [new RegExp(`(["']?)(?<![A-Z0-9_-])((?=[A-Z0-9_-]*${KEYS})[A-Z0-9_-]+)\\1(\\s*[=:]\\s*)(?:(")(?:\\\\.|[^"\\\\\\n])*("?)|(')[^'\\n]*('?)|[^ \\t\\r\\n\\f\\v]+)`, 'gi'), '$1$2$1$3$4$6[redacted]$5$7'],
  [/eok_[A-Za-z0-9]{8,}/g, '[redacted]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, '[redacted]'],
  [/AKIA[0-9A-Z]{16}/g, '[redacted]'],
  [/\b(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bglpat-[\w-]{20,}/g, '[redacted]'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, '[redacted]'],
  [/\bAIza[\w-]{30,}/g, '[redacted]'],
];

const KEYS_RE = new RegExp(KEYS, 'i');
const MYSQL = { '-p': 'attached', '--pass': 'any' };

const FLAGS = {
  '': {
    '-u': 'userinfo', '--user': 'userinfo', '--cookie': 'any', '--oauth2-bearer': 'any',
    '--proxy-user': 'any', '-pass': 'openssl', '-passin': 'openssl', '-passout': 'openssl',
  },
  curl: { '-u': 'not-url', '--user': 'not-url', '-b': 'any' },
  mysql: MYSQL, mysqldump: MYSQL, mysqladmin: MYSQL,
  mariadb: MYSQL, 'mariadb-dump': MYSQL, 'mariadb-admin': MYSQL,
  sshpass: { '-p': 'any' },
  'docker login': { '-p': 'any' },
  'redis-cli': { '-a': 'any', '--pass': 'any' },
  zip: { '-P': 'any' },
  '7z': { '-p': 'attached' }, '7za': { '-p': 'attached' }, '7zz': { '-p': 'attached' },
};

export const LIMITS = {
  stepLabel: 200,
  commitSubject: 200,
  commitRepo: 200,
  testCommand: 500,
  resultLine: 500,
  findingSummary: 1000,
  rulingWhat: 500,
  rulingWhy: 1000,
  rulingCostIfWrong: 500,
  prUrl: 500,
};

const SUFFIX = '… [truncated]';
const MAX_SCAN = 16384;

export function scrub(text) {
  if (text.length > MAX_SCAN) return '[redacted: unscannable]';
  let out = '';
  let at = 0;
  let carry = {};
  for (const [inherits, tokens] of segments(text)) {
    carry = flagsFor(text, tokens, inherits ? carry : {});
    for (const [start, end, withText] of redactions(text, tokens, carry)) {
      out += text.slice(at, start) + withText;
      at = end;
    }
  }
  out += text.slice(at);
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return jwt(out);
}

// eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,} as a regex backtracks quadratically on "eyJeyJ…".
function jwt(text) {
  if (!text.includes('eyJ')) return text;
  const runs = [...text.matchAll(/[\w-]+/g)].map((m) => [m.index, m.index + m[0].length]);
  const follows = (a, b) => b[0] === a[1] + 1 && text[a[1]] === '.' && b[1] - b[0] >= 10;
  let out = '';
  let at = 0;
  for (let i = 0; i + 2 < runs.length; i++) {
    const [a, b, c] = runs.slice(i, i + 3);
    const q = a[0] + text.slice(a[0], a[1]).indexOf('eyJ');
    if (q < a[0] || a[1] - q < 13 || !follows(a, b) || !follows(b, c)) continue;
    out += text.slice(at, q) + '[redacted]';
    at = c[1];
    i += 2;
  }
  return out + text.slice(at);
}

export function clean(text, limit) {
  const out = scrub(cut(String(text), limit * 4));
  return out.length > limit ? cut(out, limit - SUFFIX.length) + SUFFIX : out;
}

function cut(text, n) {
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

function segments(text) {
  const result = [];
  let tokens = [];
  let start = null;
  let value = '';
  let quote = '';
  let depth = 0;
  let inherits = false;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const c = text[i];
    const next = text[i + 1] ?? '';
    if (quote !== '' && c !== '\n') {
      if (c === quote) quote = '';
      else value += c === '\\' && quote === '"' && next !== '' && next !== '\n' ? text[++i] : c;
      continue;
    }
    let space = c === ' ' || c === '\t' || c === '\r';
    if (c === '\\' && (next === '\n' || (next === '\r' && text[i + 2] === '\n'))) {
      i += next === '\n' ? 1 : 2;
      space = true;
    }
    let separator;
    switch (c) {
      case '\n': case '|': case ';': case '`': separator = true; break;
      case '&': separator = start === null || next === '' || '& \t\r\n'.includes(next); break;
      case '$': separator = next === '(' && (++i, ++depth) > 0; break;
      case '(': separator = start === null && ++depth > 0; break;
      case ')': separator = depth > 0 && depth-- > 0; break;
      case '{': case '}': case '!': separator = start === null && (next === '' || ' \t\r\n'.includes(next)); break;
      default: separator = false;
    }
    if (c === '\n') {
      quote = '';
      depth = 0;
    }
    if (separator || space) {
      if (start !== null) {
        tokens.push([start, i - (c === '$' ? 1 : 0), value]);
        start = null;
        value = '';
      }
      if (separator) {
        if (tokens.length) {
          result.push([inherits, tokens]);
          tokens = [];
        }
        inherits = !'\n|;&'.includes(c);
      }
      continue;
    }
    start ??= i;
    if (c === '"' || c === "'") quote = c;
    else value += c === '\\' && next !== '' ? text[++i] : c;
  }
  if (start !== null) tokens.push([start, n, value]);
  if (tokens.length) result.push([inherits, tokens]);
  return result;
}

function basename(p) {
  const t = p.replace(/\/+$/, '');
  return t.slice(t.lastIndexOf('/') + 1);
}

function flagsFor(text, tokens, inherited) {
  const flags = { ...inherited };
  const names = new Set();
  for (const [start, end] of tokens) {
    const trimmed = text.slice(start, end).replace(/^[(){}!`$"']+|[(){}!`$"']+$/g, '');
    const name = basename(trimmed.replaceAll('\\', '/')).toLowerCase();
    names.add(name.endsWith('.exe') ? name.slice(0, -4) : name);
  }
  names.delete('');
  if (names.has('login') && (names.has('docker') || names.has('podman') || names.has('nerdctl'))) names.add('docker login');
  for (const name of names) {
    if (!Object.hasOwn(FLAGS, name)) continue;
    for (const [flag, mode] of Object.entries(FLAGS[name])) {
      flags[flag] = mode === 'any' || !(flag in flags) ? mode : flags[flag];
    }
  }
  return flags;
}

function redactions(text, tokens, inherited) {
  const found = [];
  const flags = { ...FLAGS[''], ...inherited };
  const isFlag = (v) => Object.hasOwn(flags, v) || flagValue(v, [[0, v.length, v]], 0, flags)?.length > 0
    || (v.startsWith('--') && KEYS_RE.test(v.split('=')[0]));
  for (let k = 0; k < tokens.length; k++) {
    const [, end, value] = tokens[k];
    if (!value.startsWith('-')) continue;
    let hit = flagValue(text, tokens, k, flags, isFlag);
    const head = value.split('=')[0];
    if (hit === null && KEYS_RE.test(head)) hit = flagValue(text, tokens, k, { [head]: 'any' }, isFlag);
    if (hit !== null && hit.length) {
      found.push(hit);
      k += hit[0] >= end ? 1 : 0;
    }
  }
  return found;
}

function flagValue(text, tokens, k, flags, isFlag) {
  const [start, end, value] = tokens[k];
  for (const [flag, mode] of Object.entries(flags)) {
    if (value === flag) {
      const next = tokens[k + 1];
      const skipsDash = mode === 'userinfo' || mode === 'not-url';
      return mode !== 'attached' && next !== undefined && !(skipsDash && next[2].startsWith('-')) && !isFlag(next[2]) && accepts(mode, next[2])
        ? [next[0], next[1], mask(text.slice(next[0], next[1]), mode)]
        : [];
    }
    let glue = flag.startsWith('--') ? `${flag}=` : flag.length === 2 ? flag : null;
    if (glue === null || value.length <= glue.length || !value.startsWith(glue)) continue;
    if (glue === flag && value[2] === '=' && value.length > 3) glue += '=';
    if (!accepts(mode, value.slice(glue.length))) return [];
    const raw = text.slice(start, end);
    return raw.startsWith(glue)
      ? [start + glue.length, end, mask(raw.slice(glue.length), mode)]
      : [start, end, `${glue}[redacted]`];
  }
  return null;
}

function accepts(mode, value) {
  switch (mode) {
    case 'not-url': return !value.includes('://');
    case 'userinfo': return value.includes(':') && !value.includes('://');
    case 'openssl': return value.startsWith('pass:');
    default: return true;
  }
}

function mask(raw, mode) {
  const quote = raw !== '' && (raw[0] === '"' || raw[0] === "'") ? raw[0] : '';
  const close = quote !== '' && raw.length > 1 && raw.endsWith(quote) ? quote : '';
  return `${quote}${mode === 'openssl' ? 'pass:' : ''}[redacted]${close}`;
}

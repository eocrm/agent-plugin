const KEYS = '(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PWD|_PASS(?![A-Z0-9])|API[-_]?KEY|PRIVATE[-_]?KEY)';
// eocrm's SecretScrubber runs PCRE without /u: \s is ASCII and these are its Unicode spaces.
const WIDE = '\\u0085\\u00a0\\u1680\\u180e\\u2000-\\u200b\\u2028\\u2029\\u202f\\u205f-\\u2064\\u3000\\ufeff';
const S = `[\\s${WIDE}]`;
const H = `[ \\t\\v\\f${WIDE}]`;
const HW = `[ \\t${WIDE}]`;
const NS = '[^ \\t\\n\\v\\f\\r]';
const NAME = `(?<![A-Z0-9_-])(?=[A-Z0-9_-]*${KEYS})[A-Z0-9_-]+`;
const PRE = String.raw`((?:(?<!\\)\\+)?["']?)`;

// X*+ is written X*(?!X): JS has no possessive quantifiers.
const PATTERNS = [
  [/-{4,5}BEGIN [A-Z ]*(?:PRIVATE|SECRET) KEY(?: BLOCK)?-{4,5}[\s\S]*?(?:-{4,5}END [A-Z ]*(?:PRIVATE|SECRET) KEY(?: BLOCK)?-{4,5}|(?=\n?$))/gi, '[redacted]'],
  [/PuTTY-User-Key-File-\d+:[\s\S]*?(?:Private-MAC:[^\n]*|(?=\n?$))/gi, '[redacted]'],
  [/(?<=https:\/\/|http:\/\/)[^/ \t\n\v\f\r:@]+@/g, (m) => (Buffer.byteLength(m) > 16 ? '[redacted]@' : m)],
  [/(?<![\w/:@.%-])[\w.-]+:[^ \t\n\v\f\r@/:]+@(?=[\w.-]+:)/g, '[redacted]@'],
  [new RegExp(`\\b(bearer|basic)(${S}+)[\\w.~+/=-]{8,}`, 'gi'), '$1$2[redacted]'],
  [new RegExp(`\\b(bearer|basic)(${S}*["']?${S}*(?!${S}))(?:\\$\\([^)\\n]*\\)?|\\$\\{[^}\\n]*\\}?|<\\([^)\\n]*\\)?|\`[^\`\\n]*\`?)`, 'gi'), '$1$2[redacted]'],
  [new RegExp(`(\\bAuthorization${S}*:${S}*token)(${S}+)[\\w.~+/=-]{8,}`, 'gi'), '$1$2[redacted]'],
  [new RegExp(`(?<=(["']))(Cookie${S}*:${S}*)(?:\\\\.|(?!\\1)[^\\\\\\n])*`, 'gi'), '$2[redacted]'],
  [new RegExp(`(?<!["'])(\\bCookie${S}*:${S}*)[^\\n]+`, 'gi'), '$1[redacted]'],
  [null, yamlList],
  // After `KEY:` the value is the rest of the line, else the next non-blank line (fail closed).
  [new RegExp(String.raw`${PRE}(${NAME}\1${S}*:(?![:=])${HW}*(?!${HW}))(?:[|>][-+0-9]*[ \t]*(?:\r?\n[ \t]+[^\r\n]*)+|(?:\r?\n${H}*(?!${H}))+(?!\r?\n)(?!-${H}+\[redacted\](?![^\r\n]))[^\r\n]+|[^\r\n]+)`, 'gi'), '$1$2[redacted]'],
  [new RegExp(String.raw`${PRE}(${NAME})\1(${S}*(?:=>|[:?+]=|={1,3}|::|<-)${S}*(?!${S}))(?:(")(?:\\.|[^"\\\n])*("?)|(')[^'\n]*('?)|((?<run>\\+)")(?:[^\\\n]|\\+(?![\\"])|(?=\k<run>\\)\\+")*((?:\\+")?)|\[[^\]\n]*\]?|\{[^}\n]*\}?|(?!-${S})${NS}+)`, 'gi'), '$1$2$1$3$4$6$8[redacted]$5$7$10'],
  [new RegExp(`((?:\\b(?:export|setenv|set[ \\t]+-[A-Z]+)|(?<!${NS})(?:-e|--env))[ \\t]+(?=[A-Z0-9_-]*${KEYS})[A-Z0-9_-]+[ \\t]+)[^\\s=]${NS}*`, 'gi'), '$1[redacted]'],
  [new RegExp(`\\b(IDENTIFIED${S}+BY|PASSWORD)(${S}+)(['"])(?:(?!\\3)[^\\n])*\\3?`, 'gi'), '$1$2$3[redacted]$3'],
  [new RegExp(`(<(?=[\\w:.-]*${KEYS})[\\w:.-]+(?![\\w:.-])[^<>\\n]*>)[^<\\n]+`, 'gi'), '$1[redacted]'],
  [new RegExp(`(\\bhtpasswd[ \\t]+(?:-[A-Zac-z]*[ \\t]+)*-[A-Zac-z]*b[A-Za-z]*(?:[ \\t]+-[A-Za-z]*)*(?![ \\t]+-)[ \\t]+${NS}+[ \\t]+${NS}+[ \\t]+)${NS}+`, 'g'), '$1[redacted]'],
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
const SPACED = new RegExp(S);
const WIDE_OR_COMMA = new RegExp(`[${WIDE}]|,`, 'g');
const SUB_FLAG = new RegExp(`(?:^|${S})(-[^\\s${WIDE}]+)`, 'g');
const USERINFO = /(?<=:\/\/|:\\\/\\\/)[^/ \t\n\v\f\r:@]*:[^ \t\n\v\f\r]*/g;
const YAML_KEY = new RegExp(`${NAME}["']?[ \\t]*:${H}*\\r?\\n`, 'gi');
const H_RE = new RegExp(H);
const MAX_NEST = 4;
const MYSQL = { '-p': 'any', '--pass': 'any' };
const LDAP = { '-w': 'any' };

const FLAGS = {
  '': {
    '-u': 'userinfo', '--user': 'userinfo', '--cookie': 'any', '--oauth2-bearer': 'any',
    '--proxy-user': 'any', '-pass': 'openssl', '-passin': 'openssl', '-passout': 'openssl',
  },
  curl: { '-u': 'not-url', '--user': 'not-url', '-b': 'any', '-U': 'any', '--pass': 'any', '-E': 'userinfo', '--cert': 'userinfo' },
  mysql: MYSQL, mysqldump: MYSQL, mysqladmin: MYSQL,
  mariadb: MYSQL, 'mariadb-dump': MYSQL, 'mariadb-admin': MYSQL,
  sshpass: { '-p': 'any' },
  'docker login': { '-p': 'any' },
  'redis-cli': { '-a': 'any', '--pass': 'any' },
  zip: { '-P': 'any' },
  mongosh: { '-p': 'any' }, mongo: { '-p': 'any' }, smbclient: { '-U': 'any' }, openssl: { '-k': 'any' },
  ldapsearch: LDAP, ldapadd: LDAP, ldapmodify: LDAP, ldapdelete: LDAP, ldapwhoami: LDAP,
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
  const hits = [...listPass(text), ...flagPass(text, 0)].sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  let out = '';
  let at = 0;
  // Overlapping hits redact their union.
  for (const [start, end, withText] of hits) {
    if (end <= at) continue;
    out += text.slice(at, Math.max(at, start)) + withText;
    at = end;
  }
  out = (out + text.slice(at)).replace(USERINFO, (m) => {
    const last = m.lastIndexOf('@');
    return last < 0 ? m : `[redacted]${m.slice(last)}`;
  });
  for (const [re, to] of PATTERNS) out = re ? out.replace(re, to) : to(out);
  return jwt(out);
}

// KEY: followed by YAML list items: each item's value goes (PHP uses \G for the run of items).
function yamlList(text) {
  let out = '';
  let at = 0;
  YAML_KEY.lastIndex = 0;
  for (let m; (m = YAML_KEY.exec(text));) {
    let p = m.index + m[0].length;
    let items = 0;
    for (let item; (item = listItem(text, p)); items++) {
      out += text.slice(at, item[0]) + '[redacted]';
      [, at, p] = item;
    }
    YAML_KEY.lastIndex = items ? p : m.index + 1;
  }
  return out + text.slice(at);
}

// (?:H*+\r?\n)*+H*+-H++[^\r\n]++(\r?\n)? from p: the value's start and end, and the item's end.
function listItem(text, p) {
  const eol = (i) => (text[i] === '\n' ? 1 : text[i] === '\r' && text[i + 1] === '\n' ? 2 : 0);
  const skipH = (i) => {
    while (i < text.length && H_RE.test(text[i])) i++;
    return i;
  };
  let i = skipH(p);
  while (eol(i)) i = skipH(i + eol(i));
  if (text[i] !== '-' || !H_RE.test(text[i + 1] ?? '')) return null;
  const v = skipH(i + 1);
  let e = v;
  while (e < text.length && text[e] !== '\r' && text[e] !== '\n') e++;
  return e > v ? [v, e, e + eol(e)] : null;
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
  const s = String(text);
  const over = s.length > limit * 4;
  // A cut-off token can be a secret prefix too short for its pattern, so it goes.
  const out = scrub(over ? s.slice(0, limit * 4).replace(/(?:^|\s)\S*$/, '') : s);
  if (!over && out.length <= limit) return out;
  const room = limit - SUFFIX.length;
  return room > 0 ? cut(out, room) + SUFFIX : cut(out, limit);
}

function cut(text, n) {
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

// Argv lists and call arguments ("curl", "-b", "x"), across newlines: PHP's
// LITERAL(?:\s*+,\s*+[\[(]?+\s*+LITERAL)++, scanned once, since a JS regex rescans unclosed literals per quote.
function listPass(text) {
  const n = text.length;
  // close[q][p]: the closing quote reached from content position p, or -1.
  const close = { '"': new Int32Array(n + 2).fill(-1), "'": new Int32Array(n + 2).fill(-1) };
  for (let p = n - 1; p >= 0; p--) {
    const c = text[p];
    if (c === '\n') continue;
    close['"'][p] = c === '"' ? p : c !== '\\' ? close['"'][p + 1] : p + 1 < n && text[p + 1] !== '\n' ? close['"'][p + 2] : -1;
    close["'"][p] = c === "'" ? p : close["'"][p + 1];
  }
  const literal = (i) => (text[i] === '"' || text[i] === "'" ? close[text[i]][i + 1] : -1);
  const ws = (j) => {
    while (j < n && ' \t\n\v\f\r'.includes(text[j])) j++;
    return j;
  };
  const hits = [];
  for (let i = 0; i < n; i++) {
    let end = literal(i);
    if (end < 0) continue;
    const tokens = [[i + 1, end, text.slice(i + 1, end), false]];
    for (;;) {
      let j = ws(end + 1);
      if (text[j] !== ',') break;
      j = ws(j + 1);
      if (text[j] === '[' || text[j] === '(') j++;
      j = ws(j);
      const e = literal(j);
      if (e < 0) break;
      tokens.push([j + 1, e, text.slice(j + 1, e), false]);
      end = e;
    }
    if (tokens.length < 2) continue;
    hits.push(...redactions(text, tokens, flagsFor(text, tokens, {}), 0));
    i = end;
  }
  return hits;
}

function flagPass(text, depth) {
  const found = [];
  let carry = {};
  let before = [];
  for (const [inherits, tokens] of segments(text)) {
    // A miscounted bracket over-redacts, never under-redacts.
    carry = flagsFor(text, tokens, inherits ? carry : {});
    found.push(...redactions(text, tokens, carry, depth));
    if (before.length > 1 && awaitsStdin(text, tokens, carry)) found.push([before[1][0], before.at(-1)[1], '[redacted]']);
    before = tokens;
  }
  return found;
}

const ESCAPED_SPACE = /(?:[tnr]|u00(?:20|09|0[aAdD]))/y;

function segments(text) {
  const result = [];
  let tokens = [];
  let start = null;
  let value = '';
  let quote = '';
  let opaque = false;
  let depth = 0;
  let inherits = false;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const c = text[i];
    const next = text[i + 1] ?? '';
    if (quote !== '' && c !== '\n') {
      const escapes = quote !== "'";
      ESCAPED_SPACE.lastIndex = i + 1;
      if (escapes && c === '\\' && (next === '\n' || (next === '\r' && text[i + 2] === '\n'))) {
        i += next === '\n' ? 1 : 2;
        opaque ||= quote === '$';
      } else if (c === (quote === '$' ? "'" : quote)) quote = '';
      else if (quote === '"' && c === '\\' && ESCAPED_SPACE.test(text)) {
        value += ' ';
        i = ESCAPED_SPACE.lastIndex - 1;
      } else if (escapes && c === '\\' && next !== '') {
        opaque ||= quote === '$' && next !== "'" && next !== '\\';
        value += text[++i];
      } else value += c;
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
      // A lone & inside a word is a URL query, not a shell operator.
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
        tokens.push([start, i - (c === '$' ? 1 : 0), bare(value), opaque]);
        start = null;
        value = '';
        opaque = false;
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
    if (c === '$' && (next === "'" || next === '"')) {
      quote = next === "'" ? '$' : '"';
      i++;
    } else if (c === '"' || c === "'") quote = c;
    else value += c === '\\' && next !== '' ? text[++i] : c;
  }
  if (start !== null) tokens.push([start, n, bare(value), opaque]);
  if (tokens.length) result.push([inherits, tokens]);
  return result;
}

// Quotes the shell keeps ("$'-p…'") and a list's trailing comma do not hide a flag; a spaced token stays for nested().
const bare = (v) => (SPACED.test(v) ? v : v.replace(/["']/g, '').replace(/^\$+/, '').replace(/,+$/, ''));

function basename(p) {
  const t = p.replace(/\/+$/, '');
  return t.slice(t.lastIndexOf('/') + 1);
}

// PHP's $a + $b: $a's keys and order, then $b's missing ones.
const plus = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (!Object.hasOwn(out, k)) out[k] = v;
  return out;
};

function flagsFor(text, tokens, inherited) {
  const flags = { ...inherited };
  const names = new Set();
  for (const [start, end, value] of tokens) {
    const raw = text.slice(start, end);
    // A spaced token is a nested command, named when it is scanned.
    const pieces = SPACED.test(value) ? [raw.replace(/^[(){}!`$"']+|[(){}!`$"']+$/g, '')] : raw.split(/[^\w./\\-]+/);
    for (const piece of pieces) {
      const name = basename(piece.replaceAll('\\', '/')).toLowerCase();
      names.add(name.endsWith('.exe') ? name.slice(0, -4) : name);
    }
  }
  names.delete('');
  if (names.has('login') && (names.has('docker') || names.has('podman') || names.has('nerdctl'))) names.add('docker login');
  for (const name of names) {
    if (!Object.hasOwn(FLAGS, name)) continue;
    for (const [flag, mode] of Object.entries(FLAGS[name])) {
      flags[flag] = mode === 'any' || !Object.hasOwn(flags, flag) ? mode : flags[flag];
    }
  }
  return flags;
}

function redactions(text, tokens, inherited, depth) {
  const found = [];
  const flags = plus(inherited, FLAGS['']);
  for (let k = 0; k < tokens.length; k++) {
    const [start, end, value, opaque] = tokens[k];
    // $'…' escapes (\x2d, \055, -) can spell a flag or a command, so the rest of the command goes.
    if (opaque) {
      found.push([start, tokens.at(-1)[1], '[redacted]']);
      break;
    }
    const subs = subFlags(value);
    const last = subs.at(-1);
    if (subs.some((f) => secret(f, flags)) || nested(value, depth)) {
      found.push([start, end, '[redacted]']);
      const next = tokens[k + 1];
      if (next && last !== undefined && secret(last, flags) && value.endsWith(last) && !isFlag(next[2], flags)) {
        found.push([next[0], next[1], '[redacted]']);
        k++;
      }
      continue;
    }
    if (!value.startsWith('-')) continue;
    const nextIsFlag = isFlag(tokens[k + 1]?.[2] ?? '', flags);
    let hit = flagValue(text, tokens, k, flags, nextIsFlag);
    if (hit === null && isKeyword(value)) hit = flagValue(text, tokens, k, { [value.split('=')[0]]: 'any' }, nextIsFlag);
    if (hit !== null && hit.length) {
      found.push(hit);
      k += hit[0] >= end ? 1 : 0;
    }
  }
  return found;
}

// The redaction for the flag at k: null when no flag matches, [] when one matches without a secret value.
function flagValue(text, tokens, k, flags, nextIsFlag) {
  const [, , value] = tokens[k];
  for (const [flag, mode] of Object.entries(flags)) {
    if (value === flag) {
      const next = tokens[k + 1];
      return mode !== 'attached' && next !== undefined && !nextIsFlag
        && (!next[2].startsWith('-') || (mode !== 'userinfo' && mode !== 'not-url')) && accepts(mode, next[2])
        ? [next[0], next[1], mask(text.slice(next[0], next[1]), mode)]
        : [];
    }
    let g = glue(flag);
    if (!glued(value, g)) continue;
    if (g === flag && value[2] === '=' && value.length > 3) g += '=';
    return gluedValue(text, tokens[k], g, mode);
  }
  const c = cluster(value, flags);
  if (c === null) return null;
  const [g, mode] = c;
  return g === value ? flagValue(text, tokens, k, { [value]: mode }, nextIsFlag) : gluedValue(text, tokens[k], g, mode);
}

function gluedValue(text, [start, end, value], g, mode) {
  if (!accepts(mode, value.slice(g.length))) return [];
  const raw = text.slice(start, end);
  const quote = (raw[0] === '"' || raw[0] === "'") && raw.slice(1, 1 + g.length) === g ? raw[0] : '';
  if (quote === '' && !raw.startsWith(g)) return [start, end, `${g}[redacted]`];
  const at = quote.length + g.length;
  return [start + at, end, mask(quote + raw.slice(at), mode).slice(quote.length)];
}

// Clustered short flags (-sSfu, -vp): the cluster up to a command's valued flag, and its mode.
// The every-command defaults stay out, so rsync -avu is not curl -u.
function cluster(value, flags) {
  const n = value.startsWith('-') ? value.length : 0;
  for (let i = 1; i < n && /[A-Za-z0-9]/.test(value[i]); i++) {
    const flag = `-${value[i]}`;
    const mode = Object.hasOwn(flags, flag) ? flags[flag] : null;
    if (mode !== null && mode !== (FLAGS[''][flag] ?? null)) return [value.slice(0, i + 1), i > 1 && mode === 'not-url' ? 'userinfo' : mode];
  }
  return null;
}

function isFlag(value, flags) {
  if (value.startsWith('--') && isKeyword(value)) return true;
  for (const [flag, mode] of Object.entries(flags)) {
    const g = glue(flag);
    if (value === flag || (glued(value, g) && accepts(mode, value.slice(g.length)))) return true;
  }
  const c = cluster(value, flags);
  if (c !== null && (c[0] === value || accepts(c[1], value.slice(c[0].length)))) return true;
  return subFlags(value).some((f) => secret(f, flags));
}

const secret = (flag, flags) => isFlag(flag, flags) || isKeyword(flag);
const isKeyword = (flag) => KEYS_RE.test(flag.split('=')[0]);
const subFlags = (value) => (SPACED.test(value) ? [...value.matchAll(SUB_FLAG)].map((m) => m[1]) : []);

// A token holding a whole command (sh -c "…") is scanned as one; past MAX_NEST it fails closed.
function nested(value, depth) {
  if (!SPACED.test(value) && !value.includes(',')) return false;
  return depth >= MAX_NEST || flagPass(value.replace(WIDE_OR_COMMA, ' '), depth + 1).length > 0;
}

// `… | xargs cmd --password`: the value arrives from the segment before.
function awaitsStdin(text, tokens, flags) {
  const last = tokens.at(-1)[2];
  const all = plus(flags, FLAGS['']);
  return /(?:^|[ \t\n\v\f\r/])xargs(?:[ \t\n\v\f\r]|$)/.test(text.slice(tokens[0][0], tokens.at(-1)[1]))
    && ((Object.hasOwn(all, last) ? all[last] : 'attached') !== 'attached' || (last.startsWith('-') && isKeyword(last)));
}

const glue = (flag) => (flag.startsWith('--') ? `${flag}=` : flag.length === 2 ? flag : null);
const glued = (value, g) => g !== null && value.length > g.length && value.startsWith(g);

function accepts(mode, value) {
  switch (mode) {
    case 'not-url': return !value.includes('://');
    case 'userinfo': return value.includes(':') && !value.includes('://');
    case 'openssl': return value.startsWith('pass:');
    default: return true;
  }
}

function mask(raw, mode) {
  const tail = raw.match(/(?<=["'])[,)\]]+$/)?.[0] ?? '';
  const body = raw.slice(0, raw.length - tail.length);
  const quote = body[0] === '"' || body[0] === "'" ? body[0] : '';
  const close = quote !== '' && body.length > 1 && body.endsWith(quote) ? quote : '';
  return `${quote}${mode === 'openssl' ? 'pass:' : ''}[redacted]${close}${tail}`;
}

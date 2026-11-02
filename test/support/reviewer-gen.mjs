// The independent reviewer's cartesian attack grammar (fix round 3), as a generator.
export const SEC = 'Qv7Wm3Kz9Rt2';
const U = ['\u00a0', '\u1680', '\u2000', '\u2007', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff', '\u0085'];
const FL = [
  ['git', '--cookie', 'any'], ['x', '--oauth2-bearer', 'any'], ['x', '--proxy-user', 'any'], ['x', '-u', 'userinfo'], ['x', '--user', 'userinfo'],
  ['openssl enc', '-pass', 'openssl'], ['openssl', '-passin', 'openssl'], ['openssl', '-passout', 'openssl'],
  ['curl', '-u', 'not-url'], ['curl', '--user', 'not-url'], ['curl', '-b', 'any'],
  ['mysql', '--pass', 'any'], ['mysqldump', '-p', 'attached'], ['mariadb-admin', '-p', 'attached'], ['sshpass', '-p', 'any'],
  ['docker login', '-p', 'any'], ['podman login', '-p', 'any'], ['redis-cli', '-a', 'any'], ['redis-cli', '--pass', 'any'],
  ['zip', '-P', 'any'], ['7z a', '-p', 'attached'],
  ['x', '--token', 'any'], ['x', '--password', 'any'], ['x', '--api-key', 'any'], ['x', '--db-password', 'any'], ['x', '--client-secret', 'any'],
  ['x', '--passphrase', 'any'], ['x', '--private-key', 'any'], ['x', '--auth-token', 'any'], ['x', '-token', 'any'], ['x', '-password', 'any'],
  ['x', '--apikey', 'any'], ['x', '--PASSWD', 'any'], ['x', '--smtp_pass', 'any'], ['x', '--pwd', 'any'],
];
const cores = [SEC, `${SEC}x:y`, `p@${SEC}!`, `${SEC}$HOME`, `-${SEC}`, `${SEC}=z`];
const wrapVal = (raw) => [raw, `"${raw}"`, `'${raw}'`, `"${raw.replace('7', '\\"7')}"`, raw.replace('7', '\\7'), `$'${raw}'`, `"${raw}`, `'${raw}`];
const before = ['', '-v ', '--password ', '-u root ', '"-v" ', '--no-password '];
const after = ['', ' db', ' -v', ' && echo ok', '\nnext', ')'];
const prefixes = ['', 'sudo ', '$(', '"', '/usr/bin/'];

// pick(list) chooses the context per form; the default enumerates them all.
export function* cases(pick) {
  for (const [cmd, flag, mode] of FL) {
    for (const core of cores) {
      if (mode === 'userinfo' && !core.includes(':')) continue;
      const raw = mode === 'openssl' ? `pass:${core}` : core;
      for (const val of wrapVal(raw)) {
        const forms = [];
        if (mode !== 'attached') for (const sp of [' ', '\t', '  ', ' \\\n ', ...U]) forms.push(`${flag}${sp}${val}`);
        if (flag.startsWith('--')) forms.push(`${flag}=${val}`);
        if (flag.length === 2 && !(mode !== 'attached' && val.startsWith('-'))) forms.push(`${flag}${val}`);
        if (flag.length === 2 && flag[1] !== '-' && mode !== 'attached') forms.push(`${flag}=${val}`);
        const each = (list) => (pick ? [pick(list)] : list);
        for (const f of forms) for (const b of each(before)) for (const a of each(after)) for (const p of each(prefixes)) {
          yield p === '"' ? `${p}${cmd} ${b}${f}${a}"` : `${p}${cmd} ${b}${f}${a}`;
        }
        for (const sp of [' ', ...U]) yield `sh -c "${cmd}${sp}${flag}${sp}${val.replaceAll('"', '\\"')}"`;
      }
    }
  }
  const ctx = (s) => [s, `"${s}"`, `'${s}'`, `curl -H "${s}" https://x`, `echo ${s} | x`, `{"k":"${s.replaceAll('"', '\\"')}"}`, `a\u00a0${s}\u3000b`, `log: ${s}.`];
  const shapes = [
    `-----BEGIN PRIVATE KEY-----\nMIIE${SEC}abc\n-----END PRIVATE KEY-----`, `-----BEGIN OPENSSH PRIVATE KEY-----\n${SEC}`,
    `-----BEGIN ENCRYPTED PRIVATE KEY-----\r\n${SEC}\r\n-----END ENCRYPTED PRIVATE KEY-----`,
    `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ${SEC}.sig${SEC}abc`, `eyJhbGciOiJIUzI1NiJ9.eyJ${SEC}.${SEC}`,
    `https://u:${SEC}@h/x`, `https://:${SEC}@h`, `postgres://app:${SEC}@db:5432/x`, `redis://default:${SEC}@r:6379`, `HTTPS://U:${SEC}@H`,
    `Cookie: sid=${SEC}`, `cookie:${SEC}`, `Set-Cookie: sid=${SEC}; HttpOnly`, `Authorization: Bearer ${SEC}`, `authorization: basic ${SEC}`,
    `Authorization: token ${SEC}`, `Authorization:Bearer\t${SEC}`, `Proxy-Authorization: Basic ${SEC}`, `Authorization: Bearer\u00a0${SEC}`,
    `X-Api-Key: ${SEC}`, `api_key=${SEC}`, `"api_key": "${SEC}"`, `apiKey: '${SEC}'`, `export GH_TOKEN=${SEC}`, `PGPASSWORD=${SEC} psql`,
    `MYSQL_PWD=${SEC}`, `client_secret=${SEC}&grant=x`, `?access_token=${SEC}&a=b`, `password = "${SEC} two"`, `SECRET_KEY_BASE=${SEC}`,
    `"password":"a\\"${SEC}"`, `private_key: ${SEC}`, `x-auth-token: ${SEC}`, `aws_secret_access_key = ${SEC}`, `token:${SEC}`,
    `TOKEN\u00a0=\u00a0${SEC}`, `TOKEN=\u00a0${SEC}`, `password:\n  ${SEC}`, `--set password=${SEC}`, `-e DB_PASSWORD=${SEC}`,
  ];
  for (const sh of shapes) for (const c of ctx(sh)) yield c;
}

// Accepted: curl -u/--user never takes a dash-led value (ruling);
// a single-dash keyword flag after a secret flag is taken as that flag's value (ruling 5);
// 7z's bare -p prompts, so the next word is not its value (also inside sh -c).
export const accepted = (t) => /\bcurl\b[^\n]*?(?:-u|--user)(?:[\s=]|\\\n)+["'$]*-Qv/.test(t)
  || /--(?:no-)?password -(?:token|password)(?:[\s\u0085]|\\\n)/.test(t)
  || /^sh -c "7z a[\s\u0085]-p[\s\u0085]/.test(t);

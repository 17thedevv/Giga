import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';

const args = process.argv.slice(2);
const local = args.includes('--local');
const value = (name) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args.some(arg => arg !== '--local' && !/^--(origin|tls-dir|output|from)=.+/.test(arg))) {
  throw new Error('Use --local OR --origin=https://host --tls-dir=/absolute/certs. Use --from=ENV --output=NEW_ENV to retain existing credentials.');
}
const origin = local ? 'http://localhost:8080' : value('origin');
let url;
try { url = new URL(origin); } catch { throw new Error('Supply --local or a valid HTTPS --origin'); }
if (url.origin !== origin || url.username || url.password || (!local && (url.protocol !== 'https:' || url.port))) {
  throw new Error('Origin must be an exact HTTPS origin on port 443; loopback HTTP requires --local');
}
if (local && (value('origin') || value('tls-dir'))) throw new Error('--local cannot be combined with TLS options');
const tlsDir = local ? './infra/docker/nginx' : value('tls-dir');
if (!tlsDir || (!local && (!isAbsolute(tlsDir) || !existsSync(tlsDir)))) {
  throw new Error('--tls-dir must identify an existing absolute directory');
}
const output = resolve(value('output') ?? '.env');
const source = value('from');
if (source && !value('output')) throw new Error('--from requires an explicit new --output path');
if (existsSync(output)) throw new Error('The output env file already exists. Choose a new path.');
const hostFile = output + '.nginx.conf';
const composePath = (path) => {
  if (/['"\r\n$]/.test(path)) throw new Error('Unsupported characters in Compose bind path');
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path;
};
const routing = {
  COMPOSE_PATH_SEPARATOR: '|',
  COMPOSE_FILE: 'compose.yaml' + (local ? '|infra/docker/compose.local.yaml' : ''),
  PUBLIC_ORIGIN: origin,
  TLS_CERT_DIR: composePath(tlsDir),
  NGINX_HOSTS_FILE: composePath(hostFile),
};
const passwordKeys = ['ADMIN', 'MIGRATION', 'API', 'LIFECYCLE', 'QUOTA'].map(role => 'DB_PASSWORD_' + role);
let envText;
if (source) {
  envText = readFileSync(resolve(source), 'utf8');
  const original = parseEnv(envText);
  const passwords = passwordKeys.map(key => original[key]);
  if (passwords.some(password => !/^[a-f0-9]{32,128}$/.test(password ?? '')) || new Set(passwords).size !== passwordKeys.length) {
    throw new Error('The source env file must contain all five distinct PostgreSQL credentials');
  }
  for (const [key, value] of Object.entries(routing)) {
    const line = `${key}='${value}'`;
    const pattern = new RegExp(`^${key}=[^\\r\\n]*`, 'gm');
    const matches = [...envText.matchAll(pattern)];
    if (matches.length > 1 || (matches.length === 0 && Object.hasOwn(original, key))) {
      throw new Error(`Use one unindented ${key}= line in the source env file`);
    }
    envText = matches.length ? envText.replace(pattern, () => line) : envText.trimEnd() + '\n' + line + '\n';
  }
  const updated = parseEnv(envText);
  if (passwordKeys.some(key => updated[key] !== original[key]) ||
      Object.entries(routing).some(([key, value]) => updated[key] !== value)) {
    throw new Error('Cannot preserve credentials and update routing in the source env format');
  }
} else {
  envText = [
    '# Generated local secrets. Never commit, print, or upload this file.',
    ...Object.entries(routing).map(([key, value]) => `${key}='${value}'`),
    'GIGA_BIND_IP=127.0.0.1', 'IMAGE_TAG=local', 'CHAT_ENABLED=false',
    ...passwordKeys.map(key => `${key}=${randomBytes(32).toString('hex')}`),
  ].join('\n') + '\n';
}
const hostname = url.hostname.toLowerCase();
if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])$/.test(hostname)) {
  throw new Error('Origin hostname is not valid for the Nginx allowlist');
}
// Publish the public allowlist first, then the env file that refers to it.
const allowlist = `map $host $giga_host_allowed {\n    default 0;\n    "${hostname}" 1;\n}\n`;
try {
  writeFileSync(hostFile, allowlist, { flag: 'wx', mode: 0o644 });
} catch (error) {
  if (error.code !== 'EEXIST' || readFileSync(hostFile, 'utf8') !== allowlist) throw error;
}
writeFileSync(output, envText, { flag: 'wx', mode: 0o600 });
console.log(`Created ${output}. ${local ? 'Loopback HTTP only.' : 'HTTPS selected; provide certificates readable by nginx UID 101.'}`);
console.log('Nginx Host validation matches the configured origin hostname.');
console.log('Run: docker compose up -d --build --wait');

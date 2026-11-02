import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

const args = process.argv.slice(2);
const local = args.includes('--local');
const value = (name) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args.some(arg => arg !== '--local' && !/^--(origin|tls-dir|output)=.+/.test(arg))) {
  throw new Error('Use --local OR --origin=https://host --tls-dir=/absolute/certs; optional --output=PATH');
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
if (/['"\r\n$]/.test(tlsDir)) throw new Error('Unsupported certificate directory characters');
const output = resolve(value('output') ?? '.env');
const lines = [
  '# Generated local secrets. Never commit, print, or upload this file.',
  'COMPOSE_PATH_SEPARATOR=|',
  `COMPOSE_FILE=compose.yaml${local ? '|infra/docker/compose.local.yaml' : ''}`,
  `PUBLIC_ORIGIN=${origin}`, `TLS_CERT_DIR='${tlsDir}'`,
  'GIGA_BIND_IP=127.0.0.1', 'IMAGE_TAG=local', 'CHAT_ENABLED=false',
  ...['ADMIN', 'MIGRATION', 'API', 'LIFECYCLE', 'QUOTA'].map(role => `DB_PASSWORD_${role}=${randomBytes(32).toString('hex')}`),
];
// Exclusive create prevents accidental password changes for an existing volume.
writeFileSync(output, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Created ${output}. ${local ? 'Loopback HTTP only.' : 'HTTPS selected; provide certificates readable by nginx UID 101.'}`);
console.log('Run: docker compose up -d --build --wait');

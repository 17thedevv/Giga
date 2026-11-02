// Failure diagnostics must never print Compose config or inspect environments.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const project = process.env.COMPOSE_PROJECT_NAME ?? '';
if (!/^giga-smoke-[a-z0-9-]+$/.test(project)) throw new Error('Disposable smoke project required');
for (const file of ['.env', '.env.https']) {
  let env;
  try { env = readFileSync(file, 'utf8'); } catch { continue; }
  const secrets = env.split(/\r?\n/).filter(line => /^(DB_PASSWORD_|GEMINI_API_KEY|CREDENTIAL_ENCRYPTION_KEY)/.test(line)).map(line => line.slice(line.indexOf('=') + 1)).filter(Boolean);
  const result = spawnSync('docker', ['compose', '--env-file', file, '-p', project + (file.endsWith('https') ? '-https' : ''), '-f', 'compose.yaml', 'logs', '--no-color', '--tail=60'], { encoding: 'utf8', timeout: 15000 });
  let output = (result.stdout ?? '') + (result.stderr ?? '');
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
  output = output.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]');
  console.log(output);
}

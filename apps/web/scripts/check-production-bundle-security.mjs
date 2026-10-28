import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const forbiddenPatterns = [
  { name: 'mock adapter debug global', pattern: /__mockDataAdapter/ },
  { name: 'Google API key pattern', pattern: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: 'GitHub token pattern', pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
  { name: 'OpenAI key pattern', pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'Bearer credential pattern', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { name: 'database URL credential pattern', pattern: /\b(?:postgres(?:ql)?|mysql):\/\/[^/\s:@]+:[^@\s/]+@/i },
  { name: 'private key marker', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function inspectProductionBundle(distDirectory) {
  const dist = resolve(distDirectory);
  const assets = resolve(dist, 'assets');
  if (!existsSync(dist) || !existsSync(assets)) {
    throw new Error('Required production build artifacts are missing.');
  }

  const distFiles = collectFiles(dist);
  const javascriptFiles = collectFiles(assets).filter(path => path.endsWith('.js'));
  if (javascriptFiles.length === 0) {
    throw new Error('Required production JavaScript assets are missing.');
  }

  const findings = [];
  for (const path of distFiles.filter(file => file.endsWith('.map'))) {
    findings.push({ asset: relative(dist, path), kind: 'unexpected source map' });
  }

  for (const path of javascriptFiles) {
    const source = readFileSync(path, 'utf8');
    const asset = relative(dist, path);
    if (/sourceMappingURL\s*=\s*(?:data:[^\s*]+|[^\s*]+\.map(?:\?[^\s*]*)?)(?:\s|$)/i.test(source)) {
      findings.push({ asset, kind: 'source map reference' });
    }
    for (const forbidden of forbiddenPatterns) {
      if (forbidden.pattern.test(source)) findings.push({ asset, kind: forbidden.name });
    }
  }

  return { javascriptAssetCount: javascriptFiles.length, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = inspectProductionBundle(process.argv[2] ?? resolve(process.cwd(), 'dist'));
    if (result.findings.length > 0) {
      console.error('Production bundle security check failed: forbidden content or source maps were found.');
      for (const finding of result.findings) console.error(`- ${finding.asset}: ${finding.kind}`);
      process.exitCode = 1;
    } else {
      console.log(`Production bundle security check passed (${result.javascriptAssetCount} JavaScript assets).`);
    }
  } catch {
    // Keep failures generic; never print bundle contents or exception payloads.
    console.error('Production bundle security check failed: required build artifacts are missing or invalid.');
    process.exitCode = 1;
  }
}

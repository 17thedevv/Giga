import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const scanner = resolve(process.cwd(), 'scripts', 'check-production-bundle-security.mjs');

function withTempDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'giga-bundle-security-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runScanner(distDirectory: string) {
  return spawnSync(process.execPath, [scanner, distDirectory], { encoding: 'utf8' });
}

describe('production bundle security scanner', () => {
  it('fails closed when the required build output or JavaScript assets are missing', () => {
    withTempDirectory(directory => {
      const missingDist = runScanner(join(directory, 'missing'));
      expect(missingDist.status).toBe(1);
      expect(missingDist.stderr).toContain('required build artifacts are missing');

      mkdirSync(join(directory, 'empty', 'assets'), { recursive: true });
      const noScripts = runScanner(join(directory, 'empty'));
      expect(noScripts.status).toBe(1);
      expect(noScripts.stderr).toContain('required build artifacts are missing');
    });
  });

  it('scans every JavaScript asset without assuming a fixed chunk count', () => {
    withTempDirectory(directory => {
      const assets = join(directory, 'dist', 'assets');
      mkdirSync(join(assets, 'nested'), { recursive: true });
      writeFileSync(join(assets, 'main.js'), 'const app = true;');
      writeFileSync(join(assets, 'nested', 'vendor.js'), 'const vendor = true;');

      const result = runScanner(join(directory, 'dist'));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('2 JavaScript assets');
    });
  });

  it('reports debug globals and secret patterns without printing matching values', () => {
    withTempDirectory(directory => {
      const assets = join(directory, 'dist', 'assets');
      mkdirSync(assets, { recursive: true });
      const sentinel = 'AIzaSyntheticBundleSentinelKey0123456789';
      writeFileSync(join(assets, 'main.js'), `window.__mockDataAdapter = {}; const key = '${sentinel}';`);

      const result = runScanner(join(directory, 'dist'));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('mock adapter debug global');
      expect(result.stderr).toContain('Google API key pattern');
      expect(result.stderr).not.toContain(sentinel);
    });
  });

  it('rejects emitted source maps and sourceMappingURL references', () => {
    withTempDirectory(directory => {
      const dist = join(directory, 'dist');
      const assets = join(dist, 'assets');
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(assets, 'main.js'), 'const app = true;\n//# sourceMappingURL=main.js.map');
      writeFileSync(join(assets, 'inline.js'), '//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==');
      writeFileSync(join(assets, 'main.js.map'), '{"version":3}');

      const result = runScanner(dist);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unexpected source map');
      expect(result.stderr).toContain('source map reference');
      expect(result.stderr).toContain('inline.js');
    });
  });
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const assetsDirectory = resolve(process.cwd(), 'dist', 'assets');
const productionScripts = existsSync(assetsDirectory)
  ? readdirSync(assetsDirectory).filter(file => file.endsWith('.js')).map(file => readFileSync(resolve(assetsDirectory, file), 'utf8'))
  : [];

describe('production bundle security', () => {
  it.skipIf(productionScripts.length === 0)('does not include the mock adapter debug global', () => {
    expect(productionScripts.join('\n')).not.toContain('__mockDataAdapter');
  });
});

#!/usr/bin/env node
// Dependency-free validator for the repository's Agent Skills manifests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillsRoot = path.join(root, '.agents', 'skills');
const errors = [];
const text = (file) => fs.readFileSync(file, 'utf8');
const fail = (message) => errors.push(message);
const expected = new Set([
  'giga-contract-guardian',
  'giga-backend',
  'giga-frontend',
  'giga-agent-runtime',
  'giga-cloud-ops',
  'giga-verification',
  'giga-task-handoff',
]);

if (!fs.existsSync(path.join(root, 'AGENTS.md'))) fail('Missing root AGENTS.md');
if (!fs.existsSync(skillsRoot)) fail('Missing .agents/skills/');
else {
  const dirs = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const name of expected) {
    if (!dirs.includes(name)) fail(`Missing skill directory: ${name}`);
  }
  for (const name of dirs) {
    const file = path.join(skillsRoot, name, 'SKILL.md');
    if (!fs.existsSync(file)) { fail(`${name}: missing SKILL.md`); continue; }
    const body = text(file);
    const yaml = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!yaml) { fail(`${name}: missing YAML frontmatter`); continue; }
    const fields = Object.fromEntries(yaml[1].split(/\r?\n/).filter((s) => s.includes(':'))
      .map((s) => { const i = s.indexOf(':'); return [s.slice(0, i).trim(), s.slice(i + 1).trim().replace(/^['\"]|['\"]$/g, '')]; }));
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) fail(`${name}: invalid directory name`);
    if (fields.name !== name) fail(`${name}: frontmatter name must equal folder`);
    if (!fields.description || fields.description.length > 1024) fail(`${name}: invalid description`);
    if (!body.slice(yaml[0].length).trim()) fail(`${name}: instructions are empty`);
    console.log(`Checked ${name}`);
  }
}

if (errors.length) {
  console.error('\nAgent Skills validation FAILED:\n' + errors.map((x) => '- ' + x).join('\n'));
  process.exitCode = 1;
} else console.log('\nAgent Skills validation PASSED');

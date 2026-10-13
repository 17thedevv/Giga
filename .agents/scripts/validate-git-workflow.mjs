#!/usr/bin/env node
// Validates Git naming conventions for the Giga repository.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const allowedTypes = 'feat|fix|docs|refactor|test|chore|ci|build|perf|revert';
const branchPattern = new RegExp('^(' + allowedTypes + ')/17t-([1-9][0-9]*)-([a-z0-9]+(?:-[a-z0-9]+)*)$');
const headerPattern = new RegExp('^(' + allowedTypes + ')\\(([a-z0-9]+(?:-[a-z0-9]+)*)\\)(!)?: (.+)$');

export function validateBranch(name) {
  const errors = [];
  if (typeof name !== 'string') return { issue: null, errors: ['Branch is not a string'] };
  const match = name.match(branchPattern);
  if (!match) errors.push('Branch must match <type>/17t-<issue-number>-<kebab-slug>');
  if (name.length > 80) errors.push('Branch must be 80 characters or fewer');
  return { issue: match ? `17T-${match[2]}` : null, errors };
}

export function validateHeader(header, where = 'Header') {
  const errors = [];
  if (typeof header !== 'string' || !headerPattern.test(header)) {
    errors.push(`${where}: expected type(scope): imperative summary (optional ! for breaking changes)`);
  } else {
    const summary = header.match(headerPattern)?.[4] ?? '';
    if (header.length > 72) errors.push(`${where}: maximum length is 72 characters`);
    if (summary !== summary.trim()) errors.push(`${where}: summary contains surrounding whitespace`);
    if (summary.endsWith('.')) errors.push(`${where}: no trailing full stop`);
  }
  return errors;
}

export function validatePR({ branch, title, body }) {
  const info = validateBranch(branch);
  const errors = [...info.errors, ...validateHeader(title, 'PR title')];
  if (!info.issue || !new RegExp('\\b' + info.issue + '\\b', 'i').test(body ?? '')) {
    errors.push('PR body must reference its matching Linear issue (' + (info.issue ?? 'unknown') + ')');
  }
  return errors;
}

export function validateCommitSubjects(subjects) {
  if (!Array.isArray(subjects) || subjects.length === 0) return ['No non-merge commits found in PR range'];
  return subjects.flatMap((subject, i) => validateHeader(subject, `Commit ${i + 1}`));
}

function getCommitSubjects(baseSha, headSha) {
  if (![baseSha, headSha].every((s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s))) {
    throw new Error('Commit SHA must be an exact 40-character lowercase hexadecimal value');
  }
  const out = execFileSync('git', ['log', '--no-merges', '--format=%s', `${baseSha}..${headSha}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.trim().split(/\r?\n/).filter(Boolean);
}

function main() {
  const { GIGA_PR_BRANCH: branch, GIGA_PR_TITLE: title, GIGA_PR_BODY: body,
    GIGA_BASE_SHA: baseSha, GIGA_HEAD_SHA: headSha } = process.env;

  if (!branch || !title) throw new Error('Expected GIGA_PR_BRANCH and GIGA_PR_TITLE environment variables');
  const errors = validatePR({ branch, title, body });
  errors.push(...validateCommitSubjects(getCommitSubjects(baseSha, headSha)));
  if (errors.length > 0) {
    console.error('Git workflow validation FAILED:\n' + errors.map((e) => '- ' + e).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Git workflow validation PASSED: ' + branch + ' / ' + title);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL('file://' + process.argv[1]))) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

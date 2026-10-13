import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBranch, validateHeader, validatePR, validateCommitSubjects } from './validate-git-workflow.mjs';

test('accepts standard issue branches for all workstreams', () => {
  for (const branch of ['feat/17t-21-login-api', 'feat/17t-22-chat-screen',
    'docs/17t-18-git-workflow', 'ci/17t-32-cloud-deploy']) {
    assert.deepEqual(validateBranch(branch).errors, []);
  }
});

test('rejects personal, invalid and missing-issue branches', () => {
  for (const branch of ['thu/chat', 'main', 'feature/17t-12-backend',
    'Feat/17T-12-Auth', 'fix/17t-0-issue', 'docs/17t-18_name',
    'feat/17t-2-' + 'x'.repeat(90)]) {
    assert.notEqual(validateBranch(branch).errors.length, 0);
  }
});

test('accepts conventional commit and PR headers', () => {
  for (const title of ['feat(api): add login endpoint', 'fix(web): handle SSE disconnect',
    'docs(workflow): define shared git policy', 'feat(contracts)!: introduce API v2']) {
    assert.deepEqual(validateHeader(title), []);
  }
});

test('rejects poorly formatted commit headers', () => {
  for (const header of ['update', 'fix stuff', 'feat: no scope', 'FIX(api): bad case',
    'docs(api): ' + 'a'.repeat(70), 'feat(api): trailing.']) {
    assert.notEqual(validateHeader(header).length, 0);
  }
});

test('requires branch-matched Linear issue in PR body', () => {
  assert.deepEqual(validatePR({
    branch: 'feat/17t-21-login-api',
    title: 'feat(api): add login endpoint',
    body: 'Linear: 17T-21\n## Summary\nLogin endpoint',
  }), []);
  assert.ok(validatePR({
    branch: 'feat/17t-21-login-api',
    title: 'feat(api): add login endpoint',
    body: 'Linear: 17T-22',
  }).length > 0);
});

test('rejects invalid subjects in commits', () => {
  assert.deepEqual(validateCommitSubjects(['docs(workflow): define policy', 'test(workflow): validate PR metadata']), []);
  assert.ok(validateCommitSubjects(['update']).length > 0);
  assert.ok(validateCommitSubjects([]).length > 0);
});

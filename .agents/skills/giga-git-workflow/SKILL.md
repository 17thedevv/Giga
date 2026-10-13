---
name: giga-git-workflow
description: Enforces Giga Git branch naming, Conventional Commits, PR titles/templates, safe branching and synchronization, review and squash-merge handoff. Use before creating any branch, staging, committing, pushing, opening a PR, resolving conflicts, merging or deleting branches.
---

# Git workflow guardian

**Authoritative document:** `docs/engineering/GIT_WORKFLOW_V0.1.md`. Read it in full before Git writes. Read `AGENTS.md`, task's Linear issue and current Git status. This skill governs **development agents** and not Giga's customer-facing coding-agent runtime.

## Mandatory preflight
1. Confirm repo, remote, base, current branch, clean/dirty state and task issue `17T-N`. Do not invent an issue. Do not operate in the other developer's checkout.
2. Classify Git intent: inspect-only, feature branch creation, commit, push, PR, rebase/conflict, merge or deletion. Seek authorization for operations beyond current user task; branch create/commit/push permitted only within the scope user explicitly delegated.
3. For dirty or ambiguous workspace: report changes and STOP; do not discard, stash, reset, clean, overwrite or stage unrelated work.
4. If task affects API, load `giga-contract-guardian` before any public contract edits.

## Apply strict conventions
- **Branch:** `<type>/17t-<issue-number>-<kebab-slug>`; allowed types: `feat fix docs refactor test chore ci build perf revert`. Example `feat/17t-21-login-api`.
- **Commit:** `type(scope): imperative summary` (≤72 chars). Example `feat(api): add login session endpoint`. No filler/AI signature messages; no auto-added coauthor without evidence.
- **PR title:** same Conventional Commit header as squash commit; PR body **must reference exactly the corresponding 17T issue**, detail summary/tests/risks and request peer review.
- **Integration:** PR to `main`; default **squash merge** only after tests, actual review and authorized merge.
- **No force push, `git reset --hard`, `git clean`, destructive rebase, silent conflict resolution, direct main push or branch deletion** by agent.

## Branch/commit workflow
1. After verifying clean state, `git fetch origin`, update `main` using `git pull --ff-only origin main` if safe; create branch from current `origin/main`.
2. Limit edits to issue scope. Review `git diff --check` and diff content.
3. Stage explicit paths, verify `git diff --cached --stat` and `git diff --cached --check`; do not use `git add .` to grab everything.
4. Run affected tests/validation using `giga-verification`. Document errors and tests not run.
5. Commit by Conventional Commits; push only the feature branch for an authorized task; open PR using the shared template.
6. If behind main, inspect before updating; if conflict or shared branch, STOP and coordinate instead of force-pushing/rebasing another person's work.
7. Before marking PR ready, verify CI, diff, no secrets, Linear links, approval gates and reviewers.
8. **Never merge or mark Linear Done** just because a PR exists. Merge requires explicit authorization; Done requires fully met acceptance criteria.

## Required scenarios for acceptance
- Normal backend/frontend branches are named consistently for distinct Linear tasks.
- User requests `git push origin main`: agent must reject direct main push and offer PR.
- Dirty checkout containing colleague changes: agent must preserve and report, without reset/clean/stash.
- Shared branch behind main with conflict: agent must stop and request coordinated resolution.
- Agent asks to auto-merge after tests but has no explicit authorization/review: must not merge.
- Frontend task proposing a breaking v1 API change: invoke contract guardian and documented transition.

## Handoff
Return Linear issue, branch, commit(s), PR link, exact checks run, impacted files/contracts/cloud, open conflicts and explicit authorization required next. Use `giga-task-handoff` for team context.

**Never claim that GitHub branch protection or CI exists until verified on the actual repository.**

# Giga — GitHub + Linear Collaboration Workflow v0.1

## Canonical location

- **GitHub:** code, architecture, requirements, ADRs, API contracts, deployment guides, reports/evidence. Canonical files belong in `/docs`.
- **Linear:** project roadmap and progress, tasks, dependencies, owners, reviewers, due dates, definition of done and links to code/evidence.
- **Notion:** archival/reference copy only. Do not keep active v0.1 baseline synchronized across three places.

## Working agreement

1. Create or update an issue in the [Giga Linear project](https://linear.app/17thedev/project/giga-cloud-mini-project-0656a578ee3b) before substantial work.
2. Each issue should have *owner*, *reviewer*, *scope*, *acceptance criteria*, *evidence required* and *links*. If the team member is not yet invited to Linear, write the intended owner in the description and leave the assignee unset.
3. Work on a feature or docs branch; include the Linear issue identifier in the PR title/body when known.
4. Request peer review; test; merge to `main` only after approval. Never bypass review for architecture/security/deployment changes.
5. Update issue state and attach canonical GitHub PR or file links after integration.
6. If requirement or architecture changes, update the appropriate Markdown document or ADR through a PR, then link the PR on Linear.

## Weekly reviews

- 15–20 minute joint plan/risks review, plus 45–60 minute cloud cross-training.
- Cloud evidence includes operator, reviewer, date, environment, sanitized logs/screenshots, runbook and pass/fail.
- Track contributions by completed deliverables and actual effort, not by line count or commit count.

## Standard Git workflow (canonical)

Follow [Git Workflow v0.1](engineering/GIT_WORKFLOW_V0.1.md); every development agent must load [giga-git-workflow](../.agents/skills/giga-git-workflow/SKILL.md) before Git writes.

- **Branch:** `<type>/17t-<issue-number>-<short-kebab-slug>` — e.g. `feat/17t-21-login-api` (Trà) or `feat/17t-22-chat-screen` (Thư). No owner/agent names.
- **Commit and PR title:** Conventional Commits `type(scope): imperative summary`, e.g. `feat(web): add chat message list`.
- **PR:** one issue per branch/PR, reference matching `17T-N`, pass CI, request peer review, default squash merge.
- **Safety:** no direct push to `main`, force push, automatic destructive cleanup, silent conflict resolution or unauthorized agent merge.
- **Concurrency:** separate clones/worktrees per developer or coding agent. Coordinate `packages/contracts` and shared architecture changes.

## Do not include

Secret keys, tokens, passwords, raw customer/user data or cloud console screenshots showing credentials. Do not automatically deploy irreversible agent-created changes without the user's approval.

## Issue template (copy to Linear)

- **Context:** Why is the task needed?
- **Deliverables:** Files/services/screens/routes to be produced.
- **Acceptance:** Clear reproducible PASS conditions.
- **Cloud evidence:** Screenshots/logs/URLs and how to verify.
- **Owner / reviewer:** One of Trà or Thư each.
- **Cross-training:** Specific exercise for the other member.
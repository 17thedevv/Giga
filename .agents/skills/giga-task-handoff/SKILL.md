---
name: giga-task-handoff
description: Coordinates Giga development handoffs: Linear issue evidence, GitHub branches/PRs, reviewer scope, ownership, daily milestones and cross-training records. Use when starting, completing, handing off or reviewing tasks between Trà and Thư.
---

# Team coordination and handoff

GitHub is canonical for code/specs/runbooks; Linear tracks assignments and delivery. The team has two independent owners; neither person's agent may claim the other's work is reviewed without evidence.

**All Git operations are governed by `giga-git-workflow` and `docs/engineering/GIT_WORKFLOW_V0.1.md`.** This handoff skill adds evidence; it does not define a competing branch or commit convention.

## Start of task
1. Read `AGENTS.md`, the actual repository and canonical relevant doc. Resolve an issue by ID from Linear **if connector available**; otherwise use the issue details supplied by the user and say status wasn't verified.
2. Identify intended owner, reviewer, due date (internal target, not teacher deadline), precise files/modules, acceptance criteria and cross-training requirement.
3. Load `giga-git-workflow` before branch creation, staging, commits, pushes, PRs or merges. Confirm issue-derived branch and Conventional Commit; preserve unrelated changes and user code. For uncertain workspace state, report it without deleting or resetting.
4. For cross-module work, list interface dependencies and route changes through `giga-contract-guardian` before editing. Do not assign tasks to Thư in Linear if her workspace membership is unavailable.

## During work
- Keep changes scoped; write concise evidence as work is performed rather than retroactively fabricating it.
- When updating plans or architecture, change the canonical `docs/` file via a PR, not duplicate it as an independent Linear document.
- Link relevant issue ID in PR description, note reviewer, change summary, tests, blocked tasks, changed contracts and deployment implications.
- Do not automatically merge a draft PR, alter main, change issue status to Done or publish a user-visible release without appropriate actual verification/authorization.

## End-of-task handoff format

```text
Issue / intended owner / reviewer:
Changed files and purpose:
Contract impact (DRAFT / FROZEN / none):
Validation performed (PASS/FAIL; not-run reason):
Cloud evidence and reproducibility:
Cross-training required/performed (operator + reviewer):
Known blockers and follow-up:
Branch/PR and Linear links:
```

## Acceptance and role-swap
- Both developers review contract changes; routine frontend/backend changes get peer review when required by repository policy.
- Cloud work requires operator and a separate peer who can reproduce deployment/troubleshooting; neither screenshot nor a written checklist alone proves cross-training.
- If the reviewer cannot access the issue/repository, report that fact and leave approval status open.
- Keep actual contribution evidence truthful, avoid grading by commits/lines, and do not attribute agent activity to a human without their review.

**Do not let automatic issue/PR updates overstate completion.**

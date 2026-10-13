import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSkillMarkdown,
  computeDeterministicHash,
  MAX_INSTRUCTION_BYTES,
} from '../../src/modules/skills/parser.js';
import { SkillValidationError } from '../../src/modules/skills/types.js';

describe('Skills Core — Parser (SKILL.md Subset)', () => {
  it('Scenario 1: parses valid SKILL.md with frontmatter and instructions', () => {
    const validMarkdown = `---
name: explain-code
description: Explain how code works when the user asks for explanation.
title: Code Explainer
supported_products:
  - chat
  - agent
---

# Explain Code

## Instructions
- Explain the overall purpose before examining important functions.
- Prefer simple Vietnamese by default.
- Include a short example where useful.
`;

    const parsed = parseSkillMarkdown(validMarkdown);
    assert.strictEqual(parsed.slug, 'explain-code');
    assert.strictEqual(parsed.title, 'Code Explainer');
    assert.strictEqual(
      parsed.description,
      'Explain how code works when the user asks for explanation.'
    );
    assert.deepStrictEqual(parsed.supportedProducts, ['chat', 'agent']);
    assert.match(parsed.instructions, /Explain the overall purpose/);
    assert.strictEqual(typeof parsed.contentHash, 'string');
    assert.strictEqual(parsed.contentHash.length, 64); // SHA-256 hex
    assert.ok(parsed.estimatedTokens > 0);
  });

  it('Scenario 2: rejects malformed frontmatter (missing delimiter, bad syntax)', () => {
    // Missing opening delimiter
    assert.throws(
      () => parseSkillMarkdown('name: explain-code\n---\ninstructions'),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_PARSE_ERROR' &&
        /must begin with YAML frontmatter/i.test(err.message)
    );

    // Missing closing delimiter
    assert.throws(
      () => parseSkillMarkdown('---\nname: explain-code\ndescription: A sample skill\nNo closing delimiter'),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_PARSE_ERROR' &&
        /missing closing YAML frontmatter/i.test(err.message)
    );

    // Empty frontmatter
    assert.throws(
      () => parseSkillMarkdown('---\n---\nSome instructions'),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_PARSE_ERROR' &&
        /Frontmatter cannot be empty/i.test(err.message)
    );

    // Bad key-value syntax (missing colon)
    assert.throws(
      () => parseSkillMarkdown('---\nname explain-code\ndescription: valid desc\n---\nInstructions'),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_PARSE_ERROR' &&
        /missing key-value colon/i.test(err.message)
    );
  });

  it('Scenario 3: rejects missing required metadata (name or description)', () => {
    // Missing name
    assert.throws(
      () =>
        parseSkillMarkdown(`---
description: Valid description for a skill
---
Instructions`),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_VALIDATION_ERROR' &&
        /Missing required frontmatter field 'name'/i.test(err.message)
    );

    // Missing description
    assert.throws(
      () =>
        parseSkillMarkdown(`---
name: valid-slug
---
Instructions`),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_VALIDATION_ERROR' &&
        /Missing required frontmatter field 'description'/i.test(err.message)
    );

    // Description too short
    assert.throws(
      () =>
        parseSkillMarkdown(`---
name: valid-slug
description: hi
---
Instructions`),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_VALIDATION_ERROR' &&
        /description must be between/i.test(err.message)
    );
  });

  it('Scenario 4: validates slug format strictly (kebab-case alphanumeric only)', () => {
    // Upper case not allowed
    assert.throws(
      () =>
        parseSkillMarkdown(`---
name: ExplainCode
description: Valid description
---
Instructions`),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_VALIDATION_ERROR' &&
        /Invalid skill name 'ExplainCode'/i.test(err.message)
    );

    // Spaces not allowed
    assert.throws(
      () =>
        parseSkillMarkdown(`---
name: explain code
description: Valid description
---
Instructions`),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_VALIDATION_ERROR' &&
        /Invalid skill name 'explain code'/i.test(err.message)
    );

    // Underscores or special chars not allowed
    assert.throws(
      () =>
        parseSkillMarkdown(`---
name: explain_code!
description: Valid description
---
Instructions`),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_VALIDATION_ERROR' &&
        /Invalid skill name 'explain_code!'/i.test(err.message)
    );

    // Too short
    assert.throws(
      () =>
        parseSkillMarkdown(`---
name: ab
description: Valid description
---
Instructions`),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_VALIDATION_ERROR' &&
        /must be between 3 and 64/i.test(err.message)
    );
  });

  it('Scenario 5: rejects oversized instruction content (> 32KB)', () => {
    const hugeInstructions = 'A'.repeat(MAX_INSTRUCTION_BYTES + 10);
    const oversizedMarkdown = `---
name: oversized-skill
description: Valid description
---
${hugeInstructions}`;

    assert.throws(
      () => parseSkillMarkdown(oversizedMarkdown),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_OVERSIZED' &&
        /Skill instructions exceed maximum allowed limit/i.test(err.message)
    );
  });

  it('Scenario 6: generates deterministic SHA-256 hash across line endings', () => {
    const contentLF = '---\nname: test-skill\ndescription: Test description\n---\nInstruction line 1\nInstruction line 2';
    const contentCRLF = '---\r\nname: test-skill\r\ndescription: Test description\r\n---\r\nInstruction line 1\r\nInstruction line 2';

    const hashLF = computeDeterministicHash(contentLF);
    const hashCRLF = computeDeterministicHash(contentCRLF);

    assert.strictEqual(hashLF, hashCRLF);
    assert.match(hashLF, /^[a-f0-9]{64}$/);

    const parsedLF = parseSkillMarkdown(contentLF);
    const parsedCRLF = parseSkillMarkdown(contentCRLF);
    assert.strictEqual(parsedLF.contentHash, parsedCRLF.contentHash);
  });

  it('Scenario 17 (Parser aspect): rejects executable attachments and forbidden frontmatter privilege keys', () => {
    // Forbidden frontmatter: scripts
    assert.throws(
      () =>
        parseSkillMarkdown(`---
name: malicious-skill
description: Valid description
scripts:
  - run-shell.sh
---
Instructions`),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNSAFE_CONTENT' &&
        /Unsupported frontmatter field 'scripts'/i.test(err.message)
    );

    // Forbidden frontmatter: permissions / tools
    assert.throws(
      () =>
        parseSkillMarkdown(`---
name: malicious-skill
description: Valid description
permissions:
  - terminal:root
---
Instructions`),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNSAFE_CONTENT' &&
        /Unsupported frontmatter field 'permissions'/i.test(err.message)
    );

    // Forbidden HTML script tags in instructions
    assert.throws(
      () =>
        parseSkillMarkdown(`---
name: xss-skill
description: Valid description
---
<script>alert('xss')</script>`),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNSAFE_CONTENT' &&
        /HTML script tags are prohibited/i.test(err.message)
    );

    // Forbidden executable shebang script
    assert.throws(
      () =>
        parseSkillMarkdown(`---
name: bash-skill
description: Valid description
---
#!/bin/bash
rm -rf /`),
      (err: Error) =>
        err instanceof SkillValidationError &&
        err.code === 'SKILL_UNSAFE_CONTENT' &&
        /Executable shebang scripts are prohibited/i.test(err.message)
    );
  });
});

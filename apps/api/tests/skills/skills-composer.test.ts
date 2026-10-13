import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InstructionComposer } from '../../src/modules/skills/composer.js';
import { SkillConflictError, type ResolvedSkillItem } from '../../src/modules/skills/types.js';

describe('Skills Core — Instruction Composer', () => {
  const composer = new InstructionComposer();

  const skillJson: ResolvedSkillItem = {
    skillId: 's-json',
    slug: 'json-api-expert',
    title: 'JSON API Expert',
    versionId: 'v-json',
    versionNumber: 1,
    contentHash: 'hash-json',
    instructions: 'Format output strictly as valid JSON. Do not include markdown code blocks or prose.',
    source: 'manual',
    supportedProducts: ['chat', 'agent'],
    estimatedTokens: 25,
  };

  const skillNoJson: ResolvedSkillItem = {
    skillId: 's-no-json',
    slug: 'conversational-coach',
    title: 'Conversational Coach',
    versionId: 'v-no-json',
    versionNumber: 1,
    contentHash: 'hash-no-json',
    instructions: 'Always communicate in engaging prose. Do not use JSON or rigid data structures.',
    source: 'manual',
    supportedProducts: ['chat', 'agent'],
    estimatedTokens: 30,
  };

  const skillExplainCode: ResolvedSkillItem = {
    skillId: 's-explain',
    slug: 'explain-code',
    title: 'Explain Code',
    versionId: 'v-explain',
    versionNumber: 1,
    contentHash: 'hash-explain',
    instructions: 'Explain functions step by step with clear explanations.',
    source: 'manual',
    supportedProducts: ['chat', 'agent'],
    estimatedTokens: 20,
  };

  it('Scenario 16: detects known conflicting requirements and returns structured SkillConflictError', () => {
    // Conflicting: strict JSON vs do not use JSON
    assert.throws(
      () => composer.composeInstructions({
        resolvedSkills: [skillJson, skillNoJson],
        product: 'chat',
        userId: 'user-1',
      }),
      (err: Error) => {
        assert.ok(err instanceof SkillConflictError);
        assert.strictEqual(err.code, 'SKILL_CONFLICT');
        assert.deepStrictEqual(err.conflictingSkillSlugs, ['json-api-expert', 'conversational-coach']);
        assert.match(err.message, /Conflict detected between skills/i);
        return true;
      }
    );
  });

  it('Scenario 19: generates correct immutable activation manifest with provenance', () => {
    const result = composer.composeInstructions({
      resolvedSkills: [skillExplainCode],
      product: 'chat',
      userId: 'user-42',
      userPrompt: 'Please review this function',
      userPreferences: {
        preferredLanguage: 'Vietnamese',
        responseLength: 'concise',
        responseStyle: 'technical',
        customInstructions: 'Focus on performance',
        revision: 3,
      },
    });

    const manifest = result.manifest;
    assert.strictEqual(typeof manifest.manifestId, 'string');
    assert.strictEqual(manifest.userId, 'user-42');
    assert.strictEqual(manifest.targetProduct, 'chat');
    assert.strictEqual(manifest.resolverVersion, 'v0.1');
    assert.ok(Date.parse(manifest.activatedAt) > 0);
    assert.strictEqual(manifest.preferencesRevision, 3);
    assert.strictEqual(manifest.totalEstimatedTokens, 20);

    assert.strictEqual(manifest.skills.length, 1);
    assert.strictEqual(manifest.skills[0]?.skillId, 's-explain');
    assert.strictEqual(manifest.skills[0]?.versionId, 'v-explain');
    assert.strictEqual(manifest.skills[0]?.contentHash, 'hash-explain');
    assert.strictEqual(manifest.skills[0]?.source, 'manual');
    assert.strictEqual(manifest.skills[0]?.position, 1);

    // Verify bounded context content
    assert.ok(result.content.includes('<giga_skills_context>'));
    assert.ok(result.content.includes('</giga_skills_context>'));
    assert.ok(result.content.includes('Task Guidance & Behavior Instructions'));
    assert.ok(result.content.includes('#### [Skill: explain-code (v1)]'));
    assert.ok(result.content.includes('- Preferred Language: Vietnamese'));
    assert.ok(result.content.includes('- Response Length: concise'));
    assert.ok(result.content.includes('- Response Style: technical'));
    assert.ok(result.content.includes('- Custom Instructions: Focus on performance'));
  });

  it('Scenario: respects explicit current user prompt over general style preferences', () => {
    // User profile preference is Vietnamese, but user says "Answer in English"
    const result = composer.composeInstructions({
      resolvedSkills: [skillExplainCode],
      product: 'chat',
      userId: 'user-42',
      userPrompt: 'Can you explain this in English please?',
      userPreferences: {
        preferredLanguage: 'Vietnamese',
        responseLength: 'concise',
      },
    });

    assert.ok(result.content.includes('- Preferred Language: English (requested by user in prompt)'));
  });

  it('Scenario: empty skills and empty preferences yields clean empty output', () => {
    const result = composer.composeInstructions({
      resolvedSkills: [],
      product: 'chat',
      userId: 'user-empty',
    });

    assert.strictEqual(result.content, '');
    assert.strictEqual(result.appliedSkillsCount, 0);
    assert.strictEqual(result.totalEstimatedTokens, 0);
    assert.strictEqual(result.manifest.skills.length, 0);
  });
});

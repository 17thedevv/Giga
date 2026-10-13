/**
 * Giga Skills Core v0.1 — Skill Parser
 *
 * Safe, strict parser for the supported text-only subset of SKILL.md.
 * Authoritative docs: docs/architecture/GIGA_SKILLS_ENGINE_V0.1.md
 *
 * Invariant: Never executes Markdown, scripts, or instructions during parsing.
 * Supports zero external dependencies; uses strict internal frontmatter parser.
 */

import { createHash } from 'node:crypto';
import {
  type ParsedSkill,
  type ProductTarget,
  SkillValidationError,
} from './types.js';

export const MAX_RAW_SKILL_BYTES = 64 * 1024; // 64 KB
export const MAX_INSTRUCTION_BYTES = 32 * 1024; // 32 KB
export const MAX_DESCRIPTION_LENGTH = 500;
export const MIN_DESCRIPTION_LENGTH = 5;
export const MAX_SLUG_LENGTH = 64;
export const MIN_SLUG_LENGTH = 3;

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FORBIDDEN_FRONTMATTER_KEYS = new Set([
  'scripts',
  'script',
  'executable',
  'executables',
  'permissions',
  'permission',
  'tools',
  'tool',
  'mcp',
  'sandbox',
  'shell',
  'sudo',
  'commands',
  'runtime',
  'binary',
  'entrypoint',
]);

const FORBIDDEN_CONTENT_PATTERNS = [
  { pattern: /<script\b[^>]*>/i, reason: 'HTML script tags are prohibited in text-only skills' },
  { pattern: /<iframe\b[^>]*>/i, reason: 'HTML iframes are prohibited in text-only skills' },
  { pattern: /<object\b[^>]*>/i, reason: 'HTML object embeds are prohibited in text-only skills' },
  { pattern: /<embed\b[^>]*>/i, reason: 'HTML embeds are prohibited in text-only skills' },
  { pattern: /^#!(?:\/usr)?\/bin\/(?:ba)?sh\b/m, reason: 'Executable shebang scripts are prohibited in text-only skills' },
  { pattern: /\b(?:powershell|cmd)\.exe\b/i, reason: 'Direct shell binary invocations are prohibited in text-only skills' },
];

/**
 * Estimates token count conservatively using character count heuristic (4 chars per token).
 */
export function estimateTokenCount(text: string): number {
  if (!text || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Computes deterministic SHA-256 hash of normalized content (LF line breaks).
 */
export function computeDeterministicHash(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Parses frontmatter YAML subset (key: value pairs, lists, basic strings).
 * Rejects nested objects, complex anchors, or arbitrary code.
 */
function parseFrontmatterSubset(yamlText: string): Record<string, unknown> {
  const lines = yamlText.split(/\r?\n/);
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const trimmed = rawLine.trim();

    // Skip empty lines and comments
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    // List item (e.g. "  - chat")
    if (trimmed.startsWith('- ')) {
      if (!currentKey || !currentList) {
        throw new SkillValidationError(
          'SKILL_PARSE_ERROR',
          `Malformed frontmatter: unexpected list item at line ${i + 1}`
        );
      }
      const itemVal = trimmed.slice(2).trim();
      currentList.push(stripQuotes(itemVal));
      continue;
    }

    // Key-value pair
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      throw new SkillValidationError(
        'SKILL_PARSE_ERROR',
        `Malformed frontmatter: missing key-value colon at line ${i + 1}`
      );
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    if (!key) {
      throw new SkillValidationError(
        'SKILL_PARSE_ERROR',
        `Malformed frontmatter: empty key at line ${i + 1}`
      );
    }

    // Save preceding list if active
    if (currentKey && currentList) {
      result[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    if (value === '') {
      // Might be a multi-line list starting on next line
      currentKey = key;
      currentList = [];
    } else if (value.startsWith('[') && value.endsWith(']')) {
      // Inline list: [chat, agent]
      const items = value
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
      result[key] = items;
    } else {
      result[key] = stripQuotes(value);
    }
  }

  // Flush trailing list
  if (currentKey && currentList) {
    result[currentKey] = currentList;
  }

  return result;
}

function stripQuotes(str: string): string {
  if (
    (str.startsWith('"') && str.endsWith('"')) ||
    (str.startsWith("'") && str.endsWith("'"))
  ) {
    return str.slice(1, -1);
  }
  return str;
}

/**
 * Parses and validates a SKILL.md text document.
 */
export function parseSkillMarkdown(rawContent: string): ParsedSkill {
  if (typeof rawContent !== 'string') {
    throw new SkillValidationError('SKILL_PARSE_ERROR', 'Skill content must be a string');
  }

  const byteLength = Buffer.byteLength(rawContent, 'utf8');
  if (byteLength === 0) {
    throw new SkillValidationError('SKILL_PARSE_ERROR', 'Skill definition cannot be empty');
  }
  if (byteLength > MAX_RAW_SKILL_BYTES) {
    throw new SkillValidationError(
      'SKILL_OVERSIZED',
      `Skill definition exceeds maximum size of ${MAX_RAW_SKILL_BYTES} bytes (actual: ${byteLength} bytes)`
    );
  }

  // Must begin with frontmatter delimiter ---
  const normalized = rawContent.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new SkillValidationError(
      'SKILL_PARSE_ERROR',
      'Skill definition must begin with YAML frontmatter delimiter (---)'
    );
  }

  const closingDelimiterIndex = normalized.indexOf('\n---\n', 3);
  if (closingDelimiterIndex === -1) {
    // Check if ends with \n--- at EOF
    if (normalized.endsWith('\n---')) {
      throw new SkillValidationError(
        'SKILL_PARSE_ERROR',
        'Skill definition missing instruction content after frontmatter'
      );
    }
    throw new SkillValidationError(
      'SKILL_PARSE_ERROR',
      'Skill definition missing closing YAML frontmatter delimiter (---)'
    );
  }

  const frontmatterRaw = normalized.slice(4, closingDelimiterIndex).trim();
  if (frontmatterRaw.length === 0) {
    throw new SkillValidationError(
      'SKILL_PARSE_ERROR',
      'Frontmatter cannot be empty; requires name and description'
    );
  }

  const instructions = normalized.slice(closingDelimiterIndex + 5).trim();
  const instructionBytes = Buffer.byteLength(instructions, 'utf8');

  if (instructionBytes === 0) {
    throw new SkillValidationError(
      'SKILL_VALIDATION_ERROR',
      'Skill instruction content cannot be empty'
    );
  }
  if (instructionBytes > MAX_INSTRUCTION_BYTES) {
    throw new SkillValidationError(
      'SKILL_OVERSIZED',
      `Skill instructions exceed maximum allowed limit of ${MAX_INSTRUCTION_BYTES} bytes (actual: ${instructionBytes} bytes)`
    );
  }

  // Parse frontmatter
  const frontmatter = parseFrontmatterSubset(frontmatterRaw);

  // Validate forbidden keys (privilege escalation prevention)
  for (const key of Object.keys(frontmatter)) {
    if (FORBIDDEN_FRONTMATTER_KEYS.has(key.toLowerCase())) {
      throw new SkillValidationError(
        'SKILL_UNSAFE_CONTENT',
        `Unsupported frontmatter field '${key}': skills in P0 cannot declare scripts, permissions, or tools`
      );
    }
  }

  // Validate name / slug
  const nameVal = frontmatter['name'];
  if (typeof nameVal !== 'string' || nameVal.trim().length === 0) {
    throw new SkillValidationError(
      'SKILL_VALIDATION_ERROR',
      "Missing required frontmatter field 'name'"
    );
  }
  const slug = nameVal.trim();
  if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH) {
    throw new SkillValidationError(
      'SKILL_VALIDATION_ERROR',
      `Skill name slug must be between ${MIN_SLUG_LENGTH} and ${MAX_SLUG_LENGTH} characters`
    );
  }
  if (!SLUG_REGEX.test(slug)) {
    throw new SkillValidationError(
      'SKILL_VALIDATION_ERROR',
      `Invalid skill name '${slug}': must be kebab-case lowercase alphanumeric (e.g. 'explain-code')`
    );
  }

  // Validate description
  const descVal = frontmatter['description'];
  if (typeof descVal !== 'string' || descVal.trim().length === 0) {
    throw new SkillValidationError(
      'SKILL_VALIDATION_ERROR',
      "Missing required frontmatter field 'description'"
    );
  }
  const description = descVal.trim();
  if (description.length < MIN_DESCRIPTION_LENGTH || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new SkillValidationError(
      'SKILL_VALIDATION_ERROR',
      `Skill description must be between ${MIN_DESCRIPTION_LENGTH} and ${MAX_DESCRIPTION_LENGTH} characters`
    );
  }

  // Title (optional, fallback to slug or title field)
  const titleVal = frontmatter['title'];
  const title = typeof titleVal === 'string' && titleVal.trim().length > 0 ? titleVal.trim() : slug;

  // Supported products
  const productsRaw = frontmatter['supported_products'] ?? frontmatter['products'];
  let supportedProducts: ProductTarget[] = ['chat', 'agent'];

  if (productsRaw !== undefined) {
    let rawList: string[] = [];
    if (Array.isArray(productsRaw)) {
      rawList = productsRaw.map(String);
    } else if (typeof productsRaw === 'string') {
      rawList = productsRaw.split(',').map((s) => s.trim());
    } else {
      throw new SkillValidationError(
        'SKILL_VALIDATION_ERROR',
        "Invalid 'supported_products' field: expected list or comma-separated string"
      );
    }

    const validatedProducts: ProductTarget[] = [];
    for (const item of rawList) {
      const normalizedItem = item.toLowerCase();
      if (normalizedItem === 'chat' || normalizedItem === 'agent') {
        if (!validatedProducts.includes(normalizedItem)) {
          validatedProducts.push(normalizedItem);
        }
      } else {
        throw new SkillValidationError(
          'SKILL_VALIDATION_ERROR',
          `Unknown product target '${item}' in supported_products: only 'chat' and 'agent' are allowed`
        );
      }
    }

    if (validatedProducts.length === 0) {
      throw new SkillValidationError(
        'SKILL_VALIDATION_ERROR',
        "At least one valid product ('chat' or 'agent') must be specified in supported_products"
      );
    }
    supportedProducts = validatedProducts;
  }

  // Validate instructions content against forbidden patterns
  for (const { pattern, reason } of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.test(instructions)) {
      throw new SkillValidationError('SKILL_UNSAFE_CONTENT', reason);
    }
  }

  const contentHash = computeDeterministicHash(rawContent);
  const estimatedTokens = estimateTokenCount(instructions);

  return {
    slug,
    title,
    description,
    supportedProducts,
    instructions,
    contentHash,
    rawContent,
    estimatedTokens,
  };
}

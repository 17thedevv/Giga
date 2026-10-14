/**
 * Giga Skills REST Endpoints v0.1
 *
 * Implements authenticated REST endpoints for Skills:
 * - GET /api/v1/skills (list visible/installed skills)
 * - POST /api/v1/skills (create private custom skill)
 * - GET /api/v1/skills/:id (authorized metadata + latest/selected version)
 * - PATCH /api/v1/skills/:id (update private skill metadata)
 * - DELETE /api/v1/skills/:id (delete private skill)
 * - POST /api/v1/skills/:id/versions (publish immutable version)
 * - POST /api/v1/skills/:id/install (install skill)
 * - PATCH /api/v1/skills/:id/installation (toggle enablement or pinned version)
 *
 * Authoritative docs: docs/contracts/GIGA_SKILLS_PROFILES_PLUGINS_API_V0.1.md
 */

import { Hono } from 'hono';
import type { AuthService } from '../auth/auth-service.js';
import { createAuthMiddleware } from '../auth/auth-middleware.js';
import { ValidationError } from '../auth/auth-validation.js';
import { isValidUuid } from './parser.js';
import type {
  SkillsService,
  CreateSkillDto,
  UpdateSkillDto,
  CreateVersionDto,
  InstallSkillDto,
  UpdateInstallationDto,
} from './skills-service.js';
import type { ProductTarget } from './types.js';

export interface SkillsRouteOptions {
  readonly skillsService: SkillsService;
  readonly authService: AuthService;
}

export function createSkillsRoutes(options: SkillsRouteOptions): Hono {
  const router = new Hono();
  const { skillsService, authService } = options;

  // Protect all skills routes with session authentication
  router.use('*', createAuthMiddleware(authService));

  // GET /api/v1/skills?scope=installed|builtIn&limit=20&cursor=...
  router.get('/', async (c) => {
    const user = c.get('user');
    const scopeParam = c.req.query('scope');
    let scope: 'installed' | 'builtIn' | undefined;
    if (scopeParam !== undefined) {
      if (scopeParam !== 'installed' && scopeParam !== 'builtIn') {
        throw new ValidationError(
          `Invalid scope '${scopeParam}': expected 'installed' or 'builtIn'`
        );
      }
      scope = scopeParam;
    }

    const limitParam = c.req.query('limit');
    let limit: number | undefined;
    if (limitParam !== undefined) {
      const parsedLimit = Number(limitParam);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        throw new ValidationError('limit must be an integer between 1 and 100');
      }
      limit = parsedLimit;
    }

    const cursorParam = c.req.query('cursor');
    let cursor: string | undefined;
    if (cursorParam !== undefined) {
      if (cursorParam.trim() === '') {
        throw new ValidationError('cursor must not be empty if provided');
      }
      cursor = cursorParam;
    }

    const result = await skillsService.listSkills(user.id, {
      scope,
      limit,
      cursor,
    });
    return c.json(result, 200);
  });

  // POST /api/v1/skills
  router.post('/', async (c) => {
    const user = c.get('user');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError('Malformed JSON payload');
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    const raw = body as Record<string, unknown>;

    // Reject unknown or forbidden fields
    const allowedKeys = new Set([
      'slug',
      'title',
      'description',
      'supportedProducts',
      'instructions',
    ]);
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) {
        throw new ValidationError(`Unknown or forbidden field '${key}' in request body`);
      }
    }

    if (typeof raw.slug !== 'string') {
      throw new ValidationError('Skill slug is required and must be a string');
    }
    if (typeof raw.title !== 'string') {
      throw new ValidationError('Skill title is required and must be a string');
    }
    if (typeof raw.description !== 'string') {
      throw new ValidationError('Skill description is required and must be a string');
    }
    if (raw.supportedProducts !== undefined && !Array.isArray(raw.supportedProducts)) {
      throw new ValidationError('supportedProducts must be an array of strings');
    }
    if (raw.instructions !== undefined && typeof raw.instructions !== 'string') {
      throw new ValidationError('instructions must be a string');
    }

    const dto: CreateSkillDto = {
      slug: raw.slug,
      title: raw.title,
      description: raw.description,
      supportedProducts: raw.supportedProducts as ProductTarget[] | undefined,
      instructions: raw.instructions as string | undefined,
    };

    const skill = await skillsService.createSkill(user.id, dto);
    return c.json({ skill }, 201);
  });

  // GET /api/v1/skills/:id
  router.get('/:id', async (c) => {
    const user = c.get('user');
    const skillId = c.req.param('id');
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }

    const skill = await skillsService.getSkill(user.id, skillId);
    return c.json({ skill }, 200);
  });

  // PATCH /api/v1/skills/:id
  router.patch('/:id', async (c) => {
    const user = c.get('user');
    const skillId = c.req.param('id');
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError('Malformed JSON payload');
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    const raw = body as Record<string, unknown>;

    // Reject unknown or forbidden fields
    const allowedKeys = new Set([
      'title',
      'description',
      'supportedProducts',
      'expectedRevision',
    ]);
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) {
        throw new ValidationError(`Unknown or forbidden field '${key}' in request body`);
      }
    }

    if (raw.title !== undefined && typeof raw.title !== 'string') {
      throw new ValidationError('title must be a string');
    }
    if (raw.description !== undefined && typeof raw.description !== 'string') {
      throw new ValidationError('description must be a string');
    }
    if (raw.supportedProducts !== undefined && !Array.isArray(raw.supportedProducts)) {
      throw new ValidationError('supportedProducts must be an array of strings');
    }
    if (raw.expectedRevision === undefined || raw.expectedRevision === null) {
      throw new ValidationError('expectedRevision is required for optimistic concurrency control');
    }
    if (
      typeof raw.expectedRevision !== 'number' ||
      !Number.isInteger(raw.expectedRevision) ||
      raw.expectedRevision < 1
    ) {
      throw new ValidationError('expectedRevision must be a positive integer (>= 1)');
    }

    const dto: UpdateSkillDto = {
      title: raw.title as string | undefined,
      description: raw.description as string | undefined,
      supportedProducts: raw.supportedProducts as ProductTarget[] | undefined,
      expectedRevision: raw.expectedRevision as number,
    };

    const skill = await skillsService.updateSkill(user.id, skillId, dto);
    return c.json({ skill }, 200);
  });

  // DELETE /api/v1/skills/:id
  router.delete('/:id', async (c) => {
    const user = c.get('user');
    const skillId = c.req.param('id');
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }

    await skillsService.deleteSkill(user.id, skillId);
    return c.body(null, 204);
  });

  // POST /api/v1/skills/:id/versions
  router.post('/:id/versions', async (c) => {
    const user = c.get('user');
    const skillId = c.req.param('id');
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError('Malformed JSON payload');
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    const raw = body as Record<string, unknown>;

    // Reject unknown or forbidden fields
    const allowedKeys = new Set(['instructions']);
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) {
        throw new ValidationError(`Unknown or forbidden field '${key}' in request body`);
      }
    }

    if (typeof raw.instructions !== 'string') {
      throw new ValidationError('instructions are required and must be a string');
    }

    const dto: CreateVersionDto = {
      instructions: raw.instructions,
    };

    const version = await skillsService.publishVersion(user.id, skillId, dto);
    return c.json({ version }, 201);
  });

  // POST /api/v1/skills/:id/install
  router.post('/:id/install', async (c) => {
    const user = c.get('user');
    const skillId = c.req.param('id');
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }

    let raw: Record<string, unknown> = {};
    try {
      const text = await c.req.text();
      if (text.trim().length > 0) {
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new ValidationError('Request body must be a valid JSON object');
        }
        raw = parsed as Record<string, unknown>;
      }
    } catch (err: unknown) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError('Malformed JSON payload');
    }

    // Reject unknown or forbidden fields
    const allowedKeys = new Set(['versionId', 'enabled']);
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) {
        throw new ValidationError(`Unknown or forbidden field '${key}' in request body`);
      }
    }

    if (raw.versionId !== undefined) {
      if (typeof raw.versionId !== 'string' || !isValidUuid(raw.versionId)) {
        throw new ValidationError('versionId must be a valid UUID');
      }
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      throw new ValidationError('enabled must be a boolean');
    }

    const dto: InstallSkillDto = {
      versionId: raw.versionId as string | undefined,
      enabled: raw.enabled as boolean | undefined,
    };

    const installation = await skillsService.installSkill(user.id, skillId, dto);
    return c.json({ installation }, 201);
  });

  // PATCH /api/v1/skills/:id/installation
  router.patch('/:id/installation', async (c) => {
    const user = c.get('user');
    const skillId = c.req.param('id');
    if (!isValidUuid(skillId)) {
      throw new ValidationError('Invalid skill ID: must be a valid UUID');
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError('Malformed JSON payload');
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ValidationError('Request body must be a valid JSON object');
    }

    const raw = body as Record<string, unknown>;

    // Reject unknown or forbidden fields
    const allowedKeys = new Set(['enabled', 'selectedVersionId']);
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) {
        throw new ValidationError(`Unknown or forbidden field '${key}' in request body`);
      }
    }

    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      throw new ValidationError('enabled must be a boolean');
    }
    if (raw.selectedVersionId !== undefined) {
      if (typeof raw.selectedVersionId !== 'string' || !isValidUuid(raw.selectedVersionId)) {
        throw new ValidationError('selectedVersionId must be a valid UUID');
      }
    }

    const dto: UpdateInstallationDto = {
      enabled: raw.enabled as boolean | undefined,
      selectedVersionId: raw.selectedVersionId as string | undefined,
    };

    const installation = await skillsService.updateInstallation(user.id, skillId, dto);
    return c.json({ installation }, 200);
  });

  return router;
}

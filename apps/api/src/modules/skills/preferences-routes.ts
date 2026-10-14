/**
 * Giga User Preferences REST Endpoints v0.1
 *
 * Implements GET and PATCH /api/v1/me/preferences.
 * Enforces session authentication, CSRF protection, optimistic concurrency,
 * and safe field preservation.
 *
 * Authoritative docs: docs/contracts/GIGA_SKILLS_PROFILES_PLUGINS_API_V0.1.md
 */

import { Hono } from 'hono';
import type { AuthService } from '../auth/auth-service.js';
import { createAuthMiddleware } from '../auth/auth-middleware.js';
import { ValidationError } from '../auth/auth-validation.js';
import type { SkillsService, UpdatePreferencesDto } from './skills-service.js';

export interface PreferencesRouteOptions {
  readonly skillsService: SkillsService;
  readonly authService: AuthService;
}

export function createPreferencesRoutes(options: PreferencesRouteOptions): Hono {
  const router = new Hono();
  const { skillsService, authService } = options;

  // Require active authenticated session cookie on all preferences endpoints
  router.use('*', createAuthMiddleware(authService));

  // GET /api/v1/me/preferences
  router.get('/', async (c) => {
    const user = c.get('user');
    const preferences = await skillsService.getPreferences(user.id);
    return c.json({ preferences }, 200);
  });

  // PATCH /api/v1/me/preferences
  router.patch('/', async (c) => {
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
      'expectedRevision',
      'preferredLanguage',
      'responseLength',
      'responseStyle',
      'customInstructions',
    ]);
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.has(key)) {
        throw new ValidationError(`Unknown or forbidden field '${key}' in request body`);
      }
    }

    if (raw.expectedRevision === undefined) {
      throw new ValidationError(
        'expectedRevision is required and must be a non-negative integer for optimistic concurrency control'
      );
    }
    if (
      typeof raw.expectedRevision !== 'number' ||
      !Number.isInteger(raw.expectedRevision) ||
      raw.expectedRevision < 0
    ) {
      throw new ValidationError('expectedRevision must be a non-negative integer');
    }

    if (
      raw.preferredLanguage !== undefined &&
      raw.preferredLanguage !== null &&
      typeof raw.preferredLanguage !== 'string'
    ) {
      throw new ValidationError('preferredLanguage must be a string or null');
    }
    if (raw.responseLength !== undefined && typeof raw.responseLength !== 'string') {
      throw new ValidationError('responseLength must be a string');
    }
    if (raw.responseStyle !== undefined && typeof raw.responseStyle !== 'string') {
      throw new ValidationError('responseStyle must be a string');
    }
    if (raw.customInstructions !== undefined && typeof raw.customInstructions !== 'string') {
      throw new ValidationError('customInstructions must be a string');
    }

    const dto: UpdatePreferencesDto = {
      expectedRevision: raw.expectedRevision,
      preferredLanguage:
        raw.preferredLanguage === null
          ? null
          : typeof raw.preferredLanguage === 'string'
          ? raw.preferredLanguage
          : undefined,
      responseLength:
        typeof raw.responseLength === 'string'
          ? (raw.responseLength as 'concise' | 'balanced' | 'detailed')
          : undefined,
      responseStyle:
        typeof raw.responseStyle === 'string'
          ? (raw.responseStyle as 'professional' | 'casual' | 'technical')
          : undefined,
      customInstructions:
        typeof raw.customInstructions === 'string' ? raw.customInstructions : undefined,
    };

    const preferences = await skillsService.updatePreferences(user.id, dto);
    return c.json({ preferences }, 200);
  });

  return router;
}

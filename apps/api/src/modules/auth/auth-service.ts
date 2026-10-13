import type { UserRepository } from '../../db/repositories/user-repository.js';
import type { SessionRepository } from '../../db/repositories/session-repository.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  generateSessionToken,
  hashSessionToken,
  calculateSessionExpiry,
} from './session.js';
import {
  ConflictError,
  UnauthenticatedError,
  type RegisterInput,
  type LoginInput,
} from './auth-validation.js';

export interface UserPublic {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
}

export class AuthService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly sessionRepo: SessionRepository
  ) {}

  /**
   * Registers a new user account.
   * Never leaks or returns password hashes.
   */
  async register(input: RegisterInput): Promise<UserPublic> {
    const normalizedEmail = input.email.trim().toLowerCase();

    // Check for existing account
    const existing = await this.userRepo.findUserByEmail(normalizedEmail);
    if (existing) {
      throw new ConflictError('An account with this email already exists');
    }

    // Hash password with Argon2id
    const passwordHash = await hashPassword(input.password);

    // Persist new user in database
    const user = await this.userRepo.createUser({
      email: normalizedEmail,
      displayName: input.displayName.trim(),
      passwordHash,
    });

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt.toISOString(),
    };
  }

  /**
   * Authenticates user credentials and generates a persistent session.
   * Returns generic error on failure to prevent user enumeration.
   */
  async login(input: LoginInput): Promise<{ user: UserPublic; sessionToken: string }> {
    const normalizedEmail = input.email.trim().toLowerCase();

    const user = await this.userRepo.findUserByEmail(normalizedEmail);
    if (!user) {
      // Intentionally generic error message to prevent account enumeration
      throw new UnauthenticatedError('Invalid email or password');
    }

    const passwordMatches = await verifyPassword(user.passwordHash, input.password);
    if (!passwordMatches) {
      throw new UnauthenticatedError('Invalid email or password');
    }

    // Generate cryptographic token and hash for database storage
    const sessionToken = generateSessionToken();
    const tokenHash = hashSessionToken(sessionToken);
    const expiresAt = calculateSessionExpiry();

    await this.sessionRepo.createSession({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt.toISOString(),
      },
      sessionToken,
    };
  }

  /**
   * Validates a session token and retrieves the associated user.
   */
  async getMe(sessionToken: string): Promise<UserPublic> {
    const tokenHash = hashSessionToken(sessionToken);
    const session = await this.sessionRepo.findActiveSessionByTokenHash(tokenHash);

    if (!session) {
      throw new UnauthenticatedError('Authentication required');
    }

    const user = await this.userRepo.findUserById(session.userId);
    if (!user) {
      throw new UnauthenticatedError('Authentication required');
    }

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt.toISOString(),
    };
  }

  /**
   * Revokes an active session token.
   */
  async logout(sessionToken: string): Promise<void> {
    const tokenHash = hashSessionToken(sessionToken);
    await this.sessionRepo.revokeSessionByTokenHash(tokenHash);
  }
}

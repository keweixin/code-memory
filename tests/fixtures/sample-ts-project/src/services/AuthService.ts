/**
 * AuthService — Handles user authentication flow.
 */

import { findUserByEmail } from '../repositories/user-repository.js';
import { verifyPassword } from '../utils/password-hasher.js';
import { issueTokens, verifyRefreshToken, type TokenPair } from './token-service.js';
import { AppError } from '../errors/AppError.js';

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: { id: string; email: string; name: string };
  tokens: TokenPair;
}

export class AuthService {
  /**
   * Authenticate a user with email and password.
   */
  async login(request: LoginRequest): Promise<LoginResponse> {
    if (!request.email || !request.password) {
      throw new AppError('Email and password are required', 400);
    }

    const user = await findUserByEmail(request.email);
    if (!user) {
      throw new AppError('Invalid credentials', 401);
    }

    const isValid = await verifyPassword(request.password, user.passwordHash);
    if (!isValid) {
      throw new AppError('Invalid credentials', 401);
    }

    const tokens = await issueTokens({ userId: user.id, email: user.email });

    return {
      user: { id: user.id, email: user.email, name: user.name },
      tokens,
    };
  }

  /**
   * Refresh access token using a valid refresh token.
   */
  async refreshToken(refreshToken: string): Promise<TokenPair> {
    const payload = await verifyRefreshToken(refreshToken);
    if (!payload) {
      throw new AppError('Invalid refresh token', 401);
    }
    return issueTokens({ userId: payload.userId, email: payload.email });
  }

  /**
   * Logout — invalidate the user's tokens.
   */
  async logout(userId: string): Promise<void> {
    // Would call token blacklist service
    console.error(`User ${userId} logged out`);
  }
}

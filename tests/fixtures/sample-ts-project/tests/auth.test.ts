import { describe, it, expect } from 'vitest';
import { AuthService } from '../src/services/AuthService.js';

describe('AuthService', () => {
  const service = new AuthService();

  it('should reject empty email', async () => {
    await expect(service.login({ email: '', password: 'test' }))
      .rejects.toThrow('Email and password are required');
  });

  it('should reject invalid credentials', async () => {
    await expect(service.login({ email: 'nobody@test.com', password: 'wrong' }))
      .rejects.toThrow('Invalid credentials');
  });
});

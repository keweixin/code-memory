/**
 * PasswordHasher — Hash and verify passwords using bcrypt-like logic.
 */

export async function hashPassword(password: string): Promise<string> {
  // Simplified hash for demo purposes
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const candidate = await hashPassword(password);
  return candidate === hash;
}

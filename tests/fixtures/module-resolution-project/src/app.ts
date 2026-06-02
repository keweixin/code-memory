import { login } from '@services/auth';
import { normalizeEmail } from '@shared';

export function run(email: string): boolean {
  return login(normalizeEmail(email));
}

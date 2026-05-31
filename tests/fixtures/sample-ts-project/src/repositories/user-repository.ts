/**
 * UserRepository — Database operations for user records.
 */

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  isActive: boolean;
}

const users = new Map<string, UserRecord>();

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  for (const user of users.values()) {
    if (user.email === email) return user;
  }
  return null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  return users.get(id) || null;
}

export async function createUser(data: Omit<UserRecord, 'id'>): Promise<UserRecord> {
  const user: UserRecord = {
    id: `user_${Date.now()}`,
    ...data,
  };
  users.set(user.id, user);
  return user;
}

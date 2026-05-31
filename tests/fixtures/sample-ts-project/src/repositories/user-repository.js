/**
 * UserRepository — Database operations for user records.
 */
const users = new Map();
export async function findUserByEmail(email) {
    for (const user of users.values()) {
        if (user.email === email)
            return user;
    }
    return null;
}
export async function findUserById(id) {
    return users.get(id) || null;
}
export async function createUser(data) {
    const user = {
        id: `user_${Date.now()}`,
        ...data,
    };
    users.set(user.id, user);
    return user;
}

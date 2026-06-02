/**
 * TokenService — Issue and verify JWT tokens.
 */
export async function issueTokens(payload) {
    // Simplified token generation for demo
    const accessToken = `at_${payload.userId}_${Date.now()}`;
    const refreshToken = `rt_${payload.userId}_${Date.now()}`;
    return { accessToken, refreshToken };
}
export async function verifyRefreshToken(token) {
    if (!token.startsWith('rt_'))
        return null;
    const parts = token.split('_');
    return { userId: parts[1], email: 'user@example.com' };
}
export async function verifyAccessToken(token) {
    if (!token.startsWith('at_'))
        return null;
    const parts = token.split('_');
    return { userId: parts[1], email: 'user@example.com' };
}

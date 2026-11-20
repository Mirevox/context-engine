/**
 * Authentication helpers: validates bearer tokens for incoming requests.
 */
export interface Session {
  userId: string;
  expiresAt: number;
}

export function authenticate(token: string): boolean {
  return parseToken(token) !== null;
}

export function parseToken(token: string): Session | null {
  const [userId, exp] = token.split(".");
  if (!userId || !exp) return null;
  return { userId, expiresAt: Number(exp) };
}

import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../database/index.js';
import { users } from '../database/schema/users.js';
import { getAuthenticatedClaims } from '../auth/session-auth.util.js';
import { ApiError } from './api-error.js';

export type RouteAuthMode = 'active_only' | 'allow_restricted' | 'claims_only';

/**
 * Shared route authentication & account status guard.
 * - `claims_only`: verifies HttpOnly JWT cookie and revocation store only (for services with their own repository checks).
 * - `allow_restricted`: verifies account exists and is not DELETED; permits RESTRICTED accounts (appeals, notifications).
 * - `active_only` (default): requires an existing account that is neither RESTRICTED nor DELETED.
 */
export async function authenticateRequest(
  req: FastifyRequest,
  mode: RouteAuthMode = 'active_only'
): Promise<string> {
  let claimsSub: string;
  try {
    const claims = await getAuthenticatedClaims(req);
    claimsSub = claims.sub;
  } catch (err) {
    throw ApiError.unauthorized(err instanceof Error ? err.message : 'Yêu cầu xác thực tài khoản.');
  }

  if (mode === 'claims_only') {
    return claimsSub;
  }

  const [user] = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, claimsSub))
    .limit(1);

  if (!user) {
    throw ApiError.unauthorized('Tài khoản không tồn tại.');
  }

  if (user.status === 'DELETED') {
    throw ApiError.restricted('Tài khoản đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.');
  }

  if (mode === 'active_only' && user.status === 'RESTRICTED') {
    throw ApiError.restricted('Tài khoản đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.');
  }

  return claimsSub;
}

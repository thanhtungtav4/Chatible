import { eq } from 'drizzle-orm';
import { db } from '../database/index.js';
import { users } from '../database/schema/users.js';

/**
 * Single authoritative account status check shared across auth, profile,
 * verification, credential rotation, and stealth vault flows.
 */
export async function assertActiveAccount(userId: string) {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user || user.status === 'RESTRICTED' || user.status === 'DELETED') {
    throw new Error('Tài khoản của bạn đã bị khóa hoặc đình chỉ do vi phạm chính sách cộng đồng.');
  }
  return user;
}

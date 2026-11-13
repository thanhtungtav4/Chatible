import { and, desc, eq, sql } from 'drizzle-orm';
import type { UserNotificationDto } from '@chatible/shared';
import { db } from '../database/index.js';
import { userNotifications } from '../database/schema/reports.js';
import { users } from '../database/schema/users.js';
import { MailService } from '../mail/mail.service.js';

export type SafetyNotificationType =
  | 'REPORT_RESOLVED'
  | 'ACCOUNT_RESTRICTED'
  | 'APPEAL_DECISION'
  | 'SYSTEM';

export class SafetyNotificationService {
  constructor(private readonly mailService: MailService = new MailService()) {}

  async createNotification(
    input: {
      userId: string;
      type: SafetyNotificationType;
      title: string;
      body: string;
      relatedResourceId?: string | null;
    },
    tx?: Parameters<Parameters<typeof db.transaction>[0]>[0]
  ): Promise<void> {
    const runner = tx ?? db;
    await runner.insert(userNotifications).values({
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      relatedResourceId: input.relatedResourceId ?? null,
    });
  }

  async notifyUserByEmail(
    userId: string,
    subject: string,
    heading: string,
    message: string
  ): Promise<void> {
    try {
      const [user] = await db
        .select({ email: users.email, status: users.status })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user || user.status === 'DELETED') return;
      await this.mailService.sendSafetyNotificationEmail(user.email, subject, heading, message);
    } catch (err) {
      console.error('[SafetyNotificationService] Non-fatal email dispatch error:', err);
    }
  }

  async listUserNotifications(
    userId: string,
    limit = 30
  ): Promise<{ notifications: UserNotificationDto[]; unreadCount: number }> {
    const rows = await db
      .select()
      .from(userNotifications)
      .where(eq(userNotifications.userId, userId))
      .orderBy(desc(userNotifications.createdAt))
      .limit(Math.min(100, Math.max(1, limit)));

    const [unreadRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(userNotifications)
      .where(and(eq(userNotifications.userId, userId), eq(userNotifications.isRead, false)));

    return {
      notifications: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        isRead: r.isRead,
        relatedResourceId: r.relatedResourceId,
        createdAt: r.createdAt.toISOString(),
      })),
      unreadCount: Number(unreadRow?.count || 0),
    };
  }

  async markRead(userId: string, notificationId?: string): Promise<{ updated: boolean; unreadCount: number }> {
    if (notificationId) {
      await db
        .update(userNotifications)
        .set({ isRead: true })
        .where(and(eq(userNotifications.id, notificationId), eq(userNotifications.userId, userId)));
    } else {
      await db
        .update(userNotifications)
        .set({ isRead: true })
        .where(and(eq(userNotifications.userId, userId), eq(userNotifications.isRead, false)));
    }

    const [unreadRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(userNotifications)
      .where(and(eq(userNotifications.userId, userId), eq(userNotifications.isRead, false)));

    return { updated: true, unreadCount: Number(unreadRow?.count || 0) };
  }
}

import { and, lt, notInArray } from 'drizzle-orm';
import { db } from '../database/index.js';
import { messages } from '../database/schema/messages.js';
import { chatSessions } from '../database/schema/sessions.js';
import { reports } from '../database/schema/reports.js';
import { passwordResetTokens } from '../database/schema/users.js';
import { communityMessages } from '../database/schema/groups.js';
import { MediaService } from '../media/media.service.js';

export interface PurgeReport {
  purgedRandomSessionsCount: number;
  purgedFriendSessionsCount: number;
  purgedMessagesCount: number;
  purgedReportsCount: number;
  purgedMediaCount: number;
  failedMediaCount: number;
  executedAt: string;
}

export class DataCleanupService {
  constructor(private readonly mediaService: Pick<MediaService, 'cleanupExpiredAssets'> = new MediaService()) {}
  /**
   * T036: Execute scheduled cleanup of expired data according to retention rules
   * - Random chat messages & sessions: 7 days
   * - Friend chat messages & inactive expired friend sessions: 30 days
   * - Report evidence: retained during processing and 90 days after closure
   */
  async executeCleanup(now: Date = new Date()): Promise<PurgeReport> {
    const mediaCleanup = await this.mediaService.cleanupExpiredAssets(now);
    const { deletedMsgs, deletedSessions, deletedReports } = await db.transaction(async (tx) => {
      // 1. Purge expired messages (7 days for random, 30 days for friend)
      const deletedMsgs = await tx
        .delete(messages)
        .where(lt(messages.expiresAt, now))
        .returning({ id: messages.id });

      // 2. Purge ALL expired chat sessions (RANDOM after 7 days AND FRIEND after 30 days of inactivity).
      // Reports survive with a null session ID; skip sessions with pending media storage failures.
      const sessionConditions = [lt(chatSessions.expiresAt, now)];
      if (mediaCleanup.failedSessionIds.length > 0) {
        sessionConditions.push(notInArray(chatSessions.id, mediaCleanup.failedSessionIds));
      }
      const deletedSessions = await tx
        .delete(chatSessions)
        .where(and(...sessionConditions))
        .returning({ id: chatSessions.id, sessionType: chatSessions.sessionType });

      // 3. Purge every expired report after its retention deadline (cascades to report_evidence).
      const deletedReports = await tx
        .delete(reports)
        .where(lt(reports.expiresAt, now))
        .returning({ id: reports.id });

      // 4. Purge expired password reset tokens
      await tx.delete(passwordResetTokens).where(lt(passwordResetTokens.expiresAt, now));

      // 5. Purge expired community group messages
      await tx.delete(communityMessages).where(lt(communityMessages.expiresAt, now));

      return { deletedMsgs, deletedSessions, deletedReports };
    });

    const purgedRandomSessionsCount = deletedSessions.filter((s) => s.sessionType === 'RANDOM').length;
    const purgedFriendSessionsCount = deletedSessions.filter((s) => s.sessionType === 'FRIEND').length;

    console.log(
      `[DataCleanup] Purged ${deletedMsgs.length} messages, ${deletedSessions.length} sessions (${purgedRandomSessionsCount} random, ${purgedFriendSessionsCount} friend), ${deletedReports.length} reports, and ${mediaCleanup.deletedCount} media assets (${mediaCleanup.failedCount} media deletion failures).`
    );

    return {
      purgedRandomSessionsCount,
      purgedFriendSessionsCount,
      purgedMessagesCount: deletedMsgs.length,
      purgedReportsCount: deletedReports.length,
      purgedMediaCount: mediaCleanup.deletedCount,
      failedMediaCount: mediaCleanup.failedCount,
      executedAt: now.toISOString(),
    };
  }
}

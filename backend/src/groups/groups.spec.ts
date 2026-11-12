import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { GroupsService } from './groups.service.js';
import { GroupsController } from './groups.controller.js';
import { SafetyService } from '../safety/safety.service.js';
import { AdminService } from '../admin/admin.service.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { LocalKmsService } from '../kms/local-kms.service.js';
import { JwtUtil } from '../auth/jwt.util.js';
import { config } from '../config/env.js';
import { db } from '../database/index.js';
import { communityMessages, communityRooms } from '../database/schema/groups.js';
import { reports } from '../database/schema/reports.js';
import { blockedUsers } from '../database/schema/friends.js';
import { profiles, users } from '../database/schema/users.js';

describe('Groups & Channels (BROADCAST, PUBLIC, PRIVATE_PASSCODE) + Safety Moderation', () => {
  it('enforces broadcast write restriction, public participation, private passcode unlocking, and group report/block/admin takedown', async () => {
    const kms = new LocalKmsService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    const cryptoService = new EnvelopeCryptoService(kms);
    const groupsService = new GroupsService(cryptoService, config.superAdminId);
    const safetyService = new SafetyService(cryptoService, config.superAdminId);
    const adminService = new AdminService(cryptoService, config.superAdminId);

    const app = fastify({ logger: false });
    new GroupsController(groupsService, safetyService).registerRoutes(app);
    await app.ready();

    const member1Id = randomUUID();
    const member2Id = randomUUID();
    const member3Id = randomUUID();
    const cookieFor = (uid: string) =>
      `chatible_session=${encodeURIComponent(JwtUtil.sign({ sub: uid, email: `grp-${uid}@chatible.test` }, config.jwtSecret))}`;

    const createdRoomIds: string[] = [];
    const createdReportIds: string[] = [];

    try {
      await db.insert(users).values([
        { id: member1Id, email: `grp-${member1Id}@chatible.test` },
        { id: member2Id, email: `grp-${member2Id}@chatible.test` },
        { id: member3Id, email: `grp-${member3Id}@chatible.test` },
      ]);
      await db.insert(profiles).values([
        { userId: member1Id, nickname: 'MemberOne', gender: 'OTHER', birthDate: '1996-03-10', calculatedAge: 30 },
        { userId: member2Id, nickname: 'HarasserTwo', gender: 'MALE', birthDate: '1994-05-10', calculatedAge: 32 },
        { userId: member3Id, nickname: 'MemberThree', gender: 'FEMALE', birthDate: '1995-07-10', calculatedAge: 31 },
      ]);

      const broadcast = await groupsService.createRoom(config.superAdminId, {
        name: `Thông báo Test ${member1Id.slice(0, 5)}`,
        type: 'BROADCAST',
      });
      const publicRoom = await groupsService.createRoom(config.superAdminId, {
        name: `Cộng đồng Test ${member1Id.slice(0, 5)}`,
        type: 'PUBLIC',
      });
      const privateRoom = await groupsService.createRoom(config.superAdminId, {
        name: `Phòng VIP ${member1Id.slice(0, 5)}`,
        type: 'PRIVATE_PASSCODE',
        passcode: 'secret2026',
      });
      createdRoomIds.push(broadcast.id, publicRoom.id, privateRoom.id);

      // 1. Broadcast: member joins and reads, admin can post, member posting is 403
      await groupsService.postMessage(config.superAdminId, broadcast.id, { content: 'Chào mừng thành viên!' });
      const joinBroadcast = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${broadcast.id}/join`,
        headers: { cookie: cookieFor(member1Id) },
      });
      expect(joinBroadcast.statusCode).toBe(200);

      const broadcastMsgs = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${broadcast.id}/messages`,
        headers: { cookie: cookieFor(member1Id) },
      });
      expect(broadcastMsgs.statusCode).toBe(200);
      expect(broadcastMsgs.json().messages[0]).toMatchObject({
        content: 'Chào mừng thành viên!',
        isAdmin: true,
      });

      const forbiddenBroadcastPost = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${broadcast.id}/messages`,
        headers: { cookie: cookieFor(member1Id) },
        payload: { content: 'Spam' },
      });
      expect(forbiddenBroadcastPost.statusCode).toBe(403);

      // 2. Public room: member1 & member2 & member3 join, member2 posts offending content
      for (const uid of [member1Id, member2Id, member3Id]) {
        expect(
          (await app.inject({
            method: 'POST',
            url: `/api/v1/groups/${publicRoom.id}/join`,
            headers: { cookie: cookieFor(uid) },
          })).statusCode
        ).toBe(200);
      }

      const postPublic = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${publicRoom.id}/messages`,
        headers: { cookie: cookieFor(member1Id) },
        payload: { content: 'Xin chào mọi người!' },
      });
      expect(postPublic.statusCode).toBe(201);
      expect(postPublic.json().content).toBe('Xin chào mọi người!');

      const offendingPost = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${publicRoom.id}/messages`,
        headers: { cookie: cookieFor(member2Id) },
        payload: { content: 'Quấy rối trong nhóm công khai' },
      });
      expect(offendingPost.statusCode).toBe(201);
      const offendingMsgId = offendingPost.json().id as string;

      // Member1 reports member2's message -> freezes evidence & blocks member2 for member1
      const rptRes = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${publicRoom.id}/messages/${offendingMsgId}/report`,
        headers: { cookie: cookieFor(member1Id) },
        payload: { reason: 'HARASSMENT', description: 'Quấy rối' },
      });
      expect(rptRes.statusCode).toBe(201);
      expect(rptRes.json()).toMatchObject({ priority: 'HIGH', status: 'OPEN' });
      const groupReportId = rptRes.json().reportId as string;
      createdReportIds.push(groupReportId);

      const m1MsgsAfterReport = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${publicRoom.id}/messages`,
        headers: { cookie: cookieFor(member1Id) },
      });
      expect(m1MsgsAfterReport.json().messages.map((m: { id: string }) => m.id)).not.toContain(offendingMsgId);

      // Member3 still sees offending message until blocking member2 via messageId
      const m3MsgsBeforeBlock = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${publicRoom.id}/messages`,
        headers: { cookie: cookieFor(member3Id) },
      });
      expect(m3MsgsBeforeBlock.json().messages.map((m: { id: string }) => m.id)).toContain(offendingMsgId);

      const blkRes = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${publicRoom.id}/messages/${offendingMsgId}/block`,
        headers: { cookie: cookieFor(member3Id) },
      });
      expect(blkRes.statusCode).toBe(200);
      expect(blkRes.json()).toEqual({ status: 'BLOCKED' });

      const m3MsgsAfterBlock = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${publicRoom.id}/messages`,
        headers: { cookie: cookieFor(member3Id) },
      });
      expect(m3MsgsAfterBlock.json().messages.map((m: { id: string }) => m.id)).not.toContain(offendingMsgId);

      // Admin adjudicates group report & takes down offending message globally
      const adjudicated = await adminService.adjudicateReport(groupReportId, config.superAdminId, '127.0.0.1');
      expect(adjudicated.roomName).toContain('Cộng đồng Test');
      expect(adjudicated.evidence[0]?.groupMessageId).toBe(offendingMsgId);
      expect(adjudicated.evidence[0]?.content).toBe('Quấy rối trong nhóm công khai');

      await adminService.deleteGroupMessage(offendingMsgId, config.superAdminId, '127.0.0.1');
      const [deletedMsgRow] = await db
        .select({ deletedAt: communityMessages.deletedAt })
        .from(communityMessages)
        .where(eq(communityMessages.id, offendingMsgId));
      expect(deletedMsgRow?.deletedAt).toBeTruthy();

      // 3. Private passcode room: requires exact passcode before reading or posting
      const lockedRead = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${privateRoom.id}/messages`,
        headers: { cookie: cookieFor(member1Id) },
      });
      expect(lockedRead.statusCode).toBe(403);

      const badPasscode = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${privateRoom.id}/join`,
        headers: { cookie: cookieFor(member1Id) },
        payload: { passcode: 'wrong' },
      });
      expect(badPasscode.statusCode).toBe(403);

      const okJoinPrivate = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${privateRoom.id}/join`,
        headers: { cookie: cookieFor(member1Id) },
        payload: { passcode: 'secret2026' },
      });
      expect(okJoinPrivate.statusCode).toBe(200);
      expect(okJoinPrivate.json()).toEqual({ joined: true, unlocked: true });

      const postPrivate = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${privateRoom.id}/messages`,
        headers: { cookie: cookieFor(member1Id) },
        payload: { content: 'Tin nhắn mật trong phòng riêng' },
      });
      expect(postPrivate.statusCode).toBe(201);
      expect(postPrivate.json().content).toBe('Tin nhắn mật trong phòng riêng');
    } finally {
      await app.close();
      if (createdReportIds.length > 0) {
        await db.delete(reports).where(inArray(reports.id, createdReportIds));
      }
      if (createdRoomIds.length > 0) {
        await db.delete(communityRooms).where(inArray(communityRooms.id, createdRoomIds));
      }
      await db.delete(blockedUsers).where(inArray(blockedUsers.blockerId, [member1Id, member3Id]));
      await db.delete(users).where(inArray(users.id, [member1Id, member2Id, member3Id]));
    }
  });
});

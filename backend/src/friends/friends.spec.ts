import { describe, expect, it } from 'bun:test';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { eq, or } from 'drizzle-orm';
import sharp from 'sharp';
import { JwtUtil } from '../auth/jwt.util.js';
import { config } from '../config/env.js';
import { FriendsService } from './friends.service.js';
import { FriendsController } from './friends.controller.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { LocalKmsService } from '../kms/local-kms.service.js';
import { MediaService, type MediaObjectStore } from '../media/media.service.js';
import { db } from '../database/index.js';
import { chatSessions } from '../database/schema/sessions.js';
import { messages } from '../database/schema/messages.js';
import { adultConsents, mediaAssets } from '../database/schema/media.js';
import { profiles, users } from '../database/schema/users.js';

const cryptoService = new EnvelopeCryptoService(
  new LocalKmsService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
);

async function seedUsers(ids: string[]) {
  await db.insert(users).values(ids.map((id) => ({ id, email: `friends-${id}@chatible.test` })));
  await db.insert(profiles).values(ids.map((userId, index) => ({
    userId,
    nickname: `Friend ${index + 1}`,
    gender: index === 1 ? 'FEMALE' : 'OTHER',
    birthDate: '1990-01-01',
    calculatedAge: 36,
  })));
}

async function removeFixtures(ids: string[]) {
  await db.delete(chatSessions).where(or(...ids.flatMap((id) => [eq(chatSessions.userAId, id), eq(chatSessions.userBId, id)])));
  await db.delete(users).where(or(...ids.map((id) => eq(users.id, id))));
}

describe('Persistent friendship and offline messaging', () => {
  it('accepts requests only for the intended recipient and stores encrypted friend messages', async () => {
    const [userA, userB, unrelatedUser] = [randomUUID(), randomUUID(), randomUUID()];
    const sessionId = randomUUID();
    const friendSessionId = randomUUID();
    const service = new FriendsService(cryptoService);
    const eligibleUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await seedUsers([userA!, userB!, unrelatedUser!]);
    await db.insert(chatSessions).values({
      id: sessionId,
      userAId: userA!,
      userBId: userB!,
      status: 'ENDED',
      expiresAt: eligibleUntil,
    });

    try {
      await expect(service.sendFriendRequest(userA!, userA!)).rejects.toThrow('Không thể tự kết bạn với chính mình.');
      const { requestId } = await service.sendFriendRequest(userA!, userB!);
      await expect(service.acceptFriendRequest(requestId, unrelatedUser!)).rejects.toThrow('Lời mời không tồn tại');
      await service.acceptFriendRequest(requestId, userB!);
      await db.insert(chatSessions).values({
        id: friendSessionId,
        sessionType: 'FRIEND',
        userAId: userA!,
        userBId: userB!,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 1000),
      });

      expect(await service.isFriend(userA!, userB!)).toBe(true);
      const friends = await service.listFriends(userA!);
      expect(friends).toHaveLength(1);
      expect(friends[0]).toMatchObject({ userId: userB, nickname: 'Friend 2', isOnline: false });

      const plaintext = 'Tin nhắn giữa hai người bạn';
      const sent = await service.sendFriendMessage(userA!, userB!, plaintext);
      expect(sent.content).toBe(plaintext);
      expect(new Date(sent.expiresAt).getTime() - new Date(sent.sentAt).getTime()).toBe(30 * 24 * 60 * 60 * 1000);
      const [refreshedSession] = await db.select().from(chatSessions).where(eq(chatSessions.id, friendSessionId));
      expect(refreshedSession?.expiresAt.getTime()).toBeGreaterThanOrEqual(
        new Date(sent.sentAt).getTime() + 29 * 24 * 60 * 60 * 1000
      );
      const [storedMessage] = await db.select().from(messages).where(eq(messages.id, sent.id));
      expect(storedMessage?.ciphertext).not.toBe(plaintext);
      expect((await service.getConversation(userB!, userA!)).map(({ content }) => content)).toEqual([plaintext]);
      await expect(service.sendFriendMessage(userA!, unrelatedUser!, 'Không được gửi')).rejects.toThrow(
        'Chỉ có bạn bè mới có thể gửi tin nhắn 1-1 trực tiếp.'
      );
    } finally {
      await removeFixtures([userA!, userB!, unrelatedUser!]);
    }
  });
  it('lists incoming friend requests for their recipient and accepts them through the API', async () => {
    const [senderId, recipientId, outsiderId] = [randomUUID(), randomUUID(), randomUUID()];
    const sessionId = randomUUID();
    const service = new FriendsService(cryptoService);
    const app = fastify({ logger: false });
    await seedUsers([senderId!, recipientId!, outsiderId!]);
    await db.insert(chatSessions).values({
      id: sessionId,
      userAId: senderId!,
      userBId: recipientId!,
      status: 'ENDED',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    try {
      const { requestId } = await service.sendFriendRequest(senderId!, recipientId!);
      new FriendsController(service).registerRoutes(app);
      await app.ready();
      const recipientToken = JwtUtil.sign({ sub: recipientId!, email: 'recipient@example.test' }, config.jwtSecret);
      const outsiderToken = JwtUtil.sign({ sub: outsiderId!, email: 'outsider@example.test' }, config.jwtSecret);

      const recipientCookie = `chatible_session=${encodeURIComponent(recipientToken)}`;
      const outsiderCookie = `chatible_session=${encodeURIComponent(outsiderToken)}`;

      expect((await app.inject({ method: 'GET', url: '/api/v1/friends/requests' })).statusCode).toBe(401);
      const recipientResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/friends/requests',
        headers: { cookie: recipientCookie },
      });
      expect(recipientResponse.statusCode).toBe(200);
      expect(recipientResponse.json().requests).toMatchObject([{
        requestId,
        fromUserId: senderId,
        nickname: 'Friend 1',
        gender: 'OTHER',
        age: 36,
        sentAt: expect.any(String),
      }]);

      const outsiderResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/friends/requests',
        headers: { cookie: outsiderCookie },
      });
      expect(outsiderResponse.json()).toEqual({ requests: [] });

      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v1/friends/accept',
        headers: { cookie: recipientCookie },
        payload: { requestId },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ status: 'ACCEPTED' });
      const afterAccept = await app.inject({
        method: 'GET',
        url: '/api/v1/friends/requests',
        headers: { cookie: recipientCookie },
      });
      expect(afterAccept.json()).toEqual({ requests: [] });
      const friendList = await app.inject({
        method: 'GET',
        url: '/api/v1/friends',
        headers: { cookie: recipientCookie },
      });
      expect(friendList.json().friends).toMatchObject([{ userId: senderId, nickname: 'Friend 1' }]);

      // Unfriend
      const unfriendRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/friends/${senderId}`,
        headers: { cookie: recipientCookie },
      });
      expect(unfriendRes.statusCode).toBe(200);
      expect(unfriendRes.json()).toEqual({ status: 'UNFRIENDED' });

      const friendListAfterUnfriend = await app.inject({
        method: 'GET',
        url: '/api/v1/friends',
        headers: { cookie: recipientCookie },
      });
      expect(friendListAfterUnfriend.json().friends).toHaveLength(0);
    } finally {
      await app.close();
      await removeFixtures([senderId!, recipientId!, outsiderId!]);
    }
  });

  it('allows declining and cancelling friend requests with 7-day cooldown', async () => {
    const [senderId, recipientId] = [randomUUID(), randomUUID()];
    const sessionId = randomUUID();
    const service = new FriendsService(cryptoService);
    const eligibleUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await seedUsers([senderId!, recipientId!]);
    await db.insert(chatSessions).values({
      id: sessionId,
      userAId: senderId!,
      userBId: recipientId!,
      status: 'ENDED',
      expiresAt: eligibleUntil,
    });

    try {
      const { requestId } = await service.sendFriendRequest(senderId!, recipientId!);
      // Recipient declines
      const declineRes = await service.declineFriendRequest(requestId, recipientId!);
      expect(declineRes).toEqual({ status: 'DECLINED' });

      // Attempt to send again immediately should trigger 7-day cooldown
      await expect(service.sendFriendRequest(senderId!, recipientId!)).rejects.toThrow(
        'Lời mời đã bị từ chối hoặc thu hồi gần đây'
      );
    } finally {
      await removeFixtures([senderId!, recipientId!]);
    }
  });

  it('allows sender to cancel a pending friend request with 7-day cooldown', async () => {
    const [senderId, recipientId] = [randomUUID(), randomUUID()];
    const sessionId = randomUUID();
    const service = new FriendsService(cryptoService);
    const eligibleUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await seedUsers([senderId!, recipientId!]);
    await db.insert(chatSessions).values({
      id: sessionId,
      userAId: senderId!,
      userBId: recipientId!,
      status: 'ENDED',
      expiresAt: eligibleUntil,
    });

    try {
      const { requestId } = await service.sendFriendRequest(senderId!, recipientId!);
      // Sender cancels
      const cancelRes = await service.cancelFriendRequest(requestId, senderId!);
      expect(cancelRes).toEqual({ status: 'CANCELLED' });

      // Re-send immediately fails with cooldown
      await expect(service.sendFriendRequest(senderId!, recipientId!)).rejects.toThrow(
        'Lời mời đã bị từ chối hoặc thu hồi gần đây'
      );
    } finally {
      await removeFixtures([senderId!, recipientId!]);
    }
  });

  it('supports encrypted IMAGE & adult 18+ media delivery between friends while rejecting unfinalized assets', async () => {
    const [userA, userB] = [randomUUID(), randomUUID()];
    const objects = new Map<string, { body: Buffer; contentType: string }>();
    const storage: MediaObjectStore = {
      async presignPut(input) {
        return `https://storage.test/${input.key}`;
      },
      async exists(key) {
        return objects.has(key);
      },
      async head(key) {
        const obj = objects.get(key);
        return obj ? { exists: true, contentLength: obj.body.length, contentType: obj.contentType } : { exists: false };
      },
      async get(key) {
        const obj = objects.get(key);
        if (!obj) throw new Error('missing');
        return { body: obj.body, contentType: obj.contentType, contentLength: obj.body.length };
      },
      async delete(key) {
        objects.delete(key);
      },
    };
    const kms = new LocalKmsService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    const mediaService = new MediaService({ storage, kms });
    const service = new FriendsService(cryptoService, mediaService);

    const priorSessionId = randomUUID();
    await seedUsers([userA, userB]);
    await db.insert(chatSessions).values({
      id: priorSessionId,
      userAId: userA,
      userBId: userB,
      status: 'ENDED',
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    try {
      const { requestId } = await service.sendFriendRequest(userA, userB);
      await service.acceptFriendRequest(requestId, userB);
      const { sessionId } = await service.getOrCreateFriendSession(userA, userB);
      await mediaService.setConsent(userB, sessionId, true);

      // Sending arbitrary IMAGE without finalized media asset MUST fail
      await expect(
        service.sendFriendMessage(userA, userB, {
          type: 'IMAGE',
          content: JSON.stringify({ mediaId: randomUUID(), contentType: 'image/webp', mediaType: 'IMAGE' }),
        })
      ).rejects.toThrow();

      // Upload real encrypted WebP marked as 18+ requires recipient adult consent
      const rawWebp = await sharp({
        create: { width: 32, height: 32, channels: 4, background: { r: 220, g: 38, b: 38, alpha: 1 } },
      })
        .webp()
        .toBuffer();
      const rawDek = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', rawDek, iv);
      const ciphertext = Buffer.concat([cipher.update(rawWebp), cipher.final()]);
      const authTag = cipher.getAuthTag();

      await mediaService.setAdultConsent(userB, sessionId, true, true);
      const presigned = await mediaService.presignUpload(userA, {
        sessionId,
        recipientId: userB,
        contentType: 'image/webp',
        fileSize: ciphertext.length,
        mediaType: 'IMAGE',
        dek: rawDek.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        isAdult: true,
        senderConfirmed18Plus: true,
        senderConfirmedConsent: true,
      });
      const [assetRow] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, presigned.mediaId));
      objects.set(assetRow!.objectKey, { body: ciphertext, contentType: 'application/octet-stream' });
      await mediaService.completeUpload(userA, presigned.mediaId);

      const sent = await service.sendFriendMessage(userA, userB, {
        type: 'IMAGE',
        content: JSON.stringify({
          mediaId: presigned.mediaId,
          contentType: 'image/webp',
          mediaType: 'IMAGE',
          isAdult: true,
        }),
        mediaId: presigned.mediaId,
        isAdultContent: true,
        clientMessageId: 'friend-media-1',
      });
      expect(sent.messageType).toBe('IMAGE');
      expect(sent.isAdultContent).toBe(true);
    } finally {
      await db.delete(adultConsents).where(eq(adultConsents.recipientId, userB));
      await db.delete(mediaAssets).where(eq(mediaAssets.ownerId, userA));
      await removeFixtures([userA, userB]);
    }
  });
});

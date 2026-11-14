import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import { describe, expect, it } from 'bun:test';
import { eq, inArray, or } from 'drizzle-orm';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server as SocketIOServer } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import Redis from 'ioredis';
import { SocketEvents } from '@chatible/shared';
import { AdminController } from '../admin/admin.controller.js';
import { AdminService } from '../admin/admin.service.js';
import { config } from '../config/env.js';
import { JwtUtil } from '../auth/jwt.util.js';
import { EnvelopeCryptoService } from '../crypto/envelope.service.js';
import { db } from '../database/index.js';
import { chatSessions } from '../database/schema/sessions.js';
import { blockedUsers } from '../database/schema/friends.js';
import { systemSettings } from '../database/schema/settings.js';
import { profiles, users } from '../database/schema/users.js';
import { FriendsService } from '../friends/friends.service.js';
import { LocalKmsService } from '../kms/local-kms.service.js';
import { MatchingEngine } from '../matching/matching.service.js';
import { MediaService } from '../media/media.service.js';
import { RedisSessionCoordinator } from '../matching/session.coordinator.js';
import { SafetyService } from '../safety/safety.service.js';
import { ChatGateway } from './chat.gateway.js';

const retentionMs = 7 * 24 * 60 * 60 * 1000;
const cryptoService = new EnvelopeCryptoService(
  new LocalKmsService('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
);

type MatchEvent = { sessionId: string };
type ChatEndedEvent = { reason: string };
type MatchingErrorEvent = { error: string };

function waitForEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for socket event ${event}`));
    }, 5000);
    const onEvent = (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

async function waitForQueueSize(engine: MatchingEngine, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (engine.getQueueSize() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Matching queue did not reach size ${expected}`);
}

function connectUser(url: string, token: string): Promise<ClientSocket> {
  const socket = io(url, {
    extraHeaders: { cookie: `chatible_session=${encodeURIComponent(token)}` },
    transports: ['websocket'],
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}
async function waitForDisconnectedParticipant(
  coordinator: RedisSessionCoordinator,
  userId: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const session = await coordinator.getSessionByUser(userId);
    if (session?.reconnectingUsers?.[userId]) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Redis session coordinator did not mark ${userId} disconnected.`);
}

describe('Chat gateway session lifecycle', () => {
  it('prevents re-matching during chat, retains ended sessions, and revokes restricted sockets', async () => {
    const userIds = [randomUUID(), randomUUID(), randomUUID()];
    const userBId = userIds[1]!;
    const emails = userIds.map((id) => `gateway-${id}@chatible.test`);
    const httpServer = createServer();
    const socketServer = new SocketIOServer(httpServer, { transports: ['websocket'] });
    const adminApp = fastify({ logger: false });
    const clients: ClientSocket[] = [];
    let gatewayForClose: ChatGateway | undefined;

    const redisNamespace = `chatible:test:gateway:${randomUUID()}`;
    const matchingEngine = new MatchingEngine(config.redisUrl, redisNamespace);
    const sessionCoordinator = new RedisSessionCoordinator(config.redisUrl, redisNamespace, matchingEngine.instanceId);
    try {
      const existingAdmin = await db.query.users.findFirst({ where: eq(users.id, config.superAdminId) });
      if (!existingAdmin) {
        await db.insert(users).values({
          id: config.superAdminId,
          email: `gateway-admin-${randomUUID()}@chatible.test`,
        });
      }
      await db.insert(users).values(userIds.map((id, index) => ({ id, email: emails[index]! })));
      await db.insert(profiles).values(userIds.map((userId, index) => ({
        userId,
        nickname: `Gateway ${index}`,
        gender: index === 1 ? 'FEMALE' : 'MALE',
        birthDate: '1990-01-01',
        calculatedAge: 30,
      })));

      await Promise.all([matchingEngine.connect(), sessionCoordinator.connect()]);
      const safetyService = new SafetyService(cryptoService, config.superAdminId);
      matchingEngine.setBlockChecker((userA, userB) => safetyService.isBlocked(userA, userB));
      const gateway = new ChatGateway(
        socketServer,
        matchingEngine,
        sessionCoordinator,
        cryptoService,
        new FriendsService(cryptoService),
        safetyService,
        new MediaService()
      );
      gatewayForClose = gateway;
      await gateway.registerHandlers();

      const adminController = new AdminController(new AdminService(cryptoService, config.superAdminId));
      adminController.setUserRevoker((userId) => gateway.revokeUser(userId));
      adminController.registerRoutes(adminApp);
      await adminApp.ready();

      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('Socket server did not bind a TCP port.');
      const url = `http://127.0.0.1:${address.port}`;
      const sockets = await Promise.all(userIds.map((userId, index) =>
        connectUser(url, JwtUtil.sign({ sub: userId, email: emails[index]! }, config.jwtSecret))
      ));
      clients.push(...sockets);
      let socketA = sockets[0]!;
      let socketB = sockets[1]!;
      const socketC = sockets[2]!;
      const join = { targetGender: 'ALL' as const, ageMin: 18, ageMax: 80 };

      const matchedA = waitForEvent<MatchEvent>(socketA, SocketEvents.MATCHING_FOUND);
      const matchedB = waitForEvent<MatchEvent>(socketB, SocketEvents.MATCHING_FOUND);
      socketA.emit(SocketEvents.MATCHING_JOIN, join);
      socketB.emit(SocketEvents.MATCHING_JOIN, join);
      const [matchA, matchB] = await Promise.all([matchedA, matchedB]);
      expect(matchA.sessionId).toBe(matchB.sessionId);
      const partnerLost = waitForEvent<{ timeoutSec: number }>(socketB, SocketEvents.CONNECTION_LOST);
      socketA.io.engine.close();
      expect(await partnerLost).toBeDefined();
      const rejectedPartnerResume = new Promise<{ success: boolean }>((resolve) => {
        socketB.emit(SocketEvents.SESSION_RESUME, { sessionId: matchA.sessionId }, resolve);
      });
      expect(await rejectedPartnerResume).toMatchObject({ success: false });
      const disconnectedB = waitForEvent<void>(socketB, 'disconnect');
      socketB.io.engine.close();
      await disconnectedB;
      await waitForDisconnectedParticipant(sessionCoordinator, userIds[1]!);
      socketA = await connectUser(url, JwtUtil.sign({ sub: userIds[0]!, email: emails[0]! }, config.jwtSecret));
      clients.push(socketA);
      const restoredA = waitForEvent<void>(socketA, SocketEvents.CONNECTION_RESTORED);
      const resumeAckA = new Promise<{ success: boolean; state?: string }>((resolve) => {
        socketA.emit(SocketEvents.SESSION_RESUME, { sessionId: matchA.sessionId }, resolve);
      });
      expect(await resumeAckA).toMatchObject({ success: true, state: 'RECONNECTING' });

      socketB = await connectUser(url, JwtUtil.sign({ sub: userIds[1]!, email: emails[1]! }, config.jwtSecret));
      clients.push(socketB);
      const resumeAckB = new Promise<{ success: boolean; state?: string }>((resolve) => {
        socketB.emit(SocketEvents.SESSION_RESUME, { sessionId: matchA.sessionId }, resolve);
      });
      expect(await resumeAckB).toMatchObject({ success: true, state: 'CHATTING' });
      await restoredA;

      const invalidResumeAck = new Promise<{ success: boolean }>((resolve) => {
        socketA.emit(SocketEvents.SESSION_RESUME, { sessionId: randomUUID() }, resolve);
      });
      expect(await invalidResumeAck).toMatchObject({ success: false });

      const reentryError = waitForEvent<MatchingErrorEvent>(socketA, SocketEvents.MATCHING_ERROR);
      socketA.emit(SocketEvents.MATCHING_JOIN, join);
      expect((await reentryError).error).toContain('Kết thúc phiên chat hiện tại');
      expect(matchingEngine.getQueueSize()).toBe(0);

      const endedA = waitForEvent<ChatEndedEvent>(socketA, SocketEvents.CHAT_ENDED);
      const endedB = waitForEvent<ChatEndedEvent>(socketB, SocketEvents.CHAT_ENDED);
      const endAck = new Promise<{ success: boolean }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Chat end acknowledgement timed out')), 5000);
        socketA.emit(SocketEvents.CHAT_END, {}, (response: { success: boolean }) => {
          clearTimeout(timeout);
          resolve(response);
        });
      });
      expect(await endAck).toEqual({ success: true });
      await Promise.all([endedA, endedB]);

      const firstSession = await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, matchA.sessionId) });
      expect(firstSession?.status).toBe('ENDED');
      expect(firstSession?.endReason).toBe('USER_LEFT');
      if (!firstSession?.endedAt) throw new Error('Ended session timestamp was not persisted.');
      expect(firstSession.expiresAt.getTime()).toBe(firstSession.endedAt.getTime() + retentionMs);

      socketC.emit(SocketEvents.MATCHING_JOIN, join);
      await waitForQueueSize(matchingEngine, 1);
      const matchedB2 = waitForEvent<MatchEvent>(socketB, SocketEvents.MATCHING_FOUND);
      const matchedC = waitForEvent<MatchEvent>(socketC, SocketEvents.MATCHING_FOUND);
      socketB.emit(SocketEvents.MATCHING_JOIN, join);
      const [matchB2, matchC] = await Promise.all([matchedB2, matchedC]);
      expect(matchB2.sessionId).toBe(matchC.sessionId);

      const restrictedPartnerEnded = waitForEvent<ChatEndedEvent>(socketC, SocketEvents.CHAT_ENDED);
      const restrictedSocketClosed = waitForEvent<string>(socketB, 'disconnect');
      const adminToken = JwtUtil.sign(
        { sub: config.superAdminId, email: 'admin@chatible.local', role: 'admin' },
        config.adminJwtSecret
      );
      const response = await adminApp.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${userBId}/restrict`,
        headers: { cookie: `chatible_admin_session=${encodeURIComponent(adminToken)}` },
        payload: { reason: 'integration-test' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'RESTRICTED', userId: userBId });
      expect((await restrictedPartnerEnded).reason).toBe('USER_RESTRICTED');
      await restrictedSocketClosed;

      const restrictedUser = await db.query.users.findFirst({ where: eq(users.id, userBId) });
      const restrictedSession = await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, matchB2.sessionId) });
      expect(restrictedUser?.status).toBe('RESTRICTED');
      expect(restrictedSession?.status).toBe('ENDED');
      expect(restrictedSession?.endReason).toBe('USER_RESTRICTED');
      if (!restrictedSession?.endedAt) throw new Error('Restricted session timestamp was not persisted.');
      expect(restrictedSession.expiresAt.getTime()).toBe(restrictedSession.endedAt.getTime() + retentionMs);

      const deniedSocket = io(url, {
        extraHeaders: {
          cookie: `chatible_session=${encodeURIComponent(JwtUtil.sign({ sub: userBId, email: emails[1]! }, config.jwtSecret))}`,
        },
        transports: ['websocket'],
        reconnection: false,
      });
      const denied = new Promise<Error>((resolve, reject) => {
        deniedSocket.once('connect_error', resolve);
        deniedSocket.once('connect', () => reject(new Error('Restricted account connected successfully.')));
      });
      expect((await denied).message).toContain('Tài khoản không hợp lệ hoặc đã bị khóa/đình chỉ');
      deniedSocket.close();

      // Strict cookie-only Socket.IO handshake: passing only auth.token without HttpOnly cookie must be rejected
      const bearerOnlySocket = io(url, {
        auth: { token: JwtUtil.sign({ sub: userIds[2]!, email: emails[2]! }, config.jwtSecret) },
        transports: ['websocket'],
        reconnection: false,
      });
      const bearerDenied = new Promise<Error>((resolve, reject) => {
        bearerOnlySocket.once('connect_error', resolve);
        bearerOnlySocket.once('connect', () => reject(new Error('Socket connected via auth.token without HttpOnly cookie.')));
      });
      await bearerDenied;
      bearerOnlySocket.close();
    } finally {
      clients.forEach((socket) => socket.disconnect());
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      await gatewayForClose?.close();
      await adminApp.close();
      await matchingEngine.close();
      await sessionCoordinator.close();
      const cleanupRedis = new Redis(config.redisUrl);
      const testKeys = await cleanupRedis.keys(`${redisNamespace}:*`);
      if (testKeys.length > 0) await cleanupRedis.del(...testKeys);
      await cleanupRedis.quit();
      await db.delete(chatSessions).where(or(
        ...userIds.flatMap((id) => [eq(chatSessions.userAId, id), eq(chatSessions.userBId, id)])
      ));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });
  it('matches users across gateway instances and routes chat events through Redis', async () => {
    const userIds = [randomUUID(), randomUUID()];
    const emails = userIds.map((id) => `multi-node-${id}@chatible.test`);
    const redisNamespace = `chatible:test:gateway:${randomUUID()}`;
    const httpServers = [createServer(), createServer()];
    const socketServers = httpServers.map((server) => new SocketIOServer(server, { transports: ['websocket'] }));
    const matchingEngines = httpServers.map(() => new MatchingEngine(config.redisUrl, redisNamespace));
    const coordinators = matchingEngines.map((engine) =>
      new RedisSessionCoordinator(config.redisUrl, redisNamespace, engine.instanceId)
    );
    const adapterClients = Array.from({ length: 4 }, () =>
      new Redis(config.redisUrl, { lazyConnect: true, retryStrategy: () => null })
    );
    const clients: ClientSocket[] = [];
    let gateways: ChatGateway[] = [];

    try {
      await db.insert(users).values(userIds.map((id, index) => ({ id, email: emails[index]! })));
      await db.insert(profiles).values(userIds.map((userId, index) => ({
        userId,
        nickname: `Multi node ${index}`,
        gender: index === 0 ? 'MALE' : 'FEMALE',
        birthDate: '1990-01-01',
        calculatedAge: 30,
      })));

      await Promise.all([
        ...matchingEngines.map((engine) => engine.connect()),
        ...coordinators.map((coordinator) => coordinator.connect()),
        ...adapterClients.map((client) => client.connect()),
      ]);
      socketServers.forEach((server, index) => {
        server.adapter(createAdapter(adapterClients[index * 2]!, adapterClients[index * 2 + 1]!));
      });

      const safetyService = new SafetyService(cryptoService, config.superAdminId);
      gateways = socketServers.map((server, index) => {
        matchingEngines[index]!.setBlockChecker((userA, userB) => safetyService.isBlocked(userA, userB));
        return new ChatGateway(
          server,
          matchingEngines[index]!,
          coordinators[index]!,
          cryptoService,
          new FriendsService(cryptoService),
          safetyService,
          new MediaService()
        );
      });
      await Promise.all(gateways.map((gateway) => gateway.registerHandlers()));
      await Promise.all(httpServers.map((server) =>
        new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      ));

      const urls = httpServers.map((server) => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Socket server did not bind a TCP port.');
        return `http://127.0.0.1:${address.port}`;
      });
      const [socketA, socketB] = await Promise.all(userIds.map((userId, index) =>
        connectUser(urls[index]!, JwtUtil.sign({ sub: userId, email: emails[index]! }, config.jwtSecret))
      ));
      clients.push(socketA!, socketB!);

      const matchedA = waitForEvent<MatchEvent>(socketA!, SocketEvents.MATCHING_FOUND);
      const matchedB = waitForEvent<MatchEvent>(socketB!, SocketEvents.MATCHING_FOUND);
      const join = { targetGender: 'ALL' as const, ageMin: 18, ageMax: 80 };
      socketA!.emit(SocketEvents.MATCHING_JOIN, join);
      await waitForQueueSize(matchingEngines[0]!, 1);
      socketB!.emit(SocketEvents.MATCHING_JOIN, join);
      const [matchA, matchB] = await Promise.all([matchedA, matchedB]);
      expect(matchA.sessionId).toBe(matchB.sessionId);

      const reentryError = waitForEvent<MatchingErrorEvent>(socketA!, SocketEvents.MATCHING_ERROR);
      socketA!.emit(SocketEvents.MATCHING_JOIN, join);
      expect((await reentryError).error).toContain('Kết thúc phiên chat hiện tại');

      const delivered = waitForEvent<{
        senderId: string;
        content: string;
        type: string;
        metadata?: Record<string, unknown>;
      }>(socketB!, SocketEvents.MESSAGE_RECEIVE);
      const sendAck = new Promise<{ success: boolean; messageId?: string }>((resolve) => {
        socketA!.emit(
          SocketEvents.MESSAGE_SEND,
          { type: 'TEXT', content: 'cross-node message', clientMessageId: 'gw-dedup-1' },
          resolve
        );
      });
      const firstAck = await sendAck;
      const firstMessageId = firstAck.messageId;
      expect(firstAck.success).toBe(true);
      expect(typeof firstMessageId).toBe('string');
      expect(await delivered).toMatchObject({
        senderId: userIds[0],
        content: 'cross-node message',
        type: 'TEXT',
      });

      // Retrying with same clientMessageId returns the original messageId idempotently
      const dupAck = await new Promise<{ success: boolean; messageId?: string }>((resolve) => {
        socketA!.emit(
          SocketEvents.MESSAGE_SEND,
          { type: 'TEXT', content: 'cross-node message', clientMessageId: 'gw-dedup-1' },
          resolve
        );
      });
      expect(dupAck.success).toBe(true);
      expect(dupAck.messageId).toBe(firstMessageId);

      // Sending a forged/unfinalized IMAGE message without a READY asset is rejected cleanly
      const fakeMediaAck = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        socketA!.emit(
          SocketEvents.MESSAGE_SEND,
          {
            type: 'IMAGE',
            content: JSON.stringify({
              mediaId: '99999999-9999-4999-8999-999999999999',
              contentType: 'image/webp',
              mediaType: 'IMAGE',
            }),
          },
          resolve
        );
      });
      expect(fakeMediaAck.success).toBe(false);
      expect(fakeMediaAck.error).toBeTruthy();

      const endedA = waitForEvent<ChatEndedEvent>(socketA!, SocketEvents.CHAT_ENDED);
      const endedB = waitForEvent<ChatEndedEvent>(socketB!, SocketEvents.CHAT_ENDED);
      const endAck = new Promise<{ success: boolean }>((resolve) => {
        socketA!.emit(SocketEvents.CHAT_END, {}, resolve);
      });
      expect(await endAck).toEqual({ success: true });
      await Promise.all([endedA, endedB]);
      const session = await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, matchA.sessionId) });
      expect(session?.status).toBe('ENDED');
    } finally {
      clients.forEach((socket) => socket.disconnect());
      await Promise.all(socketServers.map((server) =>
        new Promise<void>((resolve) => server.close(() => resolve()))
      ));
      await Promise.all(gateways.map((gateway) => gateway.close()));
      await Promise.all([
        ...matchingEngines.map((engine) => engine.close()),
        ...coordinators.map((coordinator) => coordinator.close()),
        ...adapterClients.map((client) => client.quit()),
      ]);
      await db.delete(chatSessions).where(or(
        ...userIds.flatMap((id) => [eq(chatSessions.userAId, id), eq(chatSessions.userBId, id)])
      ));
      await db.delete(users).where(inArray(users.id, userIds));
      const cleanupRedis = new Redis(config.redisUrl);
      const testKeys = await cleanupRedis.keys(`${redisNamespace}:*`);
      if (testKeys.length > 0) await cleanupRedis.del(...testKeys);
      await cleanupRedis.quit();
    }
  });

  it('fails closed without broadcasting when group block lookup throws during emitGroupMessage, then delivers only to unblocked users on retry', async () => {
    const [senderId, blockerId, peerId] = [randomUUID(), randomUUID(), randomUUID()];
    const userIds = [senderId, blockerId, peerId];
    const emails = userIds.map((id) => `grp-fc-${id}@chatible.test`);
    const roomId = randomUUID();
    const httpServer = createServer();
    const socketServer = new SocketIOServer(httpServer, { transports: ['websocket'] });
    const redisNamespace = `chatible:test:gateway-fc:${randomUUID()}`;
    const matchingEngine = new MatchingEngine(config.redisUrl, redisNamespace);
    const sessionCoordinator = new RedisSessionCoordinator(config.redisUrl, redisNamespace, matchingEngine.instanceId);
    const safetyService = new SafetyService(cryptoService, config.superAdminId);
    const clients: ClientSocket[] = [];
    let gateway: ChatGateway | undefined;

    try {
      await db.insert(users).values(userIds.map((id, i) => ({ id, email: emails[i]! })));
      await db.insert(profiles).values(
        userIds.map((userId, i) => ({
          userId,
          nickname: `FailClosed ${i}`,
          gender: 'OTHER',
          birthDate: '1992-01-01',
          calculatedAge: 34,
        }))
      );
      await safetyService.blockUser(blockerId, senderId);

      await Promise.all([matchingEngine.connect(), sessionCoordinator.connect()]);
      gateway = new ChatGateway(
        socketServer,
        matchingEngine,
        sessionCoordinator,
        cryptoService,
        new FriendsService(cryptoService),
        safetyService,
        new MediaService()
      );
      gateway.setGroupAccessChecker(async () => true);
      await gateway.registerHandlers();

      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const url = `http://127.0.0.1:${address.port}`;

      const [sockSender, sockBlocker, sockPeer] = await Promise.all(
        userIds.map((id, i) =>
          connectUser(url, JwtUtil.sign({ sub: id, email: emails[i]! }, config.jwtSecret))
        )
      );
      clients.push(sockSender!, sockBlocker!, sockPeer!);

      await Promise.all(
        clients.map(
          (s) =>
            new Promise<void>((resolve, reject) => {
              s.emit(SocketEvents.GROUP_JOIN, { roomId }, (ack: { success: boolean; error?: string }) => {
                if (ack?.success) resolve();
                else reject(new Error(ack?.error || 'GROUP_JOIN failed'));
              });
            })
        )
      );

      const blockerEvents: unknown[] = [];
      const peerEvents: Array<{ content?: string; isSelf?: boolean; canReport?: boolean }> = [];
      const senderEvents: Array<{ content?: string; isSelf?: boolean; canReport?: boolean }> = [];
      sockBlocker!.on(SocketEvents.GROUP_MESSAGE_RECEIVE, (d) => blockerEvents.push(d));
      sockPeer!.on(SocketEvents.GROUP_MESSAGE_RECEIVE, (d) => peerEvents.push(d));
      sockSender!.on(SocketEvents.GROUP_MESSAGE_RECEIVE, (d) => senderEvents.push(d));

      // Simulate transient Redis/DB outage during block lookup -> must FAIL CLOSED (0 deliveries, no room fallback)
      const origIsBlocked = safetyService.isBlocked.bind(safetyService);
      safetyService.isBlocked = async () => {
        throw new Error('simulated DB connection reset');
      };
      gateway.emitGroupMessage(roomId, {
        id: randomUUID(),
        roomId,
        senderId,
        content: 'blocked-secret-message',
        isAdmin: false,
      });

      await new Promise((r) => setTimeout(r, 120));
      expect(blockerEvents).toHaveLength(0);
      expect(peerEvents).toHaveLength(0);
      expect(senderEvents).toHaveLength(0);
      const metricsDuringOutage = gateway.getGroupDeliveryMetrics();
      expect(metricsDuringOutage.failClosedAborts).toBe(1);
      expect(metricsDuringOutage.pendingRetryCount).toBe(1);

      // Recover DB lookup and flush retry -> delivers to peer & sender, STILL filters out blocker!
      safetyService.isBlocked = origIsBlocked;
      const retried = await gateway.retryFailedGroupDeliveries();
      expect(retried).toBe(1);
      await new Promise((r) => setTimeout(r, 80));

      expect(blockerEvents).toHaveLength(0);
      expect(peerEvents).toHaveLength(1);
      expect(peerEvents[0]).toMatchObject({ content: 'blocked-secret-message', isSelf: false, canReport: true });
      expect(senderEvents).toHaveLength(1);
      expect(senderEvents[0]).toMatchObject({ content: 'blocked-secret-message', isSelf: true, canReport: false });
      const metricsAfterRetry = gateway.getGroupDeliveryMetrics();
      expect(metricsAfterRetry.blockedFiltered).toBeGreaterThanOrEqual(1);
      expect(metricsAfterRetry.retriesSucceeded).toBe(1);
      expect(metricsAfterRetry.pendingRetryCount).toBe(0);
    } finally {
      clients.forEach((s) => s.disconnect());
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      await gateway?.close();
      await matchingEngine.close();
      await sessionCoordinator.close();
      const cleanupRedis = new Redis(config.redisUrl);
      const testKeys = await cleanupRedis.keys(`${redisNamespace}:*`);
      if (testKeys.length > 0) await cleanupRedis.del(...testKeys);
      await cleanupRedis.quit();
      await db.delete(blockedUsers).where(or(inArray(blockedUsers.blockerId, userIds), inArray(blockedUsers.blockedId, userIds)));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it('blocks matching join when auth.email_verification.required=true until user verifies email', async () => {
    const userId = randomUUID();
    const email = `verif-match-${userId}@chatible.test`;
    const httpServer = createServer();
    const socketServer = new SocketIOServer(httpServer, { transports: ['websocket'] });
    const redisNamespace = `chatible:test:gateway-verif:${randomUUID()}`;
    const matchingEngine = new MatchingEngine(config.redisUrl, redisNamespace);
    const sessionCoordinator = new RedisSessionCoordinator(config.redisUrl, redisNamespace, matchingEngine.instanceId);
    const safetyService = new SafetyService(cryptoService, config.superAdminId);
    let client: ClientSocket | undefined;
    let gateway: ChatGateway | undefined;

    const [prevSetting] = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, 'auth.email_verification.required'))
      .limit(1);

    try {
      await db
        .insert(systemSettings)
        .values({
          key: 'auth.email_verification.required',
          value: 'true',
          category: 'AUTH',
        })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: 'true', updatedAt: new Date() },
        });

      await db.insert(users).values({ id: userId, email, emailVerifiedAt: null });
      await db.insert(profiles).values({
        userId,
        nickname: 'UnverifiedUser',
        gender: 'MALE',
        birthDate: '1994-01-01',
        calculatedAge: 32,
      });

      await Promise.all([matchingEngine.connect(), sessionCoordinator.connect()]);
      gateway = new ChatGateway(
        socketServer,
        matchingEngine,
        sessionCoordinator,
        cryptoService,
        new FriendsService(cryptoService),
        safetyService,
        new MediaService()
      );
      await gateway.registerHandlers();

      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const url = `http://127.0.0.1:${address.port}`;

      client = await connectUser(url, JwtUtil.sign({ sub: userId, email }, config.jwtSecret));

      const errPromise = waitForEvent<MatchingErrorEvent>(client, SocketEvents.MATCHING_ERROR);
      client.emit(SocketEvents.MATCHING_JOIN, { targetGender: 'ALL', ageMin: 18, ageMax: 35 });
      const errEvent = await errPromise;
      expect(errEvent.error).toContain('xác minh email');
      expect(matchingEngine.getQueueSize()).toBe(0);

      // Verify user email -> MATCHING_JOIN succeeds & user enters queue
      await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
      client.emit(SocketEvents.MATCHING_JOIN, { targetGender: 'ALL', ageMin: 18, ageMax: 35 });
      await waitForQueueSize(matchingEngine, 1);
    } finally {
      if (prevSetting) {
        await db
          .insert(systemSettings)
          .values(prevSetting)
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: prevSetting.value, updatedAt: new Date() },
          });
      }
      client?.disconnect();
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      await gateway?.close();
      await matchingEngine.close();
      await sessionCoordinator.close();
      const cleanupRedis = new Redis(config.redisUrl);
      const testKeys = await cleanupRedis.keys(`${redisNamespace}:*`);
      if (testKeys.length > 0) await cleanupRedis.del(...testKeys);
      await cleanupRedis.quit();
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});

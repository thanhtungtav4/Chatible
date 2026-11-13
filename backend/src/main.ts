import type { FastifyRequest } from 'fastify';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config/env.js';
import { db } from './database/index.js';
import { users } from './database/schema/users.js';
import { sql } from 'drizzle-orm';
import { createConfiguredKms } from './kms/cloud-kms.service.js';
import { EnvelopeCryptoService } from './crypto/envelope.service.js';
import { AuthService } from './auth/auth.service.js';
import { AuthController } from './auth/auth.controller.js';
import { MatchingEngine } from './matching/matching.service.js';
import { ChatGateway } from './realtime/chat.gateway.js';
import { MediaService } from './media/media.service.js';
import { MediaController } from './media/media.controller.js';
import { RedisVideoWatermarkQueue } from './media/media-queue.service.js';
import { SafetyService } from './safety/safety.service.js';
import { SafetyNotificationService } from './safety/notification.service.js';
import { FriendsService } from './friends/friends.service.js';
import { AdminService } from './admin/admin.service.js';
import { DataCleanupService } from './cron/cleanup.service.js';
import { AdminController } from './admin/admin.controller.js';
import { FriendsController } from './friends/friends.controller.js';
import { RecentSessionsController } from './sessions/recent-sessions.controller.js';
import { SafetyController } from './safety/safety.controller.js';
import { RedisSessionCoordinator } from './matching/session.coordinator.js';
import { MailService } from './mail/mail.service.js';
import { GroupsService } from './groups/groups.service.js';
import { GroupsController } from './groups/groups.controller.js';
import { registerCsrfOriginProtection, tokenRevocationStore } from './auth/session-auth.util.js';

function serializeRequest(request: FastifyRequest) {
  const rawUrl = request.url ?? '';
  let url: string;
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token/i.test(key)) parsed.searchParams.delete(key);
    }
    url = `${parsed.pathname}${parsed.search}`;
  } catch {
    url = rawUrl.split('?', 1)[0] ?? '';
  }
  return {
    method: request.method,
    url,
    hostname: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.raw.socket.remotePort,
  };
}

async function ensureSuperAdminPrincipal(): Promise<void> {
  await db
    .insert(users)
    .values({
      id: config.superAdminId,
      email: `super-admin+${config.superAdminId}@chatible.internal`,
      status: 'SYSTEM',
    })
    .onConflictDoNothing({ target: users.id });
}

async function bootstrap() {
  const trustProxy = process.env.TRUST_PROXY === 'true' || config.nodeEnv === 'production';
  const app = fastify({
    trustProxy,
    bodyLimit: 1_048_576,
    logger: {
      level: 'info',
      serializers: { req: serializeRequest },
      redact: ['req.headers.authorization', 'req.headers.x-media-view-token', 'req.headers.cookie'],
    },
  });
  await ensureSuperAdminPrincipal();

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com/gsi/style'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'blob:', 'data:', 'https://*.googleusercontent.com'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'https://accounts.google.com/gsi/', ...config.corsOrigins],
        frameSrc: ["'self'", 'https://accounts.google.com/gsi/'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || config.corsOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error('Không được phép bởi chính sách CORS (Not allowed by CORS policy).'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: [
      'X-Media-Iv',
      'X-Media-Auth-Tag',
      'X-Media-Content-Type',
      'X-Media-Watermarked',
      'X-Audit-Sha256',
      'X-Audit-Uploaded-Key',
    ],
  });

  registerCsrfOriginProtection(app);

  app.get('/live', async (_req, reply) => {
    return reply.status(200).send({
      status: 'alive',
      service: 'chatible-backend',
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness & Healthcheck endpoint (checks DB, Redis & Media Worker/FFmpeg heartbeat)
  const { kms, providerLabel } = createConfiguredKms((event) => {
    app.log.info({ keyAccessAudit: event }, '[KeyAccessAudit]');
  });

  const sharedRedis = new Redis(config.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  const videoQueue = new RedisVideoWatermarkQueue(sharedRedis);

  const handleHealthCheck = async (_req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    let dbStatus = 'ok';
    let redisStatus = 'ok';
    let workerHealth = { healthy: false, liveWorkers: 0, ffmpegOk: false };
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      dbStatus = 'error';
    }
    try {
      if (sharedRedis.status !== 'ready') {
        await sharedRedis.connect();
      }
      await sharedRedis.ping();
      workerHealth = await videoQueue.getWorkerHealth();
    } catch {
      redisStatus = 'error';
    }
    const isHealthy = dbStatus === 'ok' && redisStatus === 'ok' && workerHealth.healthy;
    return reply.status(isHealthy ? 200 : 503).send({
      status: isHealthy ? 'ok' : 'degraded',
      service: 'chatible-backend',
      timestamp: new Date().toISOString(),
      kms: providerLabel,
      dependencies: {
        database: dbStatus,
        redis: redisStatus,
        mediaWorker: {
          status: workerHealth.healthy ? 'ok' : 'error',
          liveWorkers: workerHealth.liveWorkers,
          ffmpegOk: workerHealth.ffmpegOk,
        },
      },
    });
  };

  app.get('/health', handleHealthCheck);
  app.get('/ready', handleHealthCheck);

  const cryptoService = new EnvelopeCryptoService(kms);
  const mailService = new MailService({ cryptoService });

  // Register Auth & User Profile Routes (18+ enforcement)
  const authService = new AuthService(mailService);
  const authController = new AuthController(authService);
  authController.registerRoutes(app);

  // Media operations use configured object storage, bounded Sharp semaphore & isolated Redis video worker.
  const mediaService = new MediaService({ kms, videoQueue });
  const mediaController = new MediaController(mediaService);
  mediaController.registerRoutes(app);

  // Groups & Channels
  const groupsService = new GroupsService(cryptoService, config.superAdminId);
  await groupsService.ensureDefaultRooms();

  // Register Super Admin S11 Control Deck & Audit Routes
  const friendsService = new FriendsService(cryptoService, mediaService);
  const safetyService = new SafetyService(cryptoService, config.superAdminId);
  const notificationService = new SafetyNotificationService(mailService);
  const groupsController = new GroupsController(groupsService, safetyService);
  groupsController.registerRoutes(app);
  const adminService = new AdminService(cryptoService, config.superAdminId, mailService, mediaService, notificationService);
  const adminController = new AdminController(adminService, groupsService);
  adminController.registerRoutes(app);

  // Register Friends, Recent Sessions & Safety Routes
  const friendsController = new FriendsController(friendsService);
  friendsController.registerRoutes(app);

  const recentSessionsController = new RecentSessionsController(cryptoService);
  recentSessionsController.registerRoutes(app);

  const safetyController = new SafetyController(safetyService, notificationService);
  safetyController.registerRoutes(app);

  // Start automated Data Cleanup Runner (runs on startup, then every hour)
  const cleanupService = new DataCleanupService(mediaService);
  void cleanupService.executeCleanup().catch((err) => app.log.error(err, '[DataCleanup Initial Error]'));
  setInterval(() => {
    cleanupService.executeCleanup().catch((err) => app.log.error(err, '[DataCleanup Error]'));
  }, 3600000);

  // Bind Socket.io to Fastify server
  const io = new SocketIOServer(app.server, {
    cors: {
      origin: (origin, cb) => {
        if (!origin || config.corsOrigins.includes(origin)) {
          cb(null, true);
          return;
        }
        cb(new Error('Không được phép bởi chính sách CORS (Not allowed by CORS policy).'), false);
      },
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });
  const matchingEngine = new MatchingEngine(sharedRedis);
  const sessionCoordinator = new RedisSessionCoordinator(
    sharedRedis,
    matchingEngine.namespace,
    matchingEngine.instanceId
  );
  const adapterPublisher = new Redis(config.redisUrl, { lazyConnect: true, retryStrategy: () => null });
  const adapterSubscriber = adapterPublisher.duplicate();

  matchingEngine.setBlockChecker((userA, userB) => safetyService.isBlocked(userA, userB));
  const chatGateway = new ChatGateway(
    io,
    matchingEngine,
    sessionCoordinator,
    cryptoService,
    friendsService,
    safetyService,
    mediaService
  );
  friendsService.setOnFriendMessage((toUserId, msg) => chatGateway.emitFriendMessage(toUserId, msg));
  groupsService.setOnGroupMessage((roomId, msg) => chatGateway.emitGroupMessage(roomId, msg));
  chatGateway.setGroupAccessChecker((userId, roomId) => groupsService.hasRoomAccess(userId, roomId));

  adminController.setUserRevoker(async (userId) => {
    await tokenRevocationStore.revokeUserTokensBefore(userId, Date.now());
    await chatGateway.revokeUser(userId);
  });

  try {
    await sharedRedis.connect();
    await Promise.all([
      matchingEngine.connect(),
      sessionCoordinator.connect(),
      adapterPublisher.connect(),
      adapterSubscriber.connect(),
    ]);

    tokenRevocationStore.setRedis(sharedRedis);
    authController.setRedis(sharedRedis);
    mediaController.setRedis(sharedRedis);
    friendsController.setRedis(sharedRedis);
    safetyController.setRedis(sharedRedis);
    adminController.setRedis(sharedRedis);
    groupsController.setRedis(sharedRedis);
    chatGateway.setRedis(sharedRedis);

    io.adapter(createAdapter(adapterPublisher, adapterSubscriber));
    await chatGateway.registerHandlers();

    let mediaWorkerChild: ChildProcess | null = null;
    let mediaWorkerRestartTimer: NodeJS.Timeout | null = null;
    let isShuttingDown = false;
    let consecutiveWorkerCrashes = 0;

    // Production defaults to a standalone media-worker container/service;
    // embedded child mode is opt-in only (EMBEDDED_MEDIA_WORKER=true) and supervised.
    const spawnSupervisedMediaWorker = () => {
      if (isShuttingDown) return;
      const currentFile = fileURLToPath(import.meta.url);
      const isTs = currentFile.endsWith('.ts');
      const workerEntry = path.resolve(
        path.dirname(currentFile),
        isTs ? './media/media-worker.process.ts' : './media/media-worker.process.js'
      );
      const startedAt = Date.now();
      const workerMaxOldSpaceMb = Math.max(
        128,
        Math.min(1024, Number.parseInt(process.env.MEDIA_WORKER_MAX_OLD_SPACE_MB || '256', 10) || 256)
      );
      const child = fork(workerEntry, [], {
        execArgv: isTs
          ? ['--import', 'tsx', `--max-old-space-size=${workerMaxOldSpaceMb}`]
          : [`--max-old-space-size=${workerMaxOldSpaceMb}`],
        stdio: 'inherit',
      });
      mediaWorkerChild = child;

      const scheduleRestart = (reason: string) => {
        if (isShuttingDown || mediaWorkerRestartTimer) return;
        const ranForMs = Date.now() - startedAt;
        consecutiveWorkerCrashes = ranForMs > 30_000 ? 1 : consecutiveWorkerCrashes + 1;
        const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(consecutiveWorkerCrashes - 1, 5));
        app.log.error({ reason, delayMs, consecutiveWorkerCrashes }, '[MediaWorkerSupervisor] Worker stopped; scheduling restart');
        mediaWorkerRestartTimer = setTimeout(() => {
          mediaWorkerRestartTimer = null;
          spawnSupervisedMediaWorker();
        }, delayMs);
        mediaWorkerRestartTimer.unref();
      };

      child.once('error', (err) => {
        if (mediaWorkerChild === child) mediaWorkerChild = null;
        scheduleRestart(`error: ${err.message}`);
      });
      child.once('exit', (code, signal) => {
        if (mediaWorkerChild === child) mediaWorkerChild = null;
        if (!isShuttingDown) {
          scheduleRestart(`exit code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        }
      });
    };

    if (process.env.EMBEDDED_MEDIA_WORKER === 'true') {
      spawnSupervisedMediaWorker();
    }

    app.addHook('onClose', async () => {
      isShuttingDown = true;
      if (mediaWorkerRestartTimer) {
        clearTimeout(mediaWorkerRestartTimer);
        mediaWorkerRestartTimer = null;
      }
      if (mediaWorkerChild && !mediaWorkerChild.killed) {
        mediaWorkerChild.kill('SIGTERM');
      }
      await chatGateway.close();
      await Promise.all([
        matchingEngine.close(),
        sessionCoordinator.close(),
        adapterPublisher.quit(),
        adapterSubscriber.quit(),
        sharedRedis.quit(),
      ]);
    });
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Chatible Backend listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    await Promise.allSettled([
      matchingEngine.close(),
      sessionCoordinator.close(),
      adapterPublisher.quit(),
      adapterSubscriber.quit(),
      sharedRedis.quit(),
    ]);
    process.exit(1);
  }
}

bootstrap();

import crypto from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../database/index.js';
import { auditLogs } from '../database/schema/audit.js';
import { config } from '../config/env.js';

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'execute'>;

export interface RecordAuditInput {
  actorId: string;
  action: string;
  targetResourceId: string;
  ipAddress?: string;
  details?: Record<string, unknown> | null;
}

function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalizeJson(item))).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(',')}}`;
}

export function computeAuditEntryHash(input: {
  prevHash: string;
  actorId: string;
  action: string;
  targetResourceId: string;
  timestampIso: string;
  details?: unknown;
}): string {
  const canonical = `${input.prevHash}|${input.actorId}|${input.action}|${input.targetResourceId}|${input.timestampIso}|${canonicalizeJson(input.details ?? null)}`;
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export class AuditTrailService {
  async recordAudit(input: RecordAuditInput, tx?: DbExecutor): Promise<{ id: string; entryHash: string }> {
    const run = async (executor: DbExecutor) => {
      // Serialize concurrent inserts onto a deterministic hash chain
      await executor.execute(sql`SELECT pg_advisory_xact_lock(88421001)`);

      const [latest] = await executor
        .select({ entryHash: auditLogs.entryHash })
        .from(auditLogs)
        .orderBy(desc(auditLogs.seq))
        .limit(1);

      const prevHash = latest?.entryHash || AUDIT_GENESIS_HASH;
      const timestamp = new Date();
      const details = input.details ?? null;
      const entryHash = computeAuditEntryHash({
        prevHash,
        actorId: input.actorId,
        action: input.action,
        targetResourceId: input.targetResourceId,
        timestampIso: timestamp.toISOString(),
        details,
      });

      const [inserted] = await executor
        .insert(auditLogs)
        .values({
          actorId: input.actorId,
          action: input.action,
          targetResourceId: input.targetResourceId,
          ipAddress: input.ipAddress || '127.0.0.1',
          details,
          prevHash,
          entryHash,
          timestamp,
        })
        .returning({ id: auditLogs.id, entryHash: auditLogs.entryHash });

      return { id: inserted!.id, entryHash: inserted!.entryHash! };
    };

    if (tx) return run(tx);
    return db.transaction(async (trx) => run(trx));
  }

  async verifyAuditChain(): Promise<{
    valid: boolean;
    totalEntries: number;
    verifiedHashedEntries: number;
    brokenAtSeq?: number;
    brokenAtId?: string;
    latestHash: string;
  }> {
    const rows = await db
      .select()
      .from(auditLogs)
      .orderBy(asc(auditLogs.seq));

    let expectedPrevHash = AUDIT_GENESIS_HASH;
    let verifiedHashedEntries = 0;

    for (const row of rows) {
      if (!row.entryHash) {
        // Legacy pre-hash-chain record
        continue;
      }
      if (row.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          totalEntries: rows.length,
          verifiedHashedEntries,
          brokenAtSeq: row.seq,
          brokenAtId: row.id,
          latestHash: expectedPrevHash,
        };
      }
      const recomputed = computeAuditEntryHash({
        prevHash: row.prevHash,
        actorId: row.actorId,
        action: row.action,
        targetResourceId: row.targetResourceId,
        timestampIso: row.timestamp.toISOString(),
        details: row.details ?? null,
      });
      if (recomputed !== row.entryHash) {
        return {
          valid: false,
          totalEntries: rows.length,
          verifiedHashedEntries,
          brokenAtSeq: row.seq,
          brokenAtId: row.id,
          latestHash: expectedPrevHash,
        };
      }
      expectedPrevHash = row.entryHash;
      verifiedHashedEntries += 1;
    }

    return {
      valid: true,
      totalEntries: rows.length,
      verifiedHashedEntries,
      latestHash: expectedPrevHash,
    };
  }

  async exportImmutableSnapshot(): Promise<{
    jsonl: string;
    sha256: string;
    totalEntries: number;
    uploadedObjectKey?: string;
  }> {
    const rows = await db
      .select()
      .from(auditLogs)
      .orderBy(asc(auditLogs.seq));

    const lines = rows.map((r) =>
      JSON.stringify({
        seq: r.seq,
        id: r.id,
        actorId: r.actorId,
        action: r.action,
        targetResourceId: r.targetResourceId,
        ipAddress: r.ipAddress,
        details: r.details,
        prevHash: r.prevHash,
        entryHash: r.entryHash,
        timestamp: r.timestamp.toISOString(),
      })
    );
    const jsonl = lines.join('\n') + (lines.length ? '\n' : '');
    const sha256 = crypto.createHash('sha256').update(jsonl).digest('hex');

    let uploadedObjectKey: string | undefined;
    const storage = config.objectStorage;
    if (storage.endpoint && storage.bucket && storage.accessKeyId && storage.secretAccessKey) {
      try {
        const s3 = new S3Client({
          endpoint: storage.endpoint,
          region: storage.region,
          forcePathStyle: storage.forcePathStyle,
          credentials: {
            accessKeyId: storage.accessKeyId,
            secretAccessKey: storage.secretAccessKey,
          },
        });
        const key = `audit-exports/audit-${Date.now()}-${sha256.slice(0, 12)}.jsonl`;
        await s3.send(
          new PutObjectCommand({
            Bucket: storage.bucket,
            Key: key,
            Body: Buffer.from(jsonl, 'utf8'),
            ContentType: 'application/x-ndjson',
            Metadata: { 'audit-sha256': sha256 },
          })
        );
        uploadedObjectKey = key;
      } catch (err) {
        console.error('[AuditExport] Failed to upload audit snapshot to S3:', err);
      }
    }

    return {
      jsonl,
      sha256,
      totalEntries: rows.length,
      uploadedObjectKey,
    };
  }

  async getAuditRowForTest(id: string) {
    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.id, id)).limit(1);
    return row ?? null;
  }
}

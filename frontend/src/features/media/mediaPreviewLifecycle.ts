export interface MediaViewState {
  previewUrl?: string;
  watermarkText?: string;
  watermarkedMode?: 'embedded' | 'overlay';
  revoked?: boolean;
}

export interface SessionMediaMeta {
  mediaId: string;
  contentType: string;
  mediaType: 'IMAGE' | 'AUDIO' | 'VIDEO';
  waveform?: number[];
  durationSec?: number;
  width?: number;
  height?: number;
  isAdult?: boolean;
  revoked?: boolean;
}

export function parseSessionMediaPayload(
  content: string,
  expectedType: SessionMediaMeta['mediaType'],
  fallbackIsAdult = false
): SessionMediaMeta | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.mediaId !== 'string' ||
      !value.mediaId ||
      typeof value.contentType !== 'string' ||
      !/^(image|audio|video)\/[a-z0-9.+-]+$/i.test(value.contentType) ||
      (value.mediaType !== undefined && value.mediaType !== expectedType)
    ) {
      return undefined;
    }

    const waveform =
      Array.isArray(value.waveform) &&
      value.waveform.length === 30 &&
      value.waveform.every((sample) => typeof sample === 'number' && Number.isFinite(sample) && sample >= 0 && sample <= 1)
        ? (value.waveform as number[])
        : undefined;
    const durationSec =
      typeof value.durationSec === 'number' && Number.isFinite(value.durationSec) && value.durationSec >= 0
        ? value.durationSec
        : undefined;
    const width = Number.isSafeInteger(value.width) && (value.width as number) > 0 ? (value.width as number) : undefined;
    const height = Number.isSafeInteger(value.height) && (value.height as number) > 0 ? (value.height as number) : undefined;
    const isAdult = Boolean(fallbackIsAdult || value.isAdult === true);

    return {
      mediaId: value.mediaId,
      contentType: value.contentType,
      mediaType: expectedType,
      ...(isAdult ? { isAdult: true } : {}),
      ...(waveform ? { waveform } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    };
  } catch {
    return undefined;
  }
}

export interface DecryptedPreviewPayload {
  previewUrl: string;
  watermarkText?: string;
  watermarkedMode?: 'embedded' | 'overlay';
  expiresIn?: number;
}

export interface PreviewLifecycleDeps {
  revokeObjectUrl: (url: string) => void;
  setTimer: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (id: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_EXPIRY_SECONDS = 300;

function defaultDeps(): PreviewLifecycleDeps {
  return {
    revokeObjectUrl: (url: string) => URL.revokeObjectURL(url),
    setTimer: (fn: () => void, delayMs: number) => globalThis.setTimeout(fn, delayMs),
    clearTimer: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
  };
}

/**
 * Manages temporary object URLs and expiry timers across media preview lifecycles
 * (expiry, explicit revoke, session change, and component unmount).
 */
export class MediaPreviewLifecycle {
  private readonly urls = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly revokedMediaIds = new Set<string>();
  private readonly mediaEpochs = new Map<string, number>();
  private readonly deps: PreviewLifecycleDeps;

  constructor(deps?: Partial<PreviewLifecycleDeps>) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  beginLoad(mediaId: string): { epoch: number } | null {
    if (this.revokedMediaIds.has(mediaId)) {
      return null;
    }
    return { epoch: this.mediaEpochs.get(mediaId) ?? 0 };
  }

  canCommitLoad(mediaId: string, ticket: { epoch: number }): boolean {
    if (this.revokedMediaIds.has(mediaId)) return false;
    return (this.mediaEpochs.get(mediaId) ?? 0) === ticket.epoch;
  }

  invalidateLoads(mediaId: string): void {
    this.mediaEpochs.set(mediaId, (this.mediaEpochs.get(mediaId) ?? 0) + 1);
  }

  markMediaIdRevoked(mediaId: string): void {
    this.revokedMediaIds.add(mediaId);
    this.invalidateLoads(mediaId);
  }

  clearMediaIdRevoked(mediaId: string): void {
    this.revokedMediaIds.delete(mediaId);
    this.invalidateLoads(mediaId);
  }

  isMediaIdRevoked(mediaId: string): boolean {
    return this.revokedMediaIds.has(mediaId);
  }

  register(
    messageId: string,
    payload: DecryptedPreviewPayload,
    onExpire: (expiredMessageId: string) => void
  ): void {
    this.clear(messageId);
    this.urls.set(messageId, payload.previewUrl);

    const ttlMs = (payload.expiresIn && payload.expiresIn > 0 ? payload.expiresIn : DEFAULT_EXPIRY_SECONDS) * 1000;
    const timer = this.deps.setTimer(() => {
      this.timers.delete(messageId);
      const url = this.urls.get(messageId);
      if (url) {
        this.deps.revokeObjectUrl(url);
        this.urls.delete(messageId);
      }
      onExpire(messageId);
    }, ttlMs);

    this.timers.set(messageId, timer);
  }

  clear(messageId: string): boolean {
    let removed = false;
    const timer = this.timers.get(messageId);
    if (timer !== undefined) {
      this.deps.clearTimer(timer);
      this.timers.delete(messageId);
      removed = true;
    }

    const url = this.urls.get(messageId);
    if (url) {
      this.deps.revokeObjectUrl(url);
      this.urls.delete(messageId);
      removed = true;
    }

    return removed;
  }

  clearMatchingMediaId(
    targetMediaId: string,
    entries: Array<{ messageId: string; mediaId?: string | null }>
  ): string[] {
    this.markMediaIdRevoked(targetMediaId);
    const cleared: string[] = [];
    for (const entry of entries) {
      if (entry.mediaId === targetMediaId) {
        this.clear(entry.messageId);
        cleared.push(entry.messageId);
      }
    }
    return cleared;
  }

  clearAll(): void {
    const keys = new Set<string>([...this.urls.keys(), ...this.timers.keys()]);
    for (const messageId of keys) {
      this.clear(messageId);
    }
    this.revokedMediaIds.clear();
    this.mediaEpochs.clear();
  }

  getActiveUrlCount(): number {
    return this.urls.size;
  }

  getActiveTimerCount(): number {
    return this.timers.size;
  }
}

/**
 * Runs image compression (if needed) and upload while verifying that the caller's
 * captured session & recipient remain active before and after each async step.
 */
export async function compressAndUploadWithContextGuard<TFile, TMeta>(input: {
  isContextCurrent: () => boolean;
  isImage: boolean;
  rawFile: TFile;
  compressImage: (file: TFile) => Promise<{ file: TFile; meta: TMeta }>;
  uploadAndSend: (file: TFile, meta?: TMeta) => Promise<void>;
}): Promise<boolean> {
  if (!input.isContextCurrent()) return false;
  if (input.isImage) {
    const compressed = await input.compressImage(input.rawFile);
    if (!input.isContextCurrent()) return false;
    await input.uploadAndSend(compressed.file, compressed.meta);
    return true;
  }
  await input.uploadAndSend(input.rawFile);
  return true;
}

/**
 * Cancels in-flight preview loads for `mediaId`, requests server revocation, and on failure
 * reconciles with authoritative server status so failed revokes do not leave previews stuck.
 */
export async function executeRevokeWithSync(input: {
  lifecycle: MediaPreviewLifecycle;
  messageId: string;
  mediaId: string;
  revokeOnServer: (mediaId: string) => Promise<void>;
  syncServerStatus: (mediaId: string) => Promise<'revoked' | 'active' | 'unknown'>;
}): Promise<{ revoked: boolean; error?: unknown }> {
  input.lifecycle.invalidateLoads(input.mediaId);
  input.lifecycle.clear(input.messageId);

  try {
    await input.revokeOnServer(input.mediaId);
    input.lifecycle.markMediaIdRevoked(input.mediaId);
    return { revoked: true };
  } catch (error) {
    const serverState = await input.syncServerStatus(input.mediaId);
    if (serverState === 'revoked') {
      input.lifecycle.markMediaIdRevoked(input.mediaId);
      return { revoked: true };
    }
    input.lifecycle.clearMediaIdRevoked(input.mediaId);
    return { revoked: false, error };
  }
}

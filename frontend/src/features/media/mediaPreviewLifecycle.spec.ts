import { describe, expect, it } from 'bun:test';
import { AudioRecorder } from './audio-recorder.js';
import {
  compressAndUploadWithContextGuard,
  executeRevokeWithSync,
  MediaPreviewLifecycle,
  parseSessionMediaPayload,
} from './mediaPreviewLifecycle.js';

describe('MediaPreviewLifecycle & payload parser', () => {
  it('tracks preview URLs, replaces safely without leaking old URLs, and revokes upon expiry', () => {
    const revokedUrls: string[] = [];
    const scheduled = new Map<number, () => void>();
    const clearedTimers: number[] = [];
    let nextTimerId = 1;

    const lifecycle = new MediaPreviewLifecycle({
      revokeObjectUrl: (url) => revokedUrls.push(url),
      setTimer: (fn) => {
        const id = nextTimerId++;
        scheduled.set(id, fn);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (id) => {
        const num = id as unknown as number;
        clearedTimers.push(num);
        scheduled.delete(num);
      },
    });

    const expired: string[] = [];
    lifecycle.register(
      'msg-1',
      { previewUrl: 'blob:chatible/first', watermarkedMode: 'embedded', expiresIn: 120 },
      (id) => expired.push(id)
    );
    expect(lifecycle.getActiveUrlCount()).toBe(1);
    expect(lifecycle.getActiveTimerCount()).toBe(1);

    // Re-opening msg-1 must revoke 'first' and cancel timer 1 before registering 'second'
    lifecycle.register(
      'msg-1',
      { previewUrl: 'blob:chatible/second', watermarkedMode: 'embedded', expiresIn: 300 },
      (id) => expired.push(id)
    );
    expect(revokedUrls).toEqual(['blob:chatible/first']);
    expect(clearedTimers).toEqual([1]);
    expect(lifecycle.getActiveUrlCount()).toBe(1);

    // Trigger expiry for timer 2
    const timerFn = scheduled.get(2);
    expect(timerFn).toBeDefined();
    timerFn!();

    expect(revokedUrls).toEqual(['blob:chatible/first', 'blob:chatible/second']);
    expect(expired).toEqual(['msg-1']);
    expect(lifecycle.getActiveUrlCount()).toBe(0);
    expect(lifecycle.getActiveTimerCount()).toBe(0);
  });

  it('revokes matching mediaId entries and clears all active previews & timers on session switch or unmount', () => {
    const revokedUrls: string[] = [];
    const clearedTimers: number[] = [];
    let nextTimerId = 1;

    const lifecycle = new MediaPreviewLifecycle({
      revokeObjectUrl: (url) => revokedUrls.push(url),
      setTimer: () => (nextTimerId++) as unknown as ReturnType<typeof setTimeout>,
      clearTimer: (id) => {
        clearedTimers.push(id as unknown as number);
      },
    });

    lifecycle.register('m1', { previewUrl: 'blob:chatible/a' }, () => {});
    lifecycle.register('m2', { previewUrl: 'blob:chatible/b' }, () => {});
    lifecycle.register('m3', { previewUrl: 'blob:chatible/c' }, () => {});

    const clearedForMedia = lifecycle.clearMatchingMediaId('asset-1', [
      { messageId: 'm1', mediaId: 'asset-1' },
      { messageId: 'm2', mediaId: 'asset-2' },
      { messageId: 'm3', mediaId: 'asset-1' },
    ]);
    expect(clearedForMedia).toEqual(['m1', 'm3']);
    expect(revokedUrls).toEqual(['blob:chatible/a', 'blob:chatible/c']);
    expect(lifecycle.getActiveUrlCount()).toBe(1);
    expect(lifecycle.getActiveTimerCount()).toBe(1);

    // Session change / component unmount wipes remaining URLs & timers cleanly
    lifecycle.clearAll();
    expect(revokedUrls).toEqual(['blob:chatible/a', 'blob:chatible/c', 'blob:chatible/b']);
    expect(clearedTimers).toEqual([1, 3, 2]);
    expect(lifecycle.getActiveUrlCount()).toBe(0);
    expect(lifecycle.getActiveTimerCount()).toBe(0);
  });

  it('validates serialized media attachments safely across Random and Friend chats', () => {
    const valid = parseSessionMediaPayload(
      JSON.stringify({
        mediaId: 'med-1',
        contentType: 'image/webp',
        mediaType: 'IMAGE',
        width: 800,
        height: 600,
      }),
      'IMAGE',
      true
    );
    expect(valid).toEqual({
      mediaId: 'med-1',
      contentType: 'image/webp',
      mediaType: 'IMAGE',
      isAdult: true,
      width: 800,
      height: 600,
    });

    expect(
      parseSessionMediaPayload(
        JSON.stringify({ mediaId: 'med-1', contentType: 'text/html', mediaType: 'IMAGE' }),
        'IMAGE'
      )
    ).toBeUndefined();
    expect(
      parseSessionMediaPayload(
        JSON.stringify({ mediaId: 'med-1', contentType: 'video/mp4', mediaType: 'VIDEO' }),
        'IMAGE'
      )
    ).toBeUndefined();
    expect(parseSessionMediaPayload('not-json', 'AUDIO')).toBeUndefined();
  });

  it('prevents committing an in-flight preview fetch after mediaId is revoked (P2 race fix)', () => {
    const lifecycle = new MediaPreviewLifecycle({
      revokeObjectUrl: () => {},
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });

    const ticket = lifecycle.beginLoad('media-race-1');
    expect(ticket).not.toBeNull();

    // Simulate socket MEDIA_REVOKED or explicit revoke landing while decrypt/fetch is still running
    lifecycle.markMediaIdRevoked('media-race-1');
    expect(lifecycle.canCommitLoad('media-race-1', ticket!)).toBe(false);
    expect(lifecycle.beginLoad('media-race-1')).toBeNull();

    // Switching to another session resets revocation/epoch state cleanly
    lifecycle.clearAll();
    expect(lifecycle.beginLoad('media-race-1')).not.toBeNull();
  });

  it('aborts compressed image upload if session or recipient changes during async compression (P1 fix)', async () => {
    let activeSessionId = 'session-A';
    let uploadCalled = false;

    const sent = await compressAndUploadWithContextGuard({
      isContextCurrent: () => activeSessionId === 'session-A',
      isImage: true,
      rawFile: { name: 'photo.png' },
      compressImage: async () => {
        // User switches to session B before compression completes
        activeSessionId = 'session-B';
        return { file: { name: 'photo.webp' }, meta: { width: 800, height: 600 } };
      },
      uploadAndSend: async () => {
        uploadCalled = true;
      },
    });

    expect(sent).toBe(false);
    expect(uploadCalled).toBe(false);
  });

  it('stops microphone tracks immediately if AudioRecorder.cancel() runs during permission prompt (P1 fix)', async () => {
    const originalNavigator = globalThis.navigator;
    const originalMediaRecorder = globalThis.MediaRecorder;
    let resolveStream!: (stream: MediaStream) => void;
    let trackStopped = false;
    let recorderConstructed = false;

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: () =>
            new Promise<MediaStream>((resolve) => {
              resolveStream = resolve;
            }),
        },
      },
    });
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: class FakeRecorder {
        static isTypeSupported() {
          return true;
        }
        constructor() {
          recorderConstructed = true;
        }
      },
    });

    try {
      const recorder = new AudioRecorder();
      const startPromise = recorder.start();

      // Cancel while browser mic permission dialog is still awaiting user confirmation
      await recorder.cancel();
      expect(recorder.isCancelled()).toBe(true);

      resolveStream({
        getTracks: () => [{ stop: () => { trackStopped = true; } }],
      } as unknown as MediaStream);
      await startPromise;

      expect(trackStopped).toBe(true);
      expect(recorderConstructed).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
      Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: originalMediaRecorder });
    }
  });

  it('reconciles revoke failure with server status so beginLoad recovers when asset is still active or stays revoked when server succeeded', async () => {
    const lifecycle = new MediaPreviewLifecycle({
      revokeObjectUrl: () => {},
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });

    // Case 1: revoke fails on server and server status is still active -> beginLoad must NOT remain blocked
    const ticketDuringFail = lifecycle.beginLoad('m-active');
    expect(ticketDuringFail).not.toBeNull();
    const failOutcome = await executeRevokeWithSync({
      lifecycle,
      messageId: 'msg-a',
      mediaId: 'm-active',
      revokeOnServer: async () => {
        throw new Error('500 internal error');
      },
      syncServerStatus: async () => 'active',
    });
    expect(failOutcome.revoked).toBe(false);
    expect(lifecycle.canCommitLoad('m-active', ticketDuringFail!)).toBe(false);
    expect(lifecycle.beginLoad('m-active')).not.toBeNull();

    // Case 2: network dropped after server actually revoked -> sync reconciles to revoked
    const syncRevokedOutcome = await executeRevokeWithSync({
      lifecycle,
      messageId: 'msg-b',
      mediaId: 'm-revoked-on-server',
      revokeOnServer: async () => {
        throw new Error('network connection lost');
      },
      syncServerStatus: async () => 'revoked',
    });
    expect(syncRevokedOutcome.revoked).toBe(true);
    expect(lifecycle.beginLoad('m-revoked-on-server')).toBeNull();

    // Case 3: total offline unknown status -> does not permanently blacklist beginLoad
    const offlineOutcome = await executeRevokeWithSync({
      lifecycle,
      messageId: 'msg-c',
      mediaId: 'm-offline',
      revokeOnServer: async () => {
        throw new Error('offline');
      },
      syncServerStatus: async () => 'unknown',
    });
    expect(offlineOutcome.revoked).toBe(false);
    expect(lifecycle.beginLoad('m-offline')).not.toBeNull();
  });
});

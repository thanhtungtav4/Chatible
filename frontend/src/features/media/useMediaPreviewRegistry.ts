import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDecryptedMediaView,
  fetchMediaRevocationStatus,
  revokeMediaAsset,
  type ClientMediaType,
} from './encryptedMediaClient.js';
import {
  executeRevokeWithSync,
  MediaPreviewLifecycle,
  type MediaViewState,
} from './mediaPreviewLifecycle.js';

export type { MediaViewState };

export interface UseMediaPreviewRegistryOptions {
  sessionId: string | null;
  onError?: (message: string | null) => void;
  onRevoked?: (mediaId: string) => void;
}

/**
 * Shared React hook for managing decrypted media object URLs, expiry timers,
 * explicit/socket revocation, session-switch resets, and unmount cleanup.
 */
export function useMediaPreviewRegistry({
  sessionId,
  onError,
  onRevoked,
}: UseMediaPreviewRegistryOptions) {
  const [mediaViews, setMediaViews] = useState<Record<string, MediaViewState>>({});
  const [previewBusy, setPreviewBusy] = useState(false);

  const lifecycleRef = useRef<MediaPreviewLifecycle | null>(null);
  if (!lifecycleRef.current) {
    lifecycleRef.current = new MediaPreviewLifecycle();
  }

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const onErrorRef = useRef(onError);
  const onRevokedRef = useRef(onRevoked);
  onErrorRef.current = onError;
  onRevokedRef.current = onRevoked;

  const clearMediaPreview = useCallback((messageId: string) => {
    lifecycleRef.current?.clear(messageId);
  }, []);

  const clearAllMediaPreviews = useCallback(() => {
    generationRef.current += 1;
    lifecycleRef.current?.clearAll();
    if (mountedRef.current) {
      setMediaViews({});
    }
  }, []);

  // Reset all active preview URLs & invalidate in-flight loads when switching sessions
  useEffect(() => {
    generationRef.current += 1;
    lifecycleRef.current?.clearAll();
    setMediaViews({});
  }, [sessionId]);

  // Revoke all temporary object URLs and timers when unmounting (without touching React state)
  useEffect(() => {
    mountedRef.current = true;
    const lifecycle = lifecycleRef.current;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      lifecycle?.clearAll();
    };
  }, []);

  const openMediaPreview = useCallback(async (
    messageId: string,
    mediaId: string,
    contentType?: string
  ) => {
    const lifecycle = lifecycleRef.current;
    const loadTicket = lifecycle?.beginLoad(mediaId);
    if (!lifecycle || !loadTicket) return;

    const startGeneration = generationRef.current;
    setPreviewBusy(true);
    onErrorRef.current?.(null);

    try {
      const view = await fetchDecryptedMediaView(
        mediaId,
        contentType || 'application/octet-stream'
      );

      // Discard & immediately free blob URL if session changed, component unmounted, or media was revoked mid-fetch
      if (
        !mountedRef.current ||
        generationRef.current !== startGeneration ||
        !lifecycle.canCommitLoad(mediaId, loadTicket)
      ) {
        URL.revokeObjectURL(view.previewUrl);
        return;
      }

      lifecycle.register(messageId, view, (expiredId) => {
        if (!mountedRef.current || generationRef.current !== startGeneration) return;
        setMediaViews((prev) => ({
          ...prev,
          [expiredId]: { ...(prev[expiredId] || {}), previewUrl: undefined },
        }));
      });

      setMediaViews((prev) => ({
        ...prev,
        [messageId]: {
          previewUrl: view.previewUrl,
          watermarkText: view.watermarkText,
          watermarkedMode: view.watermarkedMode,
          revoked: false,
        },
      }));
    } catch (err) {
      if (
        mountedRef.current &&
        generationRef.current === startGeneration &&
        lifecycle.canCommitLoad(mediaId, loadTicket)
      ) {
        onErrorRef.current?.(err instanceof Error ? err.message : 'Không thể mở media.');
      }
    } finally {
      if (mountedRef.current) {
        setPreviewBusy(false);
      }
    }
  }, []);

  const revokeMediaPreview = useCallback(async (messageId: string, mediaId: string) => {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle) return;

    const startGeneration = generationRef.current;
    lifecycle.invalidateLoads(mediaId);
    lifecycle.clear(messageId);
    setMediaViews((prev) => ({
      ...prev,
      [messageId]: { ...(prev[messageId] || {}), previewUrl: undefined },
    }));

    const outcome = await executeRevokeWithSync({
      lifecycle,
      messageId,
      mediaId,
      revokeOnServer: revokeMediaAsset,
      syncServerStatus: fetchMediaRevocationStatus,
    });

    if (outcome.revoked) {
      if (!mountedRef.current || generationRef.current !== startGeneration) return;
      onRevokedRef.current?.(mediaId);
      setMediaViews((prev) => ({
        ...prev,
        [messageId]: { ...(prev[messageId] || {}), revoked: true, previewUrl: undefined },
      }));
      return;
    }

    if (mountedRef.current && generationRef.current === startGeneration) {
      setMediaViews((prev) => ({
        ...prev,
        [messageId]: { ...(prev[messageId] || {}), revoked: false, previewUrl: undefined },
      }));
      onErrorRef.current?.(
        outcome.error instanceof Error ? outcome.error.message : 'Không thể thu hồi media.'
      );
    }
  }, []);

  const markMediaRevoked = useCallback((
    mediaId: string,
    entries: Array<{ messageId: string; mediaId?: string | null; mediaType?: ClientMediaType }>
  ) => {
    const clearedIds = lifecycleRef.current?.clearMatchingMediaId(mediaId, entries) ?? [];
    if (clearedIds.length === 0 || !mountedRef.current) return;
    setMediaViews((prev) => {
      const next = { ...prev };
      for (const msgId of clearedIds) {
        next[msgId] = { ...(prev[msgId] || {}), revoked: true, previewUrl: undefined };
      }
      return next;
    });
  }, []);

  return {
    mediaViews,
    previewBusy,
    openMediaPreview,
    revokeMediaPreview,
    markMediaRevoked,
    clearMediaPreview,
    clearAllMediaPreviews,
  };
}

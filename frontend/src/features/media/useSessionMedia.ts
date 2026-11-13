import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { apiFetch } from '../../api.js';
import { AudioRecorder } from './audio-recorder.js';
import { uploadAndFinalizeEncryptedMedia, type ClientMediaType } from './encryptedMediaClient.js';
import { ImageCompressor } from './image-compressor.js';
import {
  compressAndUploadWithContextGuard,
  type MediaViewState,
} from './mediaPreviewLifecycle.js';
import { useMediaPreviewRegistry } from './useMediaPreviewRegistry.js';

export type { MediaViewState };

export interface UploadedSessionMedia {
  mediaId: string;
  contentType: string;
  mediaType: ClientMediaType;
  isAdult?: boolean;
  waveform?: number[];
  durationSec?: number;
  width?: number;
  height?: number;
}

export interface SendSessionMediaParams {
  media: UploadedSessionMedia;
  isAdult: boolean;
}

export interface UseSessionMediaOptions {
  sessionId: string | null;
  recipientId: string | null;
  canSend: boolean;
  voiceFilenamePrefix: string;
  partnerNotAdultConsentMessage: string;
  fileTooLargeMessage?: (mediaType: ClientMediaType) => string;
  onSendMediaMessage: (params: SendSessionMediaParams) => Promise<void>;
  onError: (message: string | null) => void;
  onConsentChanged?: (kind: 'MEDIA' | 'ADULT', enabled: boolean) => void;
  onRevoked?: (mediaId: string) => void;
}

const DEFAULT_SIZE_ERROR = (mediaType: ClientMediaType): string => {
  const limitLabel = mediaType === 'IMAGE' ? '30 MB' : mediaType === 'VIDEO' ? '100 MB' : '20 MB';
  const kindLabel = mediaType === 'IMAGE' ? 'Ảnh' : mediaType === 'VIDEO' ? 'Video' : 'Ghi âm';
  return `${kindLabel} phải nhỏ hơn ${limitLabel}.`;
};

async function readConsentError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error || fallback;
}

/**
 * Shared session media lifecycle hook used by both Random Chat and Friends 1-1 Chat.
 * Consolidates consent state, encryption/upload, image compression, voice recording,
 * adult sender confirmation, decrypted preview URL tracking, and revoke/unmount cleanup.
 */
export function useSessionMedia({
  sessionId,
  recipientId,
  canSend,
  voiceFilenamePrefix,
  partnerNotAdultConsentMessage,
  fileTooLargeMessage = DEFAULT_SIZE_ERROR,
  onSendMediaMessage,
  onError,
  onConsentChanged,
  onRevoked,
}: UseSessionMediaOptions) {
  const [mediaConsent, setMediaConsent] = useState(false);
  const [partnerMediaConsent, setPartnerMediaConsent] = useState(false);
  const [myAdultConsent, setMyAdultConsent] = useState(false);
  const [partnerAdultConsent, setPartnerAdultConsent] = useState(false);
  const [showAdultConsentModal, setShowAdultConsentModal] = useState(false);
  const [adultPolicyAck, setAdultPolicyAck] = useState(false);
  const [sendAsAdult, setSendAsAdult] = useState(false);
  const [showSenderAdultModal, setShowSenderAdultModal] = useState(false);
  const [senderConfirm18Plus, setSenderConfirm18Plus] = useState(false);
  const [senderConfirmConsent, setSenderConfirmConsent] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<{
    file: File;
    mediaType: 'IMAGE' | 'VIDEO';
    sessionId: string;
    recipientId: string;
  } | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);
  const recordingGenRef = useRef(0);
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(sessionId);
  const recipientIdRef = useRef(recipientId);
  const canSendRef = useRef(canSend);
  const onSendRef = useRef(onSendMediaMessage);
  const onErrorRef = useRef(onError);
  const onConsentChangedRef = useRef(onConsentChanged);

  sessionIdRef.current = sessionId;
  recipientIdRef.current = recipientId;
  canSendRef.current = canSend;
  onSendRef.current = onSendMediaMessage;
  onErrorRef.current = onError;
  onConsentChangedRef.current = onConsentChanged;

  const isContextCurrent = useCallback((expectedSessionId: string, expectedRecipientId: string) => {
    return (
      mountedRef.current &&
      canSendRef.current &&
      sessionIdRef.current === expectedSessionId &&
      recipientIdRef.current === expectedRecipientId
    );
  }, []);

  const previewRegistry = useMediaPreviewRegistry({
    sessionId,
    onError,
    onRevoked,
  });

  const cancelActiveRecorder = useCallback(() => {
    recordingGenRef.current += 1;
    const recorder = audioRecorderRef.current;
    audioRecorderRef.current = null;
    if (mountedRef.current) setIsRecording(false);
    if (recorder) {
      void recorder.cancel();
    }
  }, []);

  // Reset consent UI, adult modals, recorder, and load current consent state when sessionId changes
  useEffect(() => {
    cancelActiveRecorder();
    setMediaConsent(false);
    setPartnerMediaConsent(false);
    setMyAdultConsent(false);
    setPartnerAdultConsent(false);
    setSendAsAdult(false);
    setShowAdultConsentModal(false);
    setAdultPolicyAck(false);
    setShowSenderAdultModal(false);
    setSenderConfirm18Plus(false);
    setSenderConfirmConsent(false);
    setPendingMedia(null);

    if (!sessionId) return;

    let isCurrent = true;
    void apiFetch(`/api/v1/media/consent/${encodeURIComponent(sessionId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          state: {
            myMediaConsent?: boolean;
            partnerMediaConsent?: boolean;
            myAdultConsent?: boolean;
            partnerAdultConsent?: boolean;
          } | null
        ) => {
          if (!isCurrent || !state || sessionIdRef.current !== sessionId) return;
          setMediaConsent(Boolean(state.myMediaConsent));
          setPartnerMediaConsent(Boolean(state.partnerMediaConsent));
          setMyAdultConsent(Boolean(state.myAdultConsent));
          setPartnerAdultConsent(Boolean(state.partnerAdultConsent));
        }
      )
      .catch(() => undefined);

    return () => {
      isCurrent = false;
    };
  }, [sessionId, cancelActiveRecorder]);

  // Cancel active audio recording whenever sending becomes disallowed
  useEffect(() => {
    if (!canSend) {
      cancelActiveRecorder();
    }
  }, [canSend, cancelActiveRecorder]);

  // Ensure AudioRecorder stream/microphone tracks release on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recordingGenRef.current += 1;
      const recorder = audioRecorderRef.current;
      audioRecorderRef.current = null;
      if (recorder) void recorder.cancel();
    };
  }, []);

  const handleConsentToggle = useCallback(async () => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) return;
    setUploadBusy(true);
    onErrorRef.current(null);
    try {
      const enabled = !mediaConsent;
      const response = await apiFetch('/api/v1/media/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId, enabled }),
      });
      if (!response.ok) {
        throw new Error(await readConsentError(response, 'Không thể cập nhật quyền nhận media.'));
      }
      if (sessionIdRef.current === activeSessionId) {
        setMediaConsent(enabled);
        onConsentChangedRef.current?.('MEDIA', enabled);
      }
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : 'Không thể cập nhật quyền nhận media.');
    } finally {
      if (mountedRef.current) setUploadBusy(false);
    }
  }, [mediaConsent]);

  const submitAdultConsent = useCallback(async (enabled: boolean, policyAcknowledged: boolean) => {
    const activeSessionId = sessionIdRef.current;
    if (!activeSessionId) return;
    setUploadBusy(true);
    onErrorRef.current(null);
    try {
      const response = await apiFetch('/api/v1/media/adult-consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId, enabled, policyAcknowledged }),
      });
      if (!response.ok) {
        throw new Error(await readConsentError(response, 'Không thể cập nhật quyền nhận nội dung 18+.'));
      }
      if (sessionIdRef.current === activeSessionId) {
        setMyAdultConsent(enabled);
        setShowAdultConsentModal(false);
        setAdultPolicyAck(false);
        onConsentChangedRef.current?.('ADULT', enabled);
      }
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : 'Không thể cập nhật quyền nhận nội dung 18+.');
    } finally {
      if (mountedRef.current) setUploadBusy(false);
    }
  }, []);

  const handleAdultConsentToggle = useCallback(() => {
    if (!sessionIdRef.current || uploadBusy || previewRegistry.previewBusy) return;
    if (myAdultConsent) {
      void submitAdultConsent(false, false);
    } else {
      setAdultPolicyAck(false);
      setShowAdultConsentModal(true);
    }
  }, [myAdultConsent, uploadBusy, previewRegistry.previewBusy, submitAdultConsent]);

  const uploadAndEmitMedia = useCallback(async (
    expectedSessionId: string,
    expectedRecipientId: string,
    file: File,
    mediaType: ClientMediaType,
    additionalMeta: Pick<UploadedSessionMedia, 'waveform' | 'durationSec' | 'width' | 'height'> = {},
    adultFlags: { isAdult?: boolean; senderConfirmed18Plus?: boolean; senderConfirmedConsent?: boolean } = {}
  ) => {
    if (!isContextCurrent(expectedSessionId, expectedRecipientId)) {
      return;
    }

    const uploaded = await uploadAndFinalizeEncryptedMedia({
      sessionId: expectedSessionId,
      recipientId: expectedRecipientId,
      file,
      mediaType,
      isAdult: adultFlags.isAdult,
      senderConfirmed18Plus: adultFlags.senderConfirmed18Plus,
      senderConfirmedConsent: adultFlags.senderConfirmedConsent,
    });

    if (!isContextCurrent(expectedSessionId, expectedRecipientId)) {
      return;
    }

    const media: UploadedSessionMedia = {
      mediaId: uploaded.mediaId,
      contentType: uploaded.verifiedMime || uploaded.contentType,
      mediaType,
      ...(adultFlags.isAdult ? { isAdult: true } : {}),
      ...additionalMeta,
    };

    await onSendRef.current({ media, isAdult: Boolean(adultFlags.isAdult) });
  }, [isContextCurrent]);

  const compressAndSendMedia = useCallback(async (
    capturedSessionId: string,
    capturedRecipientId: string,
    file: File,
    mediaType: ClientMediaType,
    adultFlags: { isAdult?: boolean; senderConfirmed18Plus?: boolean; senderConfirmedConsent?: boolean } = {},
    defaultError = 'Không thể gửi media.'
  ) => {
    if (!isContextCurrent(capturedSessionId, capturedRecipientId)) return;
    setUploadBusy(true);
    onErrorRef.current(null);
    try {
      await compressAndUploadWithContextGuard<File, { width: number; height: number }>({
        isContextCurrent: () => isContextCurrent(capturedSessionId, capturedRecipientId),
        isImage: mediaType === 'IMAGE',
        rawFile: file,
        compressImage: async (raw) => {
          const compressed = await ImageCompressor.compress(raw);
          return {
            file: compressed.file,
            meta: { width: compressed.width, height: compressed.height },
          };
        },
        uploadAndSend: async (targetFile, meta) => {
          await uploadAndEmitMedia(
            capturedSessionId,
            capturedRecipientId,
            targetFile,
            mediaType,
            meta ?? {},
            adultFlags
          );
        },
      });
    } catch (error) {
      if (isContextCurrent(capturedSessionId, capturedRecipientId)) {
        onErrorRef.current(error instanceof Error ? error.message : defaultError);
      }
    } finally {
      if (mountedRef.current) setUploadBusy(false);
    }
  }, [isContextCurrent, uploadAndEmitMedia]);

  const handleFileSelected = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const capturedSessionId = sessionIdRef.current;
    const capturedRecipientId = recipientIdRef.current;
    if (!file || !capturedSessionId || !capturedRecipientId || !canSendRef.current) return;

    const mediaType: ClientMediaType | null = file.type.startsWith('image/')
      ? 'IMAGE'
      : file.type.startsWith('audio/')
      ? 'AUDIO'
      : file.type.startsWith('video/')
      ? 'VIDEO'
      : null;

    if (!mediaType) {
      onErrorRef.current('Chỉ hỗ trợ ảnh, audio hoặc video.');
      return;
    }

    const maxBytes = mediaType === 'IMAGE' ? 30_000_000 : mediaType === 'VIDEO' ? 100_000_000 : 20_000_000;
    if (file.size >= maxBytes) {
      onErrorRef.current(fileTooLargeMessage(mediaType));
      return;
    }

    if (sendAsAdult && (mediaType === 'IMAGE' || mediaType === 'VIDEO')) {
      if (!partnerAdultConsent) {
        onErrorRef.current(partnerNotAdultConsentMessage);
        return;
      }
      setPendingMedia({
        file,
        mediaType,
        sessionId: capturedSessionId,
        recipientId: capturedRecipientId,
      });
      setSenderConfirm18Plus(false);
      setSenderConfirmConsent(false);
      setShowSenderAdultModal(true);
      return;
    }

    await compressAndSendMedia(capturedSessionId, capturedRecipientId, file, mediaType);
  }, [compressAndSendMedia, fileTooLargeMessage, partnerAdultConsent, partnerNotAdultConsentMessage, sendAsAdult]);

  const confirmSenderAdultUpload = useCallback(async () => {
    if (!pendingMedia || !senderConfirm18Plus || !senderConfirmConsent) return;
    const { file, mediaType, sessionId: capturedSessionId, recipientId: capturedRecipientId } = pendingMedia;
    setShowSenderAdultModal(false);
    setPendingMedia(null);
    await compressAndSendMedia(
      capturedSessionId,
      capturedRecipientId,
      file,
      mediaType,
      { isAdult: true, senderConfirmed18Plus: true, senderConfirmedConsent: true },
      'Không gửi được nội dung 18+.'
    );
  }, [compressAndSendMedia, pendingMedia, senderConfirm18Plus, senderConfirmConsent]);

  const cancelSenderAdultModal = useCallback(() => {
    setShowSenderAdultModal(false);
    setPendingMedia(null);
  }, []);

  const handleToggleRecording = useCallback(async () => {
    const busy = uploadBusy || previewRegistry.previewBusy;
    const capturedSessionId = sessionIdRef.current;
    const capturedRecipientId = recipientIdRef.current;
    if (!capturedSessionId || !capturedRecipientId || !canSendRef.current || busy) return;

    if (!isRecording) {
      const startGeneration = recordingGenRef.current;
      const recorder = new AudioRecorder();
      audioRecorderRef.current = recorder;
      try {
        await recorder.start();
        if (
          recorder.isCancelled() ||
          recordingGenRef.current !== startGeneration ||
          !isContextCurrent(capturedSessionId, capturedRecipientId)
        ) {
          if (audioRecorderRef.current === recorder) {
            audioRecorderRef.current = null;
          }
          await recorder.cancel();
          return;
        }
        onErrorRef.current(null);
        setIsRecording(true);
      } catch (error) {
        if (audioRecorderRef.current === recorder) {
          audioRecorderRef.current = null;
        }
        const stillSameAttempt =
          !recorder.isCancelled() &&
          recordingGenRef.current === startGeneration &&
          mountedRef.current;
        if (stillSameAttempt) {
          onErrorRef.current(error instanceof Error ? error.message : 'Không thể bắt đầu ghi âm.');
        }
        await recorder.cancel();
      }
      return;
    }

    const recorder = audioRecorderRef.current;
    if (!recorder) {
      setIsRecording(false);
      return;
    }

    const startGeneration = recordingGenRef.current;
    setUploadBusy(true);
    try {
      const recording = await recorder.stop();
      if (audioRecorderRef.current === recorder) {
        audioRecorderRef.current = null;
      }
      setIsRecording(false);
      if (
        recorder.isCancelled() ||
        recordingGenRef.current !== startGeneration ||
        !isContextCurrent(capturedSessionId, capturedRecipientId)
      ) {
        return;
      }
      const extension = recording.blob.type.includes('mp4') ? 'm4a' : 'webm';
      const file = new File(
        [recording.blob],
        `${voiceFilenamePrefix}-${Date.now()}.${extension}`,
        { type: recording.blob.type }
      );
      await uploadAndEmitMedia(capturedSessionId, capturedRecipientId, file, 'AUDIO', {
        durationSec: recording.durationSeconds,
        waveform: recording.waveform,
      });
    } catch (error) {
      if (audioRecorderRef.current === recorder) {
        audioRecorderRef.current = null;
      }
      if (mountedRef.current) setIsRecording(false);
      await recorder.cancel();
      if (isContextCurrent(capturedSessionId, capturedRecipientId)) {
        onErrorRef.current(error instanceof Error ? error.message : 'Không thể gửi bản ghi âm.');
      }
    } finally {
      if (mountedRef.current) setUploadBusy(false);
    }
  }, [isContextCurrent, isRecording, previewRegistry.previewBusy, uploadAndEmitMedia, uploadBusy, voiceFilenamePrefix]);

  return {
    mediaBusy: uploadBusy || previewRegistry.previewBusy,
    isRecording,
    mediaInputRef,
    mediaConsent,
    partnerMediaConsent,
    setPartnerMediaConsent,
    myAdultConsent,
    setMyAdultConsent,
    partnerAdultConsent,
    setPartnerAdultConsent,
    showAdultConsentModal,
    setShowAdultConsentModal,
    adultPolicyAck,
    setAdultPolicyAck,
    sendAsAdult,
    setSendAsAdult,
    showSenderAdultModal,
    senderConfirm18Plus,
    setSenderConfirm18Plus,
    senderConfirmConsent,
    setSenderConfirmConsent,
    cancelSenderAdultModal,
    confirmSenderAdultUpload,
    handleConsentToggle,
    submitAdultConsent,
    handleAdultConsentToggle,
    handleFileSelected,
    handleToggleRecording,
    mediaViews: previewRegistry.mediaViews,
    openMediaPreview: previewRegistry.openMediaPreview,
    revokeMediaPreview: previewRegistry.revokeMediaPreview,
    markMediaRevoked: previewRegistry.markMediaRevoked,
    clearAllMediaPreviews: previewRegistry.clearAllMediaPreviews,
  };
}

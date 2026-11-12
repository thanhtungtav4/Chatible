import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io } from 'socket.io-client';
import { SocketEvents, type MessageType } from '@chatible/shared';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  Eye,
  Flame,
  ImagePlus,
  MessageCircle,
  Mic,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  UserRound,
  Users,
  UserX,
  X,
} from 'lucide-react';
import { API_BASE_URL, apiFetch } from '../../api.js';
import { AudioRecorder } from '../media/audio-recorder.js';
import { ImageCompressor } from '../media/image-compressor.js';
import {
  fetchDecryptedMediaView,
  revokeMediaAsset,
  uploadAndFinalizeEncryptedMedia,
} from '../media/encryptedMediaClient.js';

type Friend = {
  id: string;
  userId: string;
  nickname: string;
  gender: string;
  age: number;
  isOnline: boolean;
  establishedAt: string;
};

type IncomingFriendRequest = {
  requestId: string;
  fromUserId: string;
  nickname: string;
  gender: string;
  age: number;
  sentAt: string;
};

type FriendMediaMeta = {
  mediaId: string;
  contentType: string;
  mediaType: 'IMAGE' | 'AUDIO' | 'VIDEO';
  waveform?: number[];
  durationSec?: number;
  width?: number;
  height?: number;
  isAdult?: boolean;
};

type FriendMediaViewState = {
  previewUrl?: string;
  watermarkText?: string;
  watermarkedMode?: 'embedded' | 'overlay';
  revoked?: boolean;
};

type FriendMessage = {
  id: string;
  sessionId?: string;
  senderId: string;
  receiverId: string;
  messageType?: MessageType;
  content: string;
  metadata?: unknown;
  isAdultContent?: boolean;
  sentAt: string;
  expiresAt: string;
};

type FriendsViewProps = {
  currentUserId: string;
};

function parseFriendMedia(message: FriendMessage): FriendMediaMeta | undefined {
  const mType = message.messageType;
  if (mType !== 'IMAGE' && mType !== 'AUDIO' && mType !== 'VIDEO') return undefined;
  try {
    const parsed: unknown = JSON.parse(message.content);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.mediaId !== 'string' ||
      !value.mediaId ||
      typeof value.contentType !== 'string' ||
      !/^(image|audio|video)\/[a-z0-9.+-]+$/i.test(value.contentType)
    ) {
      return undefined;
    }
    const waveform =
      Array.isArray(value.waveform) &&
      value.waveform.length === 30 &&
      value.waveform.every((s) => typeof s === 'number' && Number.isFinite(s) && s >= 0 && s <= 1)
        ? (value.waveform as number[])
        : undefined;
    const durationSec =
      typeof value.durationSec === 'number' && Number.isFinite(value.durationSec) && value.durationSec >= 0
        ? value.durationSec
        : undefined;
    const width = Number.isSafeInteger(value.width) && (value.width as number) > 0 ? (value.width as number) : undefined;
    const height = Number.isSafeInteger(value.height) && (value.height as number) > 0 ? (value.height as number) : undefined;
    return {
      mediaId: value.mediaId,
      contentType: value.contentType,
      mediaType: mType,
      isAdult: Boolean(message.isAdultContent || value.isAdult === true),
      ...(waveform ? { waveform } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    };
  } catch {
    return undefined;
  }
}

async function readApi<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || 'Không thể tải dữ liệu.');
  return payload;
}

function initials(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

export function FriendsView({ currentUserId }: FriendsViewProps) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<IncomingFriendRequest[]>([]);
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null);
  const [messages, setMessages] = useState<FriendMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [confirmAction, setConfirmAction] = useState<{
    type: 'unfriend' | 'block';
    friendId: string;
    friendName: string;
  } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const [isFriendsLoading, setIsFriendsLoading] = useState(true);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [acceptingRequestId, setAcceptingRequestId] = useState<string | null>(null);
  const [decliningRequestId, setDecliningRequestId] = useState<string | null>(null);
  const [isActionBusy, setIsActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
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
  const [pendingMediaFile, setPendingMediaFile] = useState<File | null>(null);
  const [pendingMediaType, setPendingMediaType] = useState<'IMAGE' | 'VIDEO' | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [mediaViews, setMediaViews] = useState<Record<string, FriendMediaViewState>>({});
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);
  const previewUrlsRef = useRef(new Map<string, string>());
  const previewTimeoutsRef = useRef(new Map<string, number>());
  const selectedFriendIdRef = useRef<string | null>(null);
  const messagesRef = useRef<FriendMessage[]>([]);

  selectedFriendIdRef.current = selectedFriendId;
  messagesRef.current = messages;

  const clearMediaPreview = useCallback((messageId: string) => {
    const timeoutId = previewTimeoutsRef.current.get(messageId);
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    previewTimeoutsRef.current.delete(messageId);
    const url = previewUrlsRef.current.get(messageId);
    if (url) URL.revokeObjectURL(url);
    previewUrlsRef.current.delete(messageId);
  }, []);

  const clearAllMediaPreviews = useCallback(() => {
    for (const key of Array.from(previewUrlsRef.current.keys())) {
      clearMediaPreview(key);
    }
    setMediaViews({});
  }, [clearMediaPreview]);

  const selectedFriend = useMemo(
    () => friends.find((friend) => friend.userId === selectedFriendId) || null,
    [friends, selectedFriendId]
  );

  const filteredFriends = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return friends;
    return friends.filter((f) => f.nickname.toLowerCase().includes(q));
  }, [friends, searchQuery]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadFriends = useCallback(async () => {
    setIsFriendsLoading(true);
    setError(null);
    try {
      const [friendsResponse, requestsResponse] = await Promise.all([
        apiFetch('/api/v1/friends'),
        apiFetch('/api/v1/friends/requests'),
      ]);
      const [friendData, requestData] = await Promise.all([
        readApi<{ friends?: Friend[] }>(friendsResponse),
        readApi<{ requests?: IncomingFriendRequest[] }>(requestsResponse),
      ]);
      const nextFriends = Array.isArray(friendData.friends) ? friendData.friends : [];
      setFriends(nextFriends);
      setIncomingRequests(Array.isArray(requestData.requests) ? requestData.requests : []);
      setSelectedFriendId((current) => {
        if (current && nextFriends.some((friend) => friend.userId === current)) return current;
        return null;
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể tải danh sách bạn bè.');
    } finally {
      setIsFriendsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFriends();
  }, [loadFriends]);

  useEffect(() => {
    const socket = io(API_BASE_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });
    socket.on(SocketEvents.FRIEND_MESSAGE_RECEIVE, (incoming: FriendMessage) => {
      const activeFriend = selectedFriendIdRef.current;
      if (!activeFriend) return;
      if (incoming.senderId !== activeFriend && incoming.receiverId !== activeFriend) return;
      setMessages((current) => (current.some((m) => m.id === incoming.id) ? current : [...current, incoming]));
    });
    socket.on(SocketEvents.MEDIA_REVOKED, (payload: { mediaId?: string }) => {
      if (!payload?.mediaId) return;
      const matchingIds = messagesRef.current
        .filter((msg) => parseFriendMedia(msg)?.mediaId === payload.mediaId)
        .map((msg) => msg.id);
      if (matchingIds.length === 0) return;
      for (const msgId of matchingIds) clearMediaPreview(msgId);
      setMediaViews((prev) => {
        const next = { ...prev };
        for (const msgId of matchingIds) {
          next[msgId] = { ...(prev[msgId] || {}), revoked: true, previewUrl: undefined };
        }
        return next;
      });
    });
    return () => {
      socket.disconnect();
      void audioRecorderRef.current?.cancel();
      audioRecorderRef.current = null;
      clearAllMediaPreviews();
    };
  }, [clearAllMediaPreviews, clearMediaPreview]);

  useEffect(() => {
    if (!selectedFriendId) {
      setMessages([]);
      setActiveSessionId(null);
      setMediaConsent(false);
      setPartnerMediaConsent(false);
      setMyAdultConsent(false);
      setPartnerAdultConsent(false);
      setSendAsAdult(false);
      clearAllMediaPreviews();
      return;
    }
    let isCurrent = true;
    setIsMessagesLoading(true);
    setMessageError(null);
    setMessages([]);
    clearAllMediaPreviews();

    void Promise.all([
      apiFetch(`/api/v1/friends/${encodeURIComponent(selectedFriendId)}/session`).then((r) =>
        readApi<{ sessionId: string; myAdultConsent: boolean; partnerAdultConsent: boolean }>(r)
      ),
      apiFetch(`/api/v1/friends/${encodeURIComponent(selectedFriendId)}/messages`).then((r) =>
        readApi<{ messages?: FriendMessage[] }>(r)
      ),
    ])
      .then(async ([sessionInfo, data]) => {
        if (!isCurrent) return;
        setActiveSessionId(sessionInfo.sessionId);
        setMyAdultConsent(sessionInfo.myAdultConsent);
        setPartnerAdultConsent(sessionInfo.partnerAdultConsent);
        setMessages(Array.isArray(data.messages) ? data.messages : []);

        const consentRes = await apiFetch(
          `/api/v1/media/consent/${encodeURIComponent(sessionInfo.sessionId)}`
        ).catch(() => null);
        if (consentRes && consentRes.ok && isCurrent) {
          const state = (await consentRes.json()) as {
            myMediaConsent?: boolean;
            partnerMediaConsent?: boolean;
            myAdultConsent?: boolean;
            partnerAdultConsent?: boolean;
          };
          setMediaConsent(Boolean(state.myMediaConsent));
          setPartnerMediaConsent(Boolean(state.partnerMediaConsent));
          setMyAdultConsent(Boolean(state.myAdultConsent));
          setPartnerAdultConsent(Boolean(state.partnerAdultConsent));
        }
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setMessageError(requestError instanceof Error ? requestError.message : 'Không thể tải cuộc trò chuyện.');
      })
      .finally(() => {
        if (isCurrent) setIsMessagesLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [clearAllMediaPreviews, selectedFriendId]);

  const handleAcceptRequest = async (requestId: string) => {
    if (acceptingRequestId) return;
    setAcceptingRequestId(requestId);
    setError(null);
    try {
      const response = await apiFetch('/api/v1/friends/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      });
      await readApi<{ status: string }>(response);
      setIncomingRequests((current) => current.filter((request) => request.requestId !== requestId));
      await loadFriends();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể chấp nhận lời mời.');
    } finally {
      setAcceptingRequestId(null);
    }
  };

  const handleDeclineRequest = async (requestId: string) => {
    if (decliningRequestId) return;
    setDecliningRequestId(requestId);
    setError(null);
    try {
      const response = await apiFetch('/api/v1/friends/decline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      });
      await readApi<{ status: string }>(response);
      setIncomingRequests((current) => current.filter((request) => request.requestId !== requestId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể từ chối lời mời.');
    } finally {
      setDecliningRequestId(null);
    }
  };

  const handlePromptUnfriend = (friendId: string, friendName: string) => {
    setConfirmAction({ type: 'unfriend', friendId, friendName });
  };

  const handlePromptBlock = (friendId: string, friendName: string) => {
    setConfirmAction({ type: 'block', friendId, friendName });
  };

  const handleExecuteConfirmAction = async () => {
    if (!confirmAction) return;
    setIsActionBusy(true);
    setError(null);
    try {
      if (confirmAction.type === 'unfriend') {
        const response = await apiFetch(`/api/v1/friends/${encodeURIComponent(confirmAction.friendId)}`, {
          method: 'DELETE',
        });
        await readApi<{ status: string }>(response);
        setToastMsg(`Đã hủy kết bạn với ${confirmAction.friendName}.`);
      } else {
        const response = await apiFetch('/api/v1/blocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUserId: confirmAction.friendId }),
        });
        await readApi<{ status: string }>(response);
        setToastMsg(`Đã chặn ${confirmAction.friendName}.`);
      }
      setSelectedFriendId(null);
      await loadFriends();
      setTimeout(() => setToastMsg(null), 3000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Thao tác thất bại.');
    } finally {
      setIsActionBusy(false);
      setConfirmAction(null);
    }
  };
  const handleToggleMediaConsent = async () => {
    if (!activeSessionId || mediaBusy) return;
    setMediaBusy(true);
    setMessageError(null);
    try {
      const enabled = !mediaConsent;
      const response = await apiFetch('/api/v1/media/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId, enabled }),
      });
      await readApi<{ success?: boolean }>(response);
      setMediaConsent(enabled);
    } catch (err) {
      setMessageError(err instanceof Error ? err.message : 'Không thể cập nhật quyền nhận media.');
    } finally {
      setMediaBusy(false);
    }
  };

  const submitAdultConsent = async (enabled: boolean, policyAcknowledged: boolean) => {
    if (!activeSessionId) return;
    setMediaBusy(true);
    setMessageError(null);
    try {
      const response = await apiFetch('/api/v1/media/adult-consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId, enabled, policyAcknowledged }),
      });
      await readApi<{ success?: boolean }>(response);
      setMyAdultConsent(enabled);
      setShowAdultConsentModal(false);
      setAdultPolicyAck(false);
    } catch (err) {
      setMessageError(err instanceof Error ? err.message : 'Không thể cập nhật quyền nhận nội dung 18+.');
    } finally {
      setMediaBusy(false);
    }
  };

  const handleAdultConsentToggle = () => {
    if (!activeSessionId || mediaBusy) return;
    if (myAdultConsent) {
      void submitAdultConsent(false, false);
    } else {
      setAdultPolicyAck(false);
      setShowAdultConsentModal(true);
    }
  };

  const uploadAndSendFriendMedia = async (
    file: File,
    mediaType: 'IMAGE' | 'AUDIO' | 'VIDEO',
    additionalMeta: Pick<FriendMediaMeta, 'waveform' | 'durationSec' | 'width' | 'height'> = {},
    adultFlags: { isAdult?: boolean; senderConfirmed18Plus?: boolean; senderConfirmedConsent?: boolean } = {}
  ) => {
    if (!selectedFriendId || !activeSessionId) {
      throw new Error('Phiên trò chuyện bạn bè chưa sẵn sàng.');
    }
    const uploaded = await uploadAndFinalizeEncryptedMedia({
      sessionId: activeSessionId,
      recipientId: selectedFriendId,
      file,
      mediaType,
      isAdult: adultFlags.isAdult,
      senderConfirmed18Plus: adultFlags.senderConfirmed18Plus,
      senderConfirmedConsent: adultFlags.senderConfirmedConsent,
    });
    const mediaPayload: FriendMediaMeta = {
      mediaId: uploaded.mediaId,
      contentType: uploaded.verifiedMime || uploaded.contentType,
      mediaType,
      ...(adultFlags.isAdult ? { isAdult: true } : {}),
      ...additionalMeta,
    };
    const response = await apiFetch(`/api/v1/friends/${encodeURIComponent(selectedFriendId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: mediaType,
        content: JSON.stringify(mediaPayload),
        mediaId: uploaded.mediaId,
        isAdultContent: Boolean(adultFlags.isAdult),
        metadata: mediaPayload,
        clientMessageId: crypto.randomUUID(),
      }),
    });
    const message = await readApi<FriendMessage>(response);
    setMessages((current) => (current.some((m) => m.id === message.id) ? current : [...current, message]));
  };

  const handleFriendFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !selectedFriendId || !activeSessionId) return;
    const mediaType = file.type.startsWith('image/')
      ? 'IMAGE'
      : file.type.startsWith('audio/')
      ? 'AUDIO'
      : file.type.startsWith('video/')
      ? 'VIDEO'
      : null;
    if (!mediaType) {
      setMessageError('Chỉ hỗ trợ ảnh, audio hoặc video.');
      return;
    }
    const maxBytes = mediaType === 'IMAGE' ? 30_000_000 : mediaType === 'VIDEO' ? 100_000_000 : 20_000_000;
    if (file.size >= maxBytes) {
      setMessageError('Dung lượng tệp vượt quá giới hạn cho phép.');
      return;
    }
    if (sendAsAdult && (mediaType === 'IMAGE' || mediaType === 'VIDEO')) {
      if (!partnerAdultConsent) {
        setMessageError('Bạn bè chưa bật quyền "Nhận nội dung 18+" trong luồng chat này.');
        return;
      }
      setPendingMediaFile(file);
      setPendingMediaType(mediaType);
      setSenderConfirm18Plus(false);
      setSenderConfirmConsent(false);
      setShowSenderAdultModal(true);
      return;
    }
    setMediaBusy(true);
    setMessageError(null);
    try {
      if (mediaType === 'IMAGE') {
        const compressed = await ImageCompressor.compress(file);
        await uploadAndSendFriendMedia(compressed.file, mediaType, {
          width: compressed.width,
          height: compressed.height,
        });
      } else {
        await uploadAndSendFriendMedia(file, mediaType);
      }
    } catch (err) {
      setMessageError(err instanceof Error ? err.message : 'Không thể gửi media.');
    } finally {
      setMediaBusy(false);
    }
  };

  const confirmFriendAdultUpload = async () => {
    if (!pendingMediaFile || !pendingMediaType || !senderConfirm18Plus || !senderConfirmConsent) return;
    const file = pendingMediaFile;
    const mediaType = pendingMediaType;
    setShowSenderAdultModal(false);
    setPendingMediaFile(null);
    setPendingMediaType(null);
    setMediaBusy(true);
    setMessageError(null);
    try {
      const adultFlags = { isAdult: true, senderConfirmed18Plus: true, senderConfirmedConsent: true };
      if (mediaType === 'IMAGE') {
        const compressed = await ImageCompressor.compress(file);
        await uploadAndSendFriendMedia(
          compressed.file,
          mediaType,
          { width: compressed.width, height: compressed.height },
          adultFlags
        );
      } else {
        await uploadAndSendFriendMedia(file, mediaType, {}, adultFlags);
      }
    } catch (err) {
      setMessageError(err instanceof Error ? err.message : 'Không gửi được nội dung 18+.');
    } finally {
      setMediaBusy(false);
    }
  };

  const handleToggleFriendRecording = async () => {
    if (!selectedFriendId || !activeSessionId || mediaBusy) return;
    if (!isRecording) {
      const recorder = new AudioRecorder();
      try {
        await recorder.start();
        audioRecorderRef.current = recorder;
        setMessageError(null);
        setIsRecording(true);
      } catch (err) {
        setMessageError(err instanceof Error ? err.message : 'Không thể bắt đầu ghi âm.');
        await recorder.cancel();
      }
      return;
    }
    const recorder = audioRecorderRef.current;
    if (!recorder) {
      setIsRecording(false);
      return;
    }
    setMediaBusy(true);
    try {
      const recording = await recorder.stop();
      audioRecorderRef.current = null;
      setIsRecording(false);
      const ext = recording.blob.type.includes('mp4') ? 'm4a' : 'webm';
      const file = new File([recording.blob], `friend-voice-${Date.now()}.${ext}`, { type: recording.blob.type });
      await uploadAndSendFriendMedia(file, 'AUDIO', {
        durationSec: recording.durationSeconds,
        waveform: recording.waveform,
      });
    } catch (err) {
      audioRecorderRef.current = null;
      setIsRecording(false);
      await recorder.cancel();
      setMessageError(err instanceof Error ? err.message : 'Không gửi được ghi âm.');
    } finally {
      setMediaBusy(false);
    }
  };

  const handleViewFriendMedia = async (message: FriendMessage, media: FriendMediaMeta) => {
    setMediaBusy(true);
    setMessageError(null);
    try {
      const view = await fetchDecryptedMediaView(media.mediaId, media.contentType);
      clearMediaPreview(message.id);
      previewUrlsRef.current.set(message.id, view.previewUrl);
      previewTimeoutsRef.current.set(
        message.id,
        window.setTimeout(() => {
          URL.revokeObjectURL(view.previewUrl);
          previewUrlsRef.current.delete(message.id);
          previewTimeoutsRef.current.delete(message.id);
          setMediaViews((prev) => ({
            ...prev,
            [message.id]: { ...(prev[message.id] || {}), previewUrl: undefined },
          }));
        }, (view.expiresIn || 300) * 1000)
      );
      setMediaViews((prev) => ({
        ...prev,
        [message.id]: {
          previewUrl: view.previewUrl,
          watermarkText: view.watermarkText,
          watermarkedMode: view.watermarkedMode,
        },
      }));
    } catch (err) {
      setMessageError(err instanceof Error ? err.message : 'Không thể mở media.');
    } finally {
      setMediaBusy(false);
    }
  };

  const handleRevokeFriendMedia = async (message: FriendMessage, media: FriendMediaMeta) => {
    clearMediaPreview(message.id);
    setMediaViews((prev) => ({
      ...prev,
      [message.id]: { ...(prev[message.id] || {}), previewUrl: undefined },
    }));
    try {
      await revokeMediaAsset(media.mediaId);
      setMediaViews((prev) => ({
        ...prev,
        [message.id]: { ...(prev[message.id] || {}), revoked: true, previewUrl: undefined },
      }));
    } catch (err) {
      setMessageError(err instanceof Error ? err.message : 'Không thể thu hồi media.');
    }
  };

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !selectedFriendId || isSending) return;
    setIsSending(true);
    setMessageError(null);
    try {
      const response = await apiFetch(`/api/v1/friends/${encodeURIComponent(selectedFriendId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, clientMessageId: crypto.randomUUID() }),
      });
      const message = await readApi<FriendMessage>(response);
      setMessages((current) => (current.some((m) => m.id === message.id) ? current : [...current, message]));
      setDraft('');
    } catch (requestError) {
      setMessageError(requestError instanceof Error ? requestError.message : 'Không thể gửi tin nhắn.');
    } finally {
      setIsSending(false);
    }
  };

  if (selectedFriend) {
    return (
      <section className="flex h-full min-h-[31rem] flex-col" aria-labelledby="friend-chat-title">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSelectedFriendId(null)}
              className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
              aria-label="Quay lại danh sách bạn bè"
            >
              <ArrowLeft size={18} />
            </button>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 font-bold text-blue-700">
              {initials(selectedFriend.nickname)}
            </div>
            <div className="min-w-0">
              <h1 id="friend-chat-title" className="truncate text-base font-bold text-slate-900">{selectedFriend.nickname}</h1>
              <p className="text-xs text-slate-500">{selectedFriend.age} tuổi · {selectedFriend.isOnline ? 'Đang hoạt động' : 'Ngoại tuyến'}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void handleToggleMediaConsent()}
              disabled={mediaBusy || !activeSessionId}
              aria-pressed={mediaConsent}
              className={`relative rounded-lg p-2 transition ${
                mediaConsent ? 'bg-emerald-100 text-emerald-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
              } disabled:opacity-50`}
              title={mediaConsent ? 'Đang bật nhận ảnh/video' : 'Bật/tắt quyền nhận media'}
              aria-label="Quyền nhận media"
            >
              <ShieldCheck size={17} />
            </button>
            <button
              type="button"
              onClick={handleAdultConsentToggle}
              disabled={mediaBusy || !activeSessionId}
              aria-pressed={myAdultConsent}
              className={`relative rounded-lg p-2 transition ${
                myAdultConsent ? 'bg-rose-100 text-rose-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
              } disabled:opacity-50`}
              title={myAdultConsent ? 'Đang bật nhận nội dung 18+' : 'Bật/tắt nhận nội dung 18+'}
              aria-label="Quyền nhận nội dung 18+"
            >
              <Flame size={17} />
            </button>
            <button
              type="button"
              onClick={() => handlePromptUnfriend(selectedFriend.userId, selectedFriend.nickname)}
              disabled={isActionBusy}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
              title="Hủy kết bạn"
              aria-label="Hủy kết bạn"
            >
              <UserX size={17} />
            </button>
            <button
              type="button"
              onClick={() => handlePromptBlock(selectedFriend.userId, selectedFriend.nickname)}
              disabled={isActionBusy}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
              title="Chặn tài khoản"
              aria-label="Chặn tài khoản"
            >
              <Ban size={17} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto py-4" aria-live="polite">
          {isMessagesLoading && <p className="py-8 text-center text-sm text-slate-500">Đang tải tin nhắn…</p>}
          {!isMessagesLoading && messageError && (
            <div className="rounded-2xl border border-rose-100 bg-rose-50 p-3 text-sm text-rose-700" role="alert">
              <p>{messageError}</p>
              <button type="button" onClick={() => setSelectedFriendId(null)} className="mt-2 font-semibold underline">Chọn lại bạn</button>
            </div>
          )}
          {!isMessagesLoading && !messageError && messages.length === 0 && (
            <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center">
              <MessageCircle className="text-blue-500" size={28} />
              <p className="mt-2 text-sm font-semibold text-slate-700">Chưa có tin nhắn</p>
              <p className="mt-1 text-xs text-slate-500">Gửi lời chào đầu tiên. Tin nhắn được lưu trong 30 ngày.</p>
            </div>
          )}
          {!isMessagesLoading && !messageError && messages.map((message) => {
            const isMine = message.senderId === currentUserId;
            const media = parseFriendMedia(message);
            const viewState = mediaViews[message.id];
            return (
              <div key={message.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm ${isMine ? 'rounded-br-md bg-blue-600 text-white' : 'rounded-bl-md bg-slate-100 text-slate-800'}`}>
                  {media ? (
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold">
                          {media.mediaType === 'IMAGE'
                            ? isMine ? 'Ảnh đã gửi' : 'Ảnh đã nhận'
                            : media.mediaType === 'AUDIO'
                            ? isMine ? 'Audio đã gửi' : 'Audio đã nhận'
                            : isMine ? 'Video đã gửi' : 'Video đã nhận'}
                        </span>
                        {media.isAdult && (
                          <span className="rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[9px] font-bold">🔞 18+</span>
                        )}
                      </div>
                      {viewState?.previewUrl && media.mediaType === 'IMAGE' && (
                        <div className="relative select-none">
                          <img
                            src={viewState.previewUrl}
                            alt={viewState.watermarkText || 'Media'}
                            draggable={false}
                            onContextMenu={(event) => event.preventDefault()}
                            className="max-h-56 select-none rounded-lg"
                          />
                          {viewState.watermarkedMode !== 'embedded' && viewState.watermarkText && (
                            <span className="pointer-events-none absolute inset-x-1 bottom-1 rounded bg-black/55 px-1 py-0.5 text-[9px] text-white">
                              {viewState.watermarkText}
                            </span>
                          )}
                        </div>
                      )}
                      {viewState?.previewUrl && media.mediaType === 'AUDIO' && (
                        <audio
                          controls
                          controlsList="nodownload"
                          onContextMenu={(event) => event.preventDefault()}
                          src={viewState.previewUrl}
                          className="max-w-full"
                        />
                      )}
                      {viewState?.previewUrl && media.mediaType === 'VIDEO' && (
                        <div className="relative select-none">
                          <video
                            controls
                            controlsList="nodownload noplaybackrate"
                            disablePictureInPicture
                            onContextMenu={(event) => event.preventDefault()}
                            src={viewState.previewUrl}
                            className="max-h-56 rounded-lg"
                          />
                          {viewState.watermarkedMode !== 'embedded' && viewState.watermarkText && (
                            <span className="pointer-events-none absolute inset-x-1 bottom-8 rounded bg-black/55 px-1 py-0.5 text-[9px] text-white">
                              {viewState.watermarkText}
                            </span>
                          )}
                        </div>
                      )}
                      {!viewState?.previewUrl && !viewState?.revoked && (
                        <button
                          type="button"
                          onClick={() => void handleViewFriendMedia(message, media)}
                          disabled={mediaBusy}
                          className="flex items-center gap-1 rounded-full bg-white/85 px-2.5 py-1 text-[11px] font-bold text-blue-700"
                        >
                          <Eye size={12} />Xem trong 5 phút
                        </button>
                      )}
                      {viewState?.revoked && <span className="text-[10px] opacity-75">Media đã bị thu hồi</span>}
                      {isMine && !viewState?.revoked && (
                        <button
                          type="button"
                          onClick={() => void handleRevokeFriendMedia(message, media)}
                          className="flex items-center gap-1 text-[10px] font-semibold opacity-80 hover:opacity-100"
                        >
                          <Ban size={11} />Thu hồi quyền xem
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  )}
                  <time className={`mt-1 block text-[10px] ${isMine ? 'text-blue-100' : 'text-slate-400'}`} dateTime={message.sentAt}>{formatTime(message.sentAt)}</time>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSend} className="border-t border-slate-100 pt-2">
          {messageError && !isMessagesLoading && <p className="mb-2 text-xs text-rose-600" role="alert">{messageError}</p>}
          <div className="mb-1.5 flex items-center justify-between px-1 text-[10px] text-slate-500">
            <span>
              Media: {partnerMediaConsent ? 'Bạn đã bật nhận' : 'Bạn chưa bật nhận'} ·{' '}
              18+: {partnerAdultConsent ? 'Bạn đồng ý 18+' : 'Chưa đồng ý 18+'}
            </span>
            <button
              type="button"
              onClick={() => setSendAsAdult((prev) => !prev)}
              aria-pressed={sendAsAdult}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-bold transition ${
                sendAsAdult ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-300' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              <Flame size={11} />
              <span>{sendAsAdult ? 'Đang bật gửi 18+' : 'Nội dung người lớn'}</span>
            </button>
          </div>
          <div className="flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-slate-50 p-1.5 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
            <input
              ref={mediaInputRef}
              type="file"
              accept={sendAsAdult ? 'image/*,video/*' : 'image/*,audio/*,video/*'}
              onChange={(e) => void handleFriendFileSelected(e)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => mediaInputRef.current?.click()}
              disabled={mediaBusy || isRecording || !activeSessionId}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-200/70 disabled:opacity-40"
              aria-label="Gửi ảnh hoặc video"
            >
              <ImagePlus size={16} />
            </button>
            <button
              type="button"
              onClick={() => void handleToggleFriendRecording()}
              disabled={mediaBusy || !activeSessionId}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl disabled:opacity-40 ${
                isRecording ? 'animate-pulse bg-rose-600 text-white' : 'text-slate-500 hover:bg-slate-200/70'
              }`}
              aria-label={isRecording ? 'Dừng và gửi ghi âm' : 'Ghi âm'}
            >
              <Mic size={16} />
            </button>
            <label htmlFor="friend-message" className="sr-only">Tin nhắn cho {selectedFriend.nickname}</label>
            {isRecording ? (
              <span className="min-w-0 flex-1 px-2 text-xs font-semibold text-rose-600">Đang ghi âm… bấm mic để gửi</span>
            ) : (
              <input
                id="friend-message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Nhắn tin riêng…"
                maxLength={2000}
                className="min-w-0 flex-1 bg-transparent px-2 text-sm text-slate-800 outline-none placeholder:text-slate-400"
                disabled={isSending || mediaBusy}
              />
            )}
            <button type="submit" disabled={!draft.trim() || isSending || mediaBusy || isRecording} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Gửi tin nhắn">
              <Send size={16} />
            </button>
          </div>
        </form>

        {showAdultConsentModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
            <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
                <Flame size={24} />
              </div>
              <h3 className="mt-3 text-center text-sm font-bold text-slate-900">Bật quyền nhận nội dung 18+?</h3>
              <p className="mt-2 text-[11.5px] leading-relaxed text-slate-600">
                Bạn sắp cho phép người bạn này gửi ảnh/video nhạy cảm (18+) trong cuộc trò chuyện riêng. Ảnh/video được đóng dấu truy vết; hệ thống không thể ngăn hoàn toàn việc chụp màn hình từ thiết bị khác và Quản trị viên có thể kiểm tra bằng chứng nếu có báo cáo.
              </p>
              <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-xl bg-slate-50 p-2.5 text-[11px] text-slate-700">
                <input
                  type="checkbox"
                  checked={adultPolicyAck}
                  onChange={(e) => setAdultPolicyAck(e.target.checked)}
                  className="mt-0.5 rounded text-rose-600"
                />
                <span>Tôi xác nhận đã hiểu cảnh báo an toàn 18+ và đồng ý nhận nội dung người lớn.</span>
              </label>
              <div className="mt-4 flex gap-2">
                <button type="button" onClick={() => setShowAdultConsentModal(false)} className="flex-1 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-600">Hủy bỏ</button>
                <button type="button" disabled={!adultPolicyAck || mediaBusy} onClick={() => void submitAdultConsent(true, true)} className="flex-1 rounded-xl bg-rose-600 py-2.5 text-xs font-bold text-white disabled:opacity-50">Đồng ý bật 18+</button>
              </div>
            </div>
          </div>
        )}

        {showSenderAdultModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
            <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600">
                <AlertTriangle size={24} />
              </div>
              <h3 className="mt-3 text-center text-sm font-bold text-slate-900">Xác nhận trước khi gửi nội dung 18+</h3>
              <div className="mt-3 space-y-2 text-[11px] text-slate-700">
                <label className="flex cursor-pointer items-start gap-2 rounded-xl bg-slate-50 p-2.5">
                  <input type="checkbox" checked={senderConfirm18Plus} onChange={(e) => setSenderConfirm18Plus(e.target.checked)} className="mt-0.5 rounded text-rose-600" />
                  <span>Tôi xác nhận mọi nhân vật trong ảnh/video đều đủ 18 tuổi trở lên.</span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 rounded-xl bg-slate-50 p-2.5">
                  <input type="checkbox" checked={senderConfirmConsent} onChange={(e) => setSenderConfirmConsent(e.target.checked)} className="mt-0.5 rounded text-rose-600" />
                  <span>Tôi xác nhận nội dung có sự đồng thuận hợp pháp, không xâm phạm riêng tư.</span>
                </label>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowSenderAdultModal(false);
                    setPendingMediaFile(null);
                    setPendingMediaType(null);
                  }}
                  className="flex-1 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-600"
                >
                  Hủy
                </button>
                <button type="button" disabled={!senderConfirm18Plus || !senderConfirmConsent || mediaBusy} onClick={() => void confirmFriendAdultUpload()} className="flex-1 rounded-xl bg-rose-600 py-2.5 text-xs font-bold text-white disabled:opacity-50">Xác nhận & Gửi</button>
              </div>
            </div>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-4 py-4" aria-labelledby="friends-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">Kết nối bền lâu</p>
          <h1 id="friends-title" className="mt-1 text-xl font-extrabold tracking-tight text-slate-900">Bạn bè</h1>
          <p className="mt-1 text-sm text-slate-500">Nhắn tin riêng tư, không cần cùng trực tuyến.</p>
        </div>
        <button type="button" onClick={() => void loadFriends()} disabled={isFriendsLoading} className="rounded-full p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50" aria-label="Làm mới danh sách bạn bè">
          <RefreshCw size={17} className={isFriendsLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {isFriendsLoading && <p className="rounded-2xl bg-slate-50 p-5 text-center text-sm text-slate-500" role="status">Đang tải danh sách bạn bè…</p>}
      {!isFriendsLoading && error && (
        <div className="rounded-2xl border border-rose-100 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void loadFriends()} className="mt-2 font-semibold underline">Thử lại</button>
        </div>
      )}
      {!isFriendsLoading && !error && incomingRequests.length > 0 && (
        <section className="space-y-2" aria-labelledby="incoming-requests-title">
          <h2 id="incoming-requests-title" className="text-sm font-bold text-slate-800">Lời mời kết bạn</h2>
          <div className="space-y-2" role="list" aria-label="Lời mời kết bạn đang chờ">
            {incomingRequests.map((request) => (
              <div key={request.requestId} className="flex items-center gap-3 rounded-2xl border border-slate-100 bg-white p-3 shadow-sm" role="listitem">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 font-bold text-slate-700">
                  {initials(request.nickname)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">{request.nickname}</p>
                  <p className="text-xs text-slate-500">{request.age} tuổi · {formatTime(request.sentAt)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleAcceptRequest(request.requestId)}
                    disabled={acceptingRequestId !== null || decliningRequestId !== null}
                    className="flex min-h-9 items-center gap-1 rounded-xl bg-blue-600 px-3 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
                    aria-label={`Chấp nhận lời mời của ${request.nickname}`}
                  >
                    <Check size={14} />Chấp nhận
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeclineRequest(request.requestId)}
                    disabled={acceptingRequestId !== null || decliningRequestId !== null}
                    className="flex min-h-9 items-center gap-1 rounded-xl border border-slate-200 px-2.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
                    aria-label={`Từ chối lời mời của ${request.nickname}`}
                  >
                    <X size={14} />Từ chối
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {!isFriendsLoading && !error && friends.length === 0 && incomingRequests.length === 0 && (
        <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50/70 px-6 py-10 text-center">
          <Users className="mx-auto text-blue-500" size={30} />
          <h2 className="mt-3 text-sm font-bold text-slate-800">Chưa có bạn bè</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">Sau khi trò chuyện, hãy gửi lời mời kết bạn để giữ liên lạc.</p>
        </div>
      )}
      {!isFriendsLoading && !error && friends.length > 0 && (
        <div className="space-y-3">
          {/* Quick Search */}
          <div className="relative">
            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Tìm kiếm bạn bè theo tên..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-xs text-slate-900 outline-none transition focus:border-blue-500 focus:bg-white"
            />
          </div>

          <div className="space-y-2" role="list" aria-label="Danh sách bạn bè">
            {filteredFriends.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-400">Không tìm thấy bạn nào khớp với từ khóa.</p>
            ) : (
              filteredFriends.map((friend) => (
                <button key={friend.userId} type="button" onClick={() => setSelectedFriendId(friend.userId)} className="flex w-full items-center gap-3 rounded-2xl border border-slate-100 bg-white p-3 text-left shadow-sm transition hover:border-blue-200 hover:shadow-md" role="listitem">
                  <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-100 font-bold text-blue-700">
                    {initials(friend.nickname)}
                    <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white ${friend.isOnline ? 'bg-emerald-500' : 'bg-slate-300'}`} aria-label={friend.isOnline ? 'Đang hoạt động' : 'Ngoại tuyến'} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-slate-900">{friend.nickname}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{friend.age} tuổi · {friend.isOnline ? 'Đang hoạt động' : 'Ngoại tuyến'}</p>
                  </div>
                  <MessageCircle size={18} className="text-blue-500" aria-hidden="true" />
                  <span className="sr-only">Mở cuộc trò chuyện</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-800">
        <UserRound size={14} aria-hidden="true" />
        <span>Chỉ bạn bè đã xác nhận mới có thể nhắn tin riêng.</span>
      </div>

      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-lg animate-fade-in">
          {toastMsg}
        </div>
      )}

      {/* Confirmation Modal: Unfriend or Block */}
      {confirmAction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-xs rounded-3xl bg-white p-5 shadow-2xl">
            <div className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${
              confirmAction.type === 'block' ? 'bg-rose-50 text-rose-600' : 'bg-amber-50 text-amber-600'
            }`}>
              {confirmAction.type === 'block' ? <Ban size={24} /> : <UserX size={24} />}
            </div>
            <h3 className="mt-3 text-center text-sm font-bold text-slate-900">
              {confirmAction.type === 'block' ? 'Chặn người dùng này?' : 'Hủy kết bạn?'}
            </h3>
            <p className="mt-1.5 text-center text-[11.5px] leading-relaxed text-slate-500">
              {confirmAction.type === 'block' ? (
                <>
                  Bạn và <strong>{confirmAction.friendName}</strong> sẽ bị hủy kết bạn và không thể liên lạc với nhau nữa.
                </>
              ) : (
                <>
                  Bạn có chắc chắn muốn hủy kết bạn với <strong>{confirmAction.friendName}</strong> không?
                </>
              )}
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                disabled={isActionBusy}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={handleExecuteConfirmAction}
                disabled={isActionBusy}
                className={`flex-1 rounded-xl py-2.5 text-xs font-bold text-white shadow-md disabled:opacity-50 ${
                  confirmAction.type === 'block'
                    ? 'bg-rose-600 shadow-rose-600/30 hover:bg-rose-700'
                    : 'bg-amber-600 shadow-amber-600/30 hover:bg-amber-700'
                }`}
              >
                {confirmAction.type === 'block' ? 'Xác nhận chặn' : 'Xác nhận hủy'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

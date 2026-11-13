import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io } from 'socket.io-client';
import { SocketEvents, type MessageType } from '@chatible/shared';
import {
  ArrowDown,
  ArrowLeft,
  Ban,
  Check,
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
import { AdultReceiveConsentModal, AdultSenderCommitmentsModal } from '../media/AdultConsentModals.js';
import { MediaAttachmentPreview } from '../media/MediaAttachmentPreview.js';
import { parseSessionMediaPayload, type SessionMediaMeta } from '../media/mediaPreviewLifecycle.js';
import { useSessionMedia, type UploadedSessionMedia } from '../media/useSessionMedia.js';
import { useSmartAutoScroll } from '../chat/useSmartAutoScroll.js';
import { mergeFriendMessages, type OrderedFriendMessage } from './friendMessageOrder.js';
import { triggerPushNotification } from '../notifications/pushNotification.js';

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

type FriendMediaMeta = SessionMediaMeta;

type FriendMessage = OrderedFriendMessage & {
  sessionId?: string;
  senderId: string;
  receiverId: string;
  messageType?: MessageType;
  content: string;
  metadata?: unknown;
  isAdultContent?: boolean;
  expiresAt: string;
};

type FriendsViewProps = {
  currentUserId: string;
};

function parseFriendMedia(message: FriendMessage): FriendMediaMeta | undefined {
  const mType = message.messageType;
  if (mType !== 'IMAGE' && mType !== 'AUDIO' && mType !== 'VIDEO') return undefined;
  return parseSessionMediaPayload(message.content, mType, Boolean(message.isAdultContent));
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
  const {
    scrollContainerRef,
    endRef: messagesEndRef,
    handleScroll: handleMessagesScroll,
    unreadBelowCount,
    showNewMessageButton,
    scrollToBottom,
  } = useSmartAutoScroll({
    itemCount: messages.length,
    resetKey: selectedFriendId,
    tailKey: messages[messages.length - 1]?.id ?? null,
  });
  const [isFriendsLoading, setIsFriendsLoading] = useState(true);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [acceptingRequestId, setAcceptingRequestId] = useState<string | null>(null);
  const [decliningRequestId, setDecliningRequestId] = useState<string | null>(null);
  const [isActionBusy, setIsActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const selectedFriendIdRef = useRef<string | null>(null);
  const friendsRef = useRef<Friend[]>([]);
  const messagesRef = useRef<FriendMessage[]>([]);
  const pendingScrollRestoreRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const isLoadingOlderRef = useRef(false);

  selectedFriendIdRef.current = selectedFriendId;
  friendsRef.current = friends;
  messagesRef.current = messages;

  const sendFriendMediaMessage = useCallback(
    async ({ media, isAdult }: { media: UploadedSessionMedia; isAdult: boolean }) => {
      const friendId = selectedFriendIdRef.current;
      if (!friendId) {
        throw new Error('Phiên trò chuyện bạn bè chưa sẵn sàng.');
      }
      const response = await apiFetch(`/api/v1/friends/${encodeURIComponent(friendId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: media.mediaType,
          content: JSON.stringify(media),
          mediaId: media.mediaId,
          isAdultContent: isAdult,
          metadata: media,
          clientMessageId: crypto.randomUUID(),
        }),
      });
      const message = await readApi<FriendMessage>(response);
      if (selectedFriendIdRef.current === friendId) {
        setMessages((current) => mergeFriendMessages(current, [message]));
      }
    },
    []
  );

  const sessionMedia = useSessionMedia({
    sessionId: activeSessionId,
    recipientId: selectedFriendId,
    canSend: Boolean(selectedFriendId && activeSessionId),
    voiceFilenamePrefix: 'friend-voice',
    partnerNotAdultConsentMessage: 'Bạn bè chưa bật quyền "Nhận nội dung 18+" trong luồng chat này.',
    fileTooLargeMessage: () => 'Dung lượng tệp vượt quá giới hạn cho phép.',
    onSendMediaMessage: sendFriendMediaMessage,
    onError: setMessageError,
  });

  const mediaHandlersRef = useRef(sessionMedia);
  mediaHandlersRef.current = sessionMedia;

  const selectedFriend = useMemo(
    () => friends.find((friend) => friend.userId === selectedFriendId) || null,
    [friends, selectedFriendId]
  );

  const filteredFriends = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return friends;
    return friends.filter((f) => f.nickname.toLowerCase().includes(q));
  }, [friends, searchQuery]);

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
      if (activeFriend && (incoming.senderId === activeFriend || incoming.receiverId === activeFriend)) {
        setMessages((current) => mergeFriendMessages(current, [incoming]));
      }

      if (incoming.senderId !== currentUserId) {
        let preview = incoming.content || '';
        if (incoming.type === 'IMAGE') preview = '📷 Đã gửi một hình ảnh';
        else if (incoming.type === 'AUDIO') preview = '🎵 Đã gửi một đoạn ghi âm';
        else if (incoming.type === 'VIDEO') preview = '🎥 Đã gửi một video';

        const senderFriend = friendsRef.current.find((f) => f.userId === incoming.senderId);
        const senderName = senderFriend?.nickname || 'Bạn bè';

        void triggerPushNotification({
          type: 'FRIEND',
          senderName,
          content: preview,
          tag: `friend-${incoming.senderId}`,
        });
      }
    });
    socket.on(SocketEvents.MEDIA_REVOKED, (payload: { mediaId?: string }) => {
      if (!payload?.mediaId) return;
      mediaHandlersRef.current.markMediaRevoked(
        payload.mediaId,
        messagesRef.current.map((msg) => ({ messageId: msg.id, mediaId: parseFriendMedia(msg)?.mediaId }))
      );
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!selectedFriendId) {
      setMessages([]);
      setActiveSessionId(null);
      return;
    }
    let isCurrent = true;
    setIsMessagesLoading(true);
    setIsLoadingOlder(false);
    isLoadingOlderRef.current = false;
    pendingScrollRestoreRef.current = null;
    setMessageError(null);
    setOlderMessagesError(null);
    setMessages([]);
    setNextCursor(null);
    setHasMoreMessages(false);
    setActiveSessionId(null);

    void Promise.all([
      apiFetch(`/api/v1/friends/${encodeURIComponent(selectedFriendId)}/session`).then((r) =>
        readApi<{ sessionId: string; myAdultConsent: boolean; partnerAdultConsent: boolean }>(r)
      ),
      apiFetch(`/api/v1/friends/${encodeURIComponent(selectedFriendId)}/messages?limit=40`).then((r) =>
        readApi<{ messages?: FriendMessage[]; nextCursor?: string | null; hasMore?: boolean }>(r)
      ),
    ])
      .then(([sessionInfo, data]) => {
        if (!isCurrent) return;
        setActiveSessionId(sessionInfo.sessionId);
        mediaHandlersRef.current.setMyAdultConsent(sessionInfo.myAdultConsent);
        mediaHandlersRef.current.setPartnerAdultConsent(sessionInfo.partnerAdultConsent);
        const fetched = Array.isArray(data.messages) ? data.messages : [];
        setMessages((current) => mergeFriendMessages(current, fetched));
        setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
        setHasMoreMessages(Boolean(data.hasMore && data.nextCursor));
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
  }, [selectedFriendId]);

  useLayoutEffect(() => {
    const restore = pendingScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    if (!restore || !container) return;
    pendingScrollRestoreRef.current = null;
    const delta = container.scrollHeight - restore.prevScrollHeight;
    container.scrollTop = restore.prevScrollTop + Math.max(0, delta);
  }, [messages, scrollContainerRef]);

  const loadOlderMessages = useCallback(async () => {
    const friendId = selectedFriendIdRef.current;
    if (!friendId || !nextCursor || !hasMoreMessages || isLoadingOlderRef.current || isMessagesLoading) {
      return;
    }
    isLoadingOlderRef.current = true;
    setIsLoadingOlder(true);
    setOlderMessagesError(null);

    try {
      const response = await apiFetch(
        `/api/v1/friends/${encodeURIComponent(friendId)}/messages?limit=40&before=${encodeURIComponent(nextCursor)}`
      );
      const data = await readApi<{
        messages?: FriendMessage[];
        nextCursor?: string | null;
        hasMore?: boolean;
      }>(response);
      if (selectedFriendIdRef.current !== friendId) return;

      const older = Array.isArray(data.messages) ? data.messages : [];
      const container = scrollContainerRef.current;
      if (container && older.length > 0) {
        pendingScrollRestoreRef.current = {
          prevScrollHeight: container.scrollHeight,
          prevScrollTop: container.scrollTop,
        };
      }
      if (older.length > 0) {
        setMessages((current) => mergeFriendMessages(current, older));
      }
      setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
      setHasMoreMessages(Boolean(data.hasMore && data.nextCursor));
    } catch (requestError) {
      if (selectedFriendIdRef.current === friendId) {
        setOlderMessagesError(requestError instanceof Error ? requestError.message : 'Không thể tải thêm tin cũ.');
      }
    } finally {
      isLoadingOlderRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [hasMoreMessages, isMessagesLoading, nextCursor, scrollContainerRef]);

  const handleThreadScroll = useCallback(() => {
    handleMessagesScroll();
    const container = scrollContainerRef.current;
    if (container && container.scrollTop <= 80 && hasMoreMessages && !isLoadingOlderRef.current && !isMessagesLoading) {
      void loadOlderMessages();
    }
  }, [handleMessagesScroll, hasMoreMessages, isMessagesLoading, loadOlderMessages, scrollContainerRef]);

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

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    const targetFriendId = selectedFriendId;
    if (!content || !targetFriendId || isSending) return;
    setIsSending(true);
    setMessageError(null);
    try {
      const response = await apiFetch(`/api/v1/friends/${encodeURIComponent(targetFriendId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, clientMessageId: crypto.randomUUID() }),
      });
      const message = await readApi<FriendMessage>(response);
      if (selectedFriendIdRef.current === targetFriendId) {
        setMessages((current) => mergeFriendMessages(current, [message]));
      }
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
              onClick={() => void sessionMedia.handleConsentToggle()}
              disabled={sessionMedia.mediaBusy || !activeSessionId}
              aria-pressed={sessionMedia.mediaConsent}
              className={`relative rounded-lg p-2 transition ${
                sessionMedia.mediaConsent ? 'bg-emerald-100 text-emerald-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
              } disabled:opacity-50`}
              title={sessionMedia.mediaConsent ? 'Đang bật nhận ảnh/video' : 'Bật/tắt quyền nhận media'}
              aria-label="Quyền nhận media"
            >
              <ShieldCheck size={17} />
            </button>
            <button
              type="button"
              onClick={sessionMedia.handleAdultConsentToggle}
              disabled={sessionMedia.mediaBusy || !activeSessionId}
              aria-pressed={sessionMedia.myAdultConsent}
              className={`relative rounded-lg p-2 transition ${
                sessionMedia.myAdultConsent ? 'bg-rose-100 text-rose-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
              } disabled:opacity-50`}
              title={sessionMedia.myAdultConsent ? 'Đang bật nhận nội dung 18+' : 'Bật/tắt nhận nội dung 18+'}
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

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollContainerRef}
            onScroll={handleThreadScroll}
            className="flex-1 space-y-2 overflow-y-auto py-4"
            aria-live="polite"
          >
            {!isMessagesLoading && !messageError && hasMoreMessages && (
              <div className="flex flex-col items-center gap-1 pb-2">
                <button
                  type="button"
                  disabled={isLoadingOlder}
                  onClick={() => void loadOlderMessages()}
                  className="inline-flex min-h-[36px] items-center rounded-full border border-slate-200 bg-slate-50 px-3.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
                >
                  {isLoadingOlder ? 'Đang tải tin cũ hơn…' : 'Tải tin nhắn cũ hơn'}
                </button>
                {olderMessagesError && (
                  <p className="text-[11px] text-rose-600" role="alert">{olderMessagesError}</p>
                )}
              </div>
            )}
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
              const mediaLabel = media
                ? media.mediaType === 'IMAGE'
                  ? isMine ? 'Ảnh đã gửi' : 'Ảnh đã nhận'
                  : media.mediaType === 'AUDIO'
                  ? isMine ? 'Audio đã gửi' : 'Audio đã nhận'
                  : isMine ? 'Video đã gửi' : 'Video đã nhận'
                : '';
              return (
                <div key={message.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm ${isMine ? 'rounded-br-md bg-blue-600 text-white' : 'rounded-bl-md bg-slate-100 text-slate-800'}`}>
                    {media ? (
                      <MediaAttachmentPreview
                        title={mediaLabel}
                        mediaType={media.mediaType}
                        isAdult={media.isAdult}
                        isMine={isMine}
                        viewState={sessionMedia.mediaViews[message.id]}
                        busy={sessionMedia.mediaBusy}
                        onView={() => void sessionMedia.openMediaPreview(message.id, media.mediaId, media.contentType)}
                        onRevoke={() => void sessionMedia.revokeMediaPreview(message.id, media.mediaId)}
                      />
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

          {showNewMessageButton && (
            <button
              type="button"
              onClick={() => scrollToBottom('smooth')}
              className="absolute bottom-3 right-2 z-10 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-blue-600 px-3.5 py-2 text-xs font-bold text-white shadow-lg shadow-blue-500/30 transition hover:bg-blue-700"
            >
              <span>Tin mới ({unreadBelowCount})</span>
              <ArrowDown size={14} aria-hidden="true" />
            </button>
          )}
        </div>

        <form onSubmit={handleSend} className="border-t border-slate-100 pt-2">
          {messageError && !isMessagesLoading && <p className="mb-2 text-xs text-rose-600" role="alert">{messageError}</p>}
          <div className="mb-1.5 flex items-center justify-between px-1 text-[10px] text-slate-500">
            <span>
              Media: {sessionMedia.partnerMediaConsent ? 'Bạn đã bật nhận' : 'Bạn chưa bật nhận'} ·{' '}
              18+: {sessionMedia.partnerAdultConsent ? 'Bạn đồng ý 18+' : 'Chưa đồng ý 18+'}
            </span>
            <button
              type="button"
              onClick={() => sessionMedia.setSendAsAdult((prev) => !prev)}
              aria-pressed={sessionMedia.sendAsAdult}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-bold transition ${
                sessionMedia.sendAsAdult ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-300' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              <Flame size={11} />
              <span>{sessionMedia.sendAsAdult ? 'Đang bật gửi 18+' : 'Nội dung người lớn'}</span>
            </button>
          </div>
          <div className="flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-slate-50 p-1.5 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
            <input
              ref={sessionMedia.mediaInputRef}
              type="file"
              accept={sessionMedia.sendAsAdult ? 'image/*,video/*' : 'image/*,audio/*,video/*'}
              onChange={(e) => void sessionMedia.handleFileSelected(e)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => sessionMedia.mediaInputRef.current?.click()}
              disabled={sessionMedia.mediaBusy || sessionMedia.isRecording || !activeSessionId}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-200/70 disabled:opacity-40"
              aria-label="Gửi ảnh hoặc video"
            >
              <ImagePlus size={16} />
            </button>
            <button
              type="button"
              onClick={() => void sessionMedia.handleToggleRecording()}
              disabled={sessionMedia.mediaBusy || !activeSessionId}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl disabled:opacity-40 ${
                sessionMedia.isRecording ? 'animate-pulse bg-rose-600 text-white' : 'text-slate-500 hover:bg-slate-200/70'
              }`}
              aria-label={sessionMedia.isRecording ? 'Dừng và gửi ghi âm' : 'Ghi âm'}
            >
              <Mic size={16} />
            </button>
            <label htmlFor="friend-message" className="sr-only">Tin nhắn cho {selectedFriend.nickname}</label>
            {sessionMedia.isRecording ? (
              <span className="min-w-0 flex-1 px-2 text-xs font-semibold text-rose-600">Đang ghi âm… bấm mic để gửi</span>
            ) : (
              <input
                id="friend-message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Nhắn tin riêng…"
                maxLength={2000}
                className="min-w-0 flex-1 bg-transparent px-2 text-sm text-slate-800 outline-none placeholder:text-slate-400"
                disabled={isSending || sessionMedia.mediaBusy}
              />
            )}
            <button type="submit" disabled={!draft.trim() || isSending || sessionMedia.mediaBusy || sessionMedia.isRecording} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Gửi tin nhắn">
              <Send size={16} />
            </button>
          </div>
        </form>

        <AdultReceiveConsentModal
          open={sessionMedia.showAdultConsentModal}
          description="Bạn sắp cho phép người bạn này gửi ảnh/video nhạy cảm (18+) trong cuộc trò chuyện riêng. Ảnh/video được đóng dấu truy vết; hệ thống không thể ngăn hoàn toàn việc chụp màn hình từ thiết bị khác và Quản trị viên có thể kiểm tra bằng chứng nếu có báo cáo."
          ackLabel="Tôi xác nhận đã hiểu cảnh báo an toàn 18+ và đồng ý nhận nội dung người lớn."
          adultPolicyAck={sessionMedia.adultPolicyAck}
          busy={sessionMedia.mediaBusy}
          onAckChange={sessionMedia.setAdultPolicyAck}
          onCancel={() => sessionMedia.setShowAdultConsentModal(false)}
          onConfirm={() => void sessionMedia.submitAdultConsent(true, true)}
        />

        <AdultSenderCommitmentsModal
          open={sessionMedia.showSenderAdultModal}
          confirm18Plus={sessionMedia.senderConfirm18Plus}
          confirmConsent={sessionMedia.senderConfirmConsent}
          busy={sessionMedia.mediaBusy}
          onConfirm18PlusChange={sessionMedia.setSenderConfirm18Plus}
          onConfirmConsentChange={sessionMedia.setSenderConfirmConsent}
          onCancel={sessionMedia.cancelSenderAdultModal}
          onSubmit={() => void sessionMedia.confirmSenderAdultUpload()}
        />
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

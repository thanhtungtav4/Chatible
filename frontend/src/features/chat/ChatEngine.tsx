import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { SocketEvents } from '@chatible/shared';
import type { ChatState, UserPublicProfile, SendMessageDto, TargetGender } from '@chatible/shared';
import { Search, Send, UserPlus, RefreshCw, AlertTriangle, WifiOff, Sparkles, ImagePlus, Mic, ShieldCheck, ArrowRight, ArrowDown, Flame } from 'lucide-react';
import { API_BASE_URL } from '../../api.js';
import { AdultReceiveConsentModal, AdultSenderCommitmentsModal } from '../media/AdultConsentModals.js';
import { MediaAttachmentPreview } from '../media/MediaAttachmentPreview.js';
import { parseSessionMediaPayload, type SessionMediaMeta } from '../media/mediaPreviewLifecycle.js';
import { useSessionMedia, type UploadedSessionMedia } from '../media/useSessionMedia.js';
import { useSmartAutoScroll } from './useSmartAutoScroll.js';

type MediaMessage = SessionMediaMeta;

function AudioWaveform({ samples, durationSec }: { samples: number[]; durationSec?: number }) {
  if (samples.length !== 30) return null;
  return (
    <div className="flex items-end gap-1" role="img" aria-label={`Dạng sóng âm thanh${durationSec ? `, ${durationSec} giây` : ''}`}>
      {samples.map((sample, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="w-1 rounded-full bg-current opacity-70"
          style={{ height: `${2 + Math.round(Math.max(0, Math.min(1, sample)) * 22)}px` }}
        />
      ))}
      {durationSec !== undefined && <span className="ml-1 self-center text-[10px] opacity-70">{durationSec}s</span>}
    </div>
  );
}
type ChatMessage = { id: string; sender: 'me' | 'partner'; text: string; time: string; media?: MediaMessage };
type ReportRequest = { sessionId: string; reportedUserId: string; evidenceMessageIds: string[] };

interface ChatEngineProps {
  currentUser: {
    id: string;
    nickname: string;
    age: number;
    gender: string;
    preferredGender?: string;
    preferredAgeMax?: number;
  };
  onOpenReport: (request: ReportRequest) => void;
}

export function ChatEngine({ currentUser, onOpenReport }: ChatEngineProps) {
  const [chatState, setChatState] = useState<ChatState>('IDLE');
  const [targetGender, setTargetGender] = useState<TargetGender>(
    (currentUser.preferredGender as TargetGender) || 'ALL'
  );
  const [ageMax, setAgeMax] = useState<number>(currentUser.preferredAgeMax || 30);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [partner, setPartner] = useState<UserPublicProfile | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [secondsWaiting, setSecondsWaiting] = useState(0);
  const [reconnectCountdown, setReconnectCountdown] = useState(30);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isFriendRequested, setIsFriendRequested] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const ageSliderId = useId();
  const {
    scrollContainerRef,
    endRef: messagesEndRef,
    handleScroll: handleMessagesScroll,
    unreadBelowCount,
    showNewMessageButton,
    scrollToBottom,
  } = useSmartAutoScroll({
    itemCount: messages.length,
    resetKey: sessionId,
    tailKey: messages[messages.length - 1]?.id ?? null,
  });
  const socketRef = useRef<Socket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const shouldResumeRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const emitSocketMediaMessage = useCallback(async ({ media, isAdult }: { media: UploadedSessionMedia; isAdult: boolean }) => {
    const socket = socketRef.current;
    if (!socket?.connected) throw new Error('Chưa kết nối máy chủ.');
    const clientMessageId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      socket.timeout(10_000).emit(
        SocketEvents.MESSAGE_SEND,
        {
          type: media.mediaType,
          content: JSON.stringify(media),
          isAdultContent: isAdult,
          clientMessageId,
        } as SendMessageDto,
        (timeoutError: Error | null, ack?: { success: boolean; error?: string; messageId?: string; sentAt?: string }) => {
          if (timeoutError) {
            reject(new Error('Máy chủ không phản hồi khi gửi media.'));
            return;
          }
          if (!ack?.success || !ack.messageId) {
            reject(new Error(ack?.error || 'Không gửi được media.'));
            return;
          }
          setMessages((previous) => [...previous, {
            id: ack.messageId as string,
            sender: 'me',
            text: isAdult
              ? `🔞 ${media.mediaType === 'IMAGE' ? 'Ảnh 18+ đã gửi' : 'Video 18+ đã gửi'}`
              : media.mediaType === 'IMAGE'
              ? 'Ảnh đã gửi'
              : media.mediaType === 'AUDIO'
              ? 'Audio đã gửi'
              : 'Video đã gửi',
            media,
            time: new Date(ack.sentAt || Date.now()).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
          }]);
          resolve();
        }
      );
    });
  }, []);

  const sessionMedia = useSessionMedia({
    sessionId,
    recipientId: partner?.id ?? null,
    canSend: chatState === 'CHATTING',
    voiceFilenamePrefix: 'voice',
    partnerNotAdultConsentMessage: 'Đối phương chưa bật quyền "Nhận nội dung 18+". Hãy chờ đối phương đồng ý trước.',
    onSendMediaMessage: emitSocketMediaMessage,
    onError: setActionError,
    onConsentChanged: (kind, enabled) => {
      socketRef.current?.emit(
        kind === 'MEDIA' ? SocketEvents.MEDIA_CONSENT_UPDATE : SocketEvents.MEDIA_ADULT_CONSENT_UPDATE,
        { enabled }
      );
    },
    onRevoked: (mediaId) => {
      socketRef.current?.emit(SocketEvents.MEDIA_REVOKED, { mediaId });
    },
  });

  const mediaHandlersRef = useRef(sessionMedia);
  mediaHandlersRef.current = sessionMedia;


  useEffect(() => {
    const socket = io(API_BASE_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect_error', (error: Error) => {
      setConnectionError(`Không thể kết nối: ${error.message}`);
    });
    socket.on('disconnect', (reason: string) => {
      if (reason === 'io client disconnect' || !sessionIdRef.current) return;
      shouldResumeRef.current = true;
      setReconnectCountdown(30);
      setChatState('RECONNECTING');
    });
    socket.on('connect', () => {
      setConnectionError(null);
      if (!shouldResumeRef.current || !sessionIdRef.current) return;
      socket.emit(SocketEvents.SESSION_RESUME, { sessionId: sessionIdRef.current }, (ack: { success: boolean; state?: ChatState }) => {
        if (ack?.success) {
          shouldResumeRef.current = false;
          setChatState(ack.state === 'RECONNECTING' ? 'RECONNECTING' : 'CHATTING');
        } else {
          shouldResumeRef.current = false;
          sessionIdRef.current = null;
          setActionError('Không thể khôi phục phiên chat.');
          setChatState('ENDED');
        }
      });
    });

    socket.on(SocketEvents.MATCHING_FOUND, (result: { sessionId: string; partner: UserPublicProfile }) => {
      sessionIdRef.current = result.sessionId;
      shouldResumeRef.current = false;
      setSessionId(result.sessionId);
      setPartner(result.partner);
      setChatState('CHATTING');
    });
    socket.on(SocketEvents.MATCHING_ERROR, (result: { error?: string }) => {
      setConnectionError(result.error || 'Ghép đôi thất bại.');
      if (!sessionIdRef.current) setChatState('IDLE');
    });
    socket.on(SocketEvents.MESSAGE_RECEIVE, (message: { id: string; content: string; type?: string; isAdultContent?: boolean }) => {
      const mediaType = message.type === 'IMAGE' || message.type === 'AUDIO' || message.type === 'VIDEO'
        ? message.type
        : null;
      const media = mediaType
        ? parseSessionMediaPayload(message.content, mediaType, Boolean(message.isAdultContent))
        : undefined;
      setMessages((previous) => [...previous, {
        id: message.id,
        sender: 'partner',
        text: media ? (media.mediaType === 'IMAGE' ? 'Ảnh đã nhận' : media.mediaType === 'AUDIO' ? 'Audio đã nhận' : 'Video đã nhận') : message.content,
        media,
        time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      }]);
    });
    socket.on(SocketEvents.MEDIA_CONSENT_UPDATE, (payload: { sessionId?: string; enabled?: boolean }) => {
      if (!payload?.sessionId || payload.sessionId === sessionIdRef.current) {
        mediaHandlersRef.current.setPartnerMediaConsent(Boolean(payload?.enabled));
      }
    });
    socket.on(SocketEvents.MEDIA_ADULT_CONSENT_UPDATE, (payload: { sessionId?: string; enabled?: boolean }) => {
      if (!payload?.sessionId || payload.sessionId === sessionIdRef.current) {
        mediaHandlersRef.current.setPartnerAdultConsent(Boolean(payload?.enabled));
      }
    });
    socket.on(SocketEvents.MEDIA_REVOKED, (payload: { mediaId?: string }) => {
      if (!payload?.mediaId) return;
      mediaHandlersRef.current.markMediaRevoked(
        payload.mediaId,
        messagesRef.current.map((item) => ({ messageId: item.id, mediaId: item.media?.mediaId }))
      );
      setMessages((previous) =>
        previous.map((item) =>
          item.media && item.media.mediaId === payload.mediaId
            ? { ...item, media: { ...item.media, revoked: true } }
            : item
        )
      );
    });
    socket.on(SocketEvents.CONNECTION_LOST, ({ timeoutSec }: { timeoutSec: number }) => {
      shouldResumeRef.current = true;
      setReconnectCountdown(timeoutSec);
      setChatState('RECONNECTING');
    });
    socket.on(SocketEvents.CONNECTION_RESTORED, () => {
      shouldResumeRef.current = false;
      setChatState('CHATTING');
    });
    socket.on(SocketEvents.CHAT_ENDED, () => {
      shouldResumeRef.current = false;
      sessionIdRef.current = null;
      setChatState('ENDED');
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [currentUser.id]);

  useEffect(() => {
    if (chatState !== 'WAITING') return;
    setSecondsWaiting(0);
    const interval = window.setInterval(() => setSecondsWaiting((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [chatState]);

  useEffect(() => {
    if (chatState !== 'RECONNECTING') return;
    const interval = window.setInterval(() => {
      setReconnectCountdown((value) => {
        if (value <= 1) {
          setChatState('ENDED');
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [chatState]);

  const handleStartMatching = () => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setConnectionError('Chưa kết nối máy chủ. Kiểm tra đăng nhập rồi thử lại.');
      return;
    }
    setConnectionError(null);
    setActionError(null);
    setIsFriendRequested(false);
    sessionMedia.clearAllMediaPreviews();
    setMessages([]);
    setPartner(null);
    setSessionId(null);
    sessionIdRef.current = null;
    shouldResumeRef.current = false;
    setChatState('WAITING');
    socket.emit(SocketEvents.MATCHING_JOIN, {
      targetGender,
      ageMin: 18,
      ageMax,
      lastPartnerId: partner?.id,
    });
  };

  const handleExpandFilter = () => socketRef.current?.emit(SocketEvents.MATCHING_EXPAND_ACCEPT);

  const handleCancelMatching = () => {
    socketRef.current?.emit(SocketEvents.MATCHING_CANCEL);
    setChatState('IDLE');
  };

  const handleSendMessage = (event: React.FormEvent) => {
    event.preventDefault();
    const socket = socketRef.current;
    const text = inputMessage.trim();
    if (!text || chatState !== 'CHATTING' || !socket?.connected) return;

    setActionError(null);
    const clientMessageId = crypto.randomUUID();
    socket.emit(SocketEvents.MESSAGE_SEND, { type: 'TEXT', content: text, clientMessageId } as SendMessageDto, (ack: { success: boolean; error?: string; messageId?: string; sentAt?: string }) => {
      if (!ack?.success || !ack.messageId) {
        setActionError(ack?.error || 'Không gửi được tin nhắn.');
        return;
      }
      setMessages((previous) => [...previous, {
        id: ack.messageId as string,
        sender: 'me',
        text,
        time: new Date(ack.sentAt || Date.now()).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      }]);
      setInputMessage('');
    });
  };

  const handleEndChat = () => {
    setShowEndConfirm(false);
    socketRef.current?.emit(SocketEvents.CHAT_END);
  };

  const handleNextChat = () => {
    socketRef.current?.emit(SocketEvents.CHAT_NEXT, undefined, (ack: { success: boolean }) => {
      if (ack?.success) handleStartMatching();
      else setActionError('Không thể kết thúc phiên hiện tại.');
    });
  };

  const handleSendFriendRequest = () => {
    if (!partner) return;
    socketRef.current?.emit(SocketEvents.FRIEND_REQUEST_SEND, { targetUserId: partner.id }, (ack: { success: boolean; error?: string }) => {
      if (ack?.success) setIsFriendRequested(true);
      else setActionError(ack?.error || 'Không gửi được lời mời kết bạn.');
    });
  };

  const handleReport = () => {
    if (!sessionId || !partner) {
      setActionError('Không tìm thấy phiên chat để báo cáo.');
      return;
    }
    onOpenReport({
      sessionId,
      reportedUserId: partner.id,
      evidenceMessageIds: messages.map((message) => message.id),
    });
  };

  const formatTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <div className="flex h-full flex-col justify-between overflow-hidden">
      {connectionError && <div role="alert" className="mb-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{connectionError}</div>}
      {actionError && <div role="alert" className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">{actionError}</div>}

      {chatState === 'IDLE' && (
        <div className="flex flex-1 flex-col justify-between overflow-y-auto px-4 py-5">
          {/* Hero Avatar Cluster & Online Badge */}
          <div className="flex flex-col items-center text-center">
            <div className="flex items-center -space-x-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-blue-500 text-xs font-bold text-white shadow-sm">
                AN
              </div>
              <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-pink-500 text-xs font-bold text-white shadow-sm">
                LK
              </div>
              <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-amber-500 text-xs font-bold text-white shadow-sm">
                TH
              </div>
              <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-emerald-500 text-xs font-bold text-white shadow-sm">
                QD
              </div>
            </div>
            <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-bold text-emerald-700 shadow-sm">
              <span className="h-2 w-2 animate-ping rounded-full bg-emerald-500" />
              <span>Sẵn sàng kết nối • Ghép đôi 1–1</span>
            </div>

            <h1 className="mt-3 text-xl font-extrabold tracking-tight text-slate-900">
              Kết nối với <span className="text-blue-600">Sự Ẩn Danh</span>
            </h1>
            <p className="mt-1 text-xs text-slate-500">
              Mã hóa Envelope KMS • Ẩn danh 1–1 • Dành cho người 18+
            </p>
          </div>

          {/* Unified Preference Card */}
          <div className="my-4 rounded-3xl border border-slate-200/80 bg-slate-50/70 p-4 shadow-sm backdrop-blur-sm">
            {/* Gender Segmented Control */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800">Ưu tiên tìm bạn</span>
                <span className="rounded-full bg-blue-100/70 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                  Khớp 2 chiều ⚡
                </span>
              </div>
              <div className="mt-2.5 grid grid-cols-4 gap-1.5 rounded-2xl bg-white p-1 border border-slate-200/60 shadow-inner">
                {(
                  [
                    { key: 'ALL', label: 'Tất cả' },
                    { key: 'FEMALE', label: 'Nữ' },
                    { key: 'MALE', label: 'Nam' },
                    { key: 'OTHER', label: 'Khác' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setTargetGender(opt.key)}
                    className={`rounded-xl py-2 text-xs font-bold transition ${
                      targetGender === opt.key
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="my-4 border-t border-slate-200/60" />

            {/* Age Range Slider */}
            <div>
              <div className="flex items-center justify-between">
                <label htmlFor={ageSliderId} className="text-xs font-bold text-slate-800">Khoảng tuổi tối đa</label>
                <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-bold text-blue-700 border border-blue-200/60">
                  18 – {ageMax >= 50 ? '50+' : `${ageMax} tuổi`}
                </span>
              </div>
              <div className="mt-3 px-1">
                <input
                  id={ageSliderId}
                  type="range"
                  min="18"
                  max="50"
                  value={ageMax}
                  onChange={(e) => setAgeMax(Number(e.target.value))}
                  className="w-full accent-blue-600 cursor-pointer"
                />
                <div className="mt-1 flex justify-between text-[10px] font-semibold text-slate-400">
                  <span>18 tuổi</span>
                  <span className="text-slate-500">Mặc định 18–30</span>
                  <span>50+</span>
                </div>
              </div>
            </div>
          </div>

          {/* Action Button */}
          <button
            onClick={handleStartMatching}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 py-3.5 text-sm font-extrabold text-white shadow-lg shadow-blue-500/30 transition hover:bg-blue-700 active:scale-95"
          >
            <Sparkles size={18} />
            <span>Bắt đầu tìm bạn mới</span>
            <ArrowRight size={16} />
          </button>
        </div>
      )}

      {chatState === 'WAITING' && (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <div className="relative flex h-36 w-36 items-center justify-center">
            <div className="absolute h-full w-full animate-ping rounded-full bg-blue-500/20" />
            <div className="absolute h-28 w-28 animate-pulse rounded-full bg-blue-500/30" />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-blue-600 text-white shadow-xl shadow-blue-500/40">
              <Search size={32} />
            </div>
          </div>
          <h2 className="mt-5 text-lg font-bold text-slate-800">Đang tìm người phù hợp...</h2>
          <span className="mt-1 font-mono text-base font-bold text-blue-600">
            {formatTime(secondsWaiting)}
          </span>
          <p className="mt-1 text-xs text-slate-400">
            Tiêu chí:{' '}
            {targetGender === 'ALL'
              ? 'Tất cả'
              : targetGender === 'FEMALE'
              ? 'Nữ'
              : targetGender === 'MALE'
              ? 'Nam'
              : 'Khác'}{' '}
            • 18 – {ageMax >= 50 ? '50+' : `${ageMax} tuổi`}
          </p>
          {secondsWaiting >= 6 && (
            <div className="mt-4 flex flex-col items-center rounded-2xl border border-blue-100 bg-blue-50/80 p-3.5 text-xs">
              <span className="font-semibold text-blue-900">Hàng chờ đang ít người phù hợp?</span>
              <button
                onClick={handleExpandFilter}
                className="mt-2 rounded-full bg-blue-600 px-4 py-1.5 text-[11px] font-bold text-white shadow-sm transition hover:bg-blue-700"
              >
                Mở rộng bộ lọc tìm kiếm
              </button>
            </div>
          )}
          <button
            onClick={handleCancelMatching}
            className="mt-6 text-xs font-semibold text-rose-500 hover:underline"
          >
            Hủy tìm kiếm
          </button>
        </div>
      )}

      {chatState === 'RECONNECTING' && (
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <WifiOff size={32} className="text-amber-500" />
          <p className="mt-3 text-sm font-semibold text-slate-700">Đang khôi phục kết nối…</p>
          <span className="mt-1 text-xs text-slate-500">Còn {reconnectCountdown} giây</span>
        </div>
      )}

      {(chatState === 'CHATTING' || chatState === 'ENDED') && (
        <div className="flex flex-1 flex-col justify-between overflow-hidden">
          <div className="flex shrink-0 items-center justify-between border-b border-slate-100 bg-white px-4 py-2.5">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">{partner?.nickname.slice(0, 2) || 'MT'}</div>
              <div><div className="flex items-center gap-1.5"><span className="text-xs font-bold text-slate-800">{partner?.nickname || 'Người lạ'}</span><span className="rounded-full bg-rose-50 px-1.5 py-0.2 text-[10px] font-bold text-rose-500">{partner?.gender === 'FEMALE' ? 'Nữ' : 'Nam'} • {partner?.age ?? '—'}t</span></div><span className="text-[10px] font-medium text-emerald-600">● {chatState === 'CHATTING' ? 'Đang trò chuyện' : 'Đã kết thúc'}</span></div>
            </div>
            {chatState === 'CHATTING' && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={sessionMedia.handleConsentToggle}
                  disabled={sessionMedia.mediaBusy}
                  title={sessionMedia.mediaConsent ? 'Đang bật nhận ảnh/video' : 'Bật/tắt quyền nhận media'}
                  className={`relative rounded-full p-2 transition ${
                    sessionMedia.mediaConsent ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  <ShieldCheck size={16} />
                  {sessionMedia.mediaConsent && (
                    <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500 shadow-sm" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={sessionMedia.handleAdultConsentToggle}
                  disabled={sessionMedia.mediaBusy}
                  aria-pressed={sessionMedia.myAdultConsent}
                  title={sessionMedia.myAdultConsent ? 'Đang bật nhận nội dung 18+' : 'Bật/tắt nhận nội dung 18+'}
                  className={`relative rounded-full p-2 transition ${
                    sessionMedia.myAdultConsent ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  <Flame size={16} />
                  {sessionMedia.myAdultConsent && (
                    <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-rose-500 shadow-sm" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleNextChat}
                  title="Chuyển người khác"
                  className="rounded-full bg-slate-100 p-2 text-slate-600 transition hover:bg-slate-200 active:scale-95"
                >
                  <RefreshCw size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setShowEndConfirm(true)}
                  title="Kết thúc chat"
                  className="rounded-full bg-rose-50 p-2 text-rose-600 transition hover:bg-rose-100 active:scale-95"
                >
                  <AlertTriangle size={16} />
                </button>
              </div>
            )}
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scrollContainerRef}
              onScroll={handleMessagesScroll}
              className="flex-1 space-y-3 overflow-y-auto p-4"
            >
              {messages.map((message) => (
                <div key={message.id} className={`flex flex-col ${message.sender === 'me' ? 'items-end' : 'items-start'}`}>
                  <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-xs ${message.sender === 'me' ? 'bg-blue-600 text-white shadow-sm' : 'border border-slate-100 bg-slate-100 text-slate-800'}`}>
                    {message.media ? (
                      <MediaAttachmentPreview
                        title={message.text}
                        mediaType={message.media.mediaType}
                        isAdult={message.media.isAdult}
                        isMine={message.sender === 'me'}
                        viewState={sessionMedia.mediaViews[message.id]}
                        revokedFallback={message.media.revoked}
                        busy={sessionMedia.mediaBusy}
                        audioExtra={
                          message.media.waveform ? (
                            <AudioWaveform samples={message.media.waveform} durationSec={message.media.durationSec} />
                          ) : null
                        }
                        onView={() => void sessionMedia.openMediaPreview(message.id, message.media!.mediaId, message.media!.contentType)}
                        onRevoke={() => {
                          if (!message.media || message.sender !== 'me') return;
                          void sessionMedia.revokeMediaPreview(message.id, message.media.mediaId);
                        }}
                      />
                    ) : message.text}
                  </div>
                  <span className="mt-0.5 px-1 text-[9px] text-slate-400">{message.time}</span>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {showNewMessageButton && (
              <button
                type="button"
                onClick={() => scrollToBottom('smooth')}
                className="absolute bottom-3 right-4 z-10 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-blue-600 px-3.5 py-2 text-xs font-bold text-white shadow-lg shadow-blue-500/30 transition hover:bg-blue-700"
              >
                <span>Tin mới ({unreadBelowCount})</span>
                <ArrowDown size={14} aria-hidden="true" />
              </button>
            )}
          </div>

          {chatState === 'ENDED' ? (
            <div className="flex flex-col gap-2.5 border-t border-slate-100 bg-white p-4">
              <p className="text-center text-xs font-medium text-slate-500">Cuộc trò chuyện đã kết thúc. Bạn có thể tìm người mới hoặc kết bạn.</p>
              <div className="flex items-center gap-2">
                <button onClick={handleNextChat} className="flex-1 rounded-full bg-blue-600 py-3 text-xs font-extrabold text-white shadow-md shadow-blue-500/25">Tìm người mới</button>
                <button onClick={handleSendFriendRequest} disabled={isFriendRequested} className={`flex flex-1 items-center justify-center gap-1 rounded-full border py-3 text-xs font-bold ${isFriendRequested ? 'border-emerald-200 bg-emerald-50 text-emerald-600' : 'border-slate-200 bg-slate-50 text-slate-700'}`}><UserPlus size={14} /><span>{isFriendRequested ? 'Đã gửi lời mời' : 'Kết bạn'}</span></button>
                <button onClick={handleReport} className="rounded-full bg-rose-50 px-3.5 py-3 text-xs font-bold text-rose-600">Báo cáo</button>
              </div>
            </div>
          ) : (
            <div className="border-t border-slate-100 bg-white">
              <div className="flex items-center justify-between border-b border-slate-50 px-3 py-1.5 text-[10px] text-slate-500">
                <span>
                  Media: {sessionMedia.partnerMediaConsent ? 'Đối phương bật nhận' : 'Đối phương tắt nhận'} ·{' '}
                  18+: {sessionMedia.partnerAdultConsent ? 'Đối phương đồng ý' : 'Chưa đồng ý 18+'}
                </span>
                <button
                  type="button"
                  onClick={() => sessionMedia.setSendAsAdult((prev) => !prev)}
                  aria-pressed={sessionMedia.sendAsAdult}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-bold transition ${
                    sessionMedia.sendAsAdult ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-300' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                  title="Đánh dấu ảnh/video sắp gửi là nội dung người lớn 18+"
                >
                  <Flame size={11} />
                  <span>{sessionMedia.sendAsAdult ? 'Đang bật gửi 18+' : 'Nội dung người lớn'}</span>
                </button>
              </div>
              <form onSubmit={handleSendMessage} className="flex items-center gap-1.5 p-2.5">
                <input ref={sessionMedia.mediaInputRef} type="file" accept={sessionMedia.sendAsAdult ? 'image/*,video/*' : 'image/*,audio/*,video/*'} onChange={sessionMedia.handleFileSelected} className="hidden" />
                <button
                  type="button"
                  onClick={() => sessionMedia.mediaInputRef.current?.click()}
                  disabled={sessionMedia.mediaBusy || sessionMedia.isRecording}
                  title={sessionMedia.sendAsAdult ? 'Gửi ảnh/video 18+ (cần đồng thuận 2 bên)' : 'Gửi ảnh/video; người nhận cần bật quyền nhận media'}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition hover:bg-slate-200 active:scale-95 disabled:opacity-40"
                >
                  <ImagePlus size={16} />
                </button>
              <button
                type="button"
                onClick={sessionMedia.handleToggleRecording}
                disabled={sessionMedia.mediaBusy}
                aria-label={sessionMedia.isRecording ? 'Dừng và gửi ghi âm' : 'Bắt đầu ghi âm'}
                title={sessionMedia.isRecording ? 'Dừng và gửi ghi âm' : 'Ghi âm; người nhận cần bật quyền nhận media'}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition active:scale-95 disabled:opacity-40 ${
                  sessionMedia.isRecording
                    ? 'animate-pulse bg-rose-600 text-white shadow-md shadow-rose-600/30'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <Mic size={16} />
              </button>
              {sessionMedia.isRecording ? (
                <div className="flex flex-1 items-center justify-between rounded-full bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-700 border border-rose-200">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 animate-ping rounded-full bg-rose-500" />
                    Đang ghi âm...
                  </span>
                  <span className="text-[11px] font-normal text-rose-500">Bấm mic để gửi</span>
                </div>
              ) : (
                <input
                  type="text"
                  placeholder="Nhập tin nhắn..."
                  value={inputMessage}
                  onChange={(event) => setInputMessage(event.target.value)}
                  className="flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs outline-none focus:border-blue-500"
                />
              )}
              <button
                type="submit"
                disabled={!inputMessage.trim() || sessionMedia.mediaBusy || sessionMedia.isRecording}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-md shadow-blue-500/25 transition hover:bg-blue-700 active:scale-95 disabled:opacity-40"
              >
                <Send size={15} />
              </button>
            </form>
            </div>
          )}
        </div>
      )}

      <AdultReceiveConsentModal
        open={sessionMedia.showAdultConsentModal}
        description="Bạn sắp cho phép đối phương gửi ảnh hoặc video nhạy cảm (18+) trong phiên trò chuyện này. Quyền này chỉ áp dụng riêng cho phiên hiện tại và có thể tắt bất kỳ lúc nào. Ảnh/video được đóng dấu truy vết theo tài khoản xem; tuy nhiên hệ thống không thể ngăn tuyệt đối thiết bị khác chụp màn hình và Quản trị viên có thể kiểm tra bằng chứng nếu có báo cáo vi phạm."
        ackLabel="Tôi xác nhận đã đọc cảnh báo an toàn 18+ và tự nguyện đồng ý nhận nội dung người lớn trong phiên này."
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

      {/* Confirmation Dialog: End Chat */}
      {showEndConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-xs rounded-3xl bg-white p-5 shadow-2xl">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
              <AlertTriangle size={24} />
            </div>
            <h3 className="mt-3 text-center text-sm font-bold text-slate-900">
              Kết thúc cuộc trò chuyện?
            </h3>
            <p className="mt-1.5 text-center text-[11.5px] leading-relaxed text-slate-500">
              Bạn vẫn có thể xem lại lịch sử trò chuyện trong vòng 7 ngày và gửi lời mời kết bạn từ tab{' '}
              <strong>Gần đây</strong>.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setShowEndConfirm(false)}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
              >
                Tiếp tục chat
              </button>
              <button
                type="button"
                onClick={handleEndChat}
                className="flex-1 rounded-xl bg-rose-600 py-2.5 text-xs font-bold text-white shadow-md shadow-rose-600/30 hover:bg-rose-700"
              >
                Kết thúc ngay
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

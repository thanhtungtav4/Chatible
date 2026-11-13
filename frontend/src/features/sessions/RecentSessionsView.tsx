import { useCallback, useEffect, useState } from 'react';
import { Ban, Check, ChevronDown, ChevronUp, Clock3, EyeOff, Lock, MessageSquareText, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../../api.js';

type RecentSession = {
  id: string;
  partnerName: string;
  partnerGender: string;
  partnerAge: number;
  messagesCount: number;
  endedAt: string;
  expiresAt: string;
  remainingDays: number;
  partnerId: string;
  isFriend?: boolean;
};

type SessionMessage = {
  id: string;
  senderId: string;
  messageType: string;
  content: string;
  sentAt: string;
};

type RecentSessionsViewProps = {
  onOpenChat: () => void;
  onOpenReport?: (request: { sessionId: string; reportedUserId: string; evidenceMessageIds: string[] }) => void;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Không rõ thời gian';
  return date.toLocaleDateString('vi-VN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function RecentSessionsView({ onOpenChat, onOpenReport }: RecentSessionsViewProps) {
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sendingPartnerIds, setSendingPartnerIds] = useState<Set<string>>(() => new Set());
  const [sentPartnerIds, setSentPartnerIds] = useState<Set<string>>(() => new Set());
  const [friendPartnerIds, setFriendPartnerIds] = useState<Set<string>>(() => new Set());
  const [friendRequestErrors, setFriendRequestErrors] = useState<Record<string, string>>({});
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Record<string, SessionMessage[]>>({});
  const [loadingMessagesId, setLoadingMessagesId] = useState<string | null>(null);
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<Record<string, Set<string>>>({});
  const [blockedPartnerIds, setBlockedPartnerIds] = useState<Set<string>>(() => new Set());
  const [blockingPartner, setBlockingPartner] = useState<{ id: string; name: string } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Stealth Vault state is server-backed. Never keep a PIN in browser storage.
  const [isStealthMode, setIsStealthMode] = useState(false);
  const [isStealthLoading, setIsStealthLoading] = useState(true);
  const [stealthConfigError, setStealthConfigError] = useState<string | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const loadStealthConfig = useCallback(async () => {
    setIsStealthLoading(true);
    setStealthConfigError(null);
    try {
      const response = await apiFetch('/api/v1/users/me/stealth-vault');
      const data = (await response.json().catch(() => ({}))) as {
        enabled?: boolean;
        unlocked?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || 'Không thể tải trạng thái Kho riêng tư.');
      const enabled = data.enabled === true;
      setIsStealthMode(enabled);
      setIsUnlocked(!enabled || data.unlocked === true);
    } catch (err) {
      // Fail closed: avoid fetching recent-session content while privacy state is unknown.
      setIsStealthMode(false);
      setIsUnlocked(false);
      setStealthConfigError(err instanceof Error ? err.message : 'Không thể tải trạng thái Kho riêng tư.');
    } finally {
      setIsStealthLoading(false);
    }
  }, []);

  const handleUnlockPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUnlocking(true);
    setPinError(null);
    try {
      const response = await apiFetch('/api/v1/users/me/stealth-vault/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinInput }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Không thể mở khóa Kho riêng tư.');
      setIsUnlocked(true);
      setPinInput('');
      setToastMsg('🔓 Đã mở khóa nhật ký trò chuyện!');
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'Mã PIN không chính xác.');
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleLockAgain = async () => {
    await apiFetch('/api/v1/users/me/stealth-vault/lock', { method: 'POST' }).catch(() => undefined);
    setIsUnlocked(false);
    setPinInput('');
    setPinError(null);
    setSessions([]);
    setSessionMessages({});
    setExpandedSessionId(null);
    setToastMsg('🔒 Đã khóa lại nhật ký trò chuyện.');
  };

  const loadSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/api/v1/sessions/recent');
      if (response.status === 423) {
        setIsStealthMode(true);
        setIsUnlocked(false);
        setSessions([]);
        setSessionMessages({});
        setExpandedSessionId(null);
        setPinError('Kho riêng tư đang khóa. Vui lòng nhập mã PIN.');
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as { sessions?: RecentSession[]; error?: string };
      if (!response.ok) throw new Error(payload.error || 'Không thể tải phiên gần đây.');
      const sessionList = Array.isArray(payload.sessions) ? payload.sessions : [];
      setSessions(sessionList);
      const friends = new Set<string>();
      for (const s of sessionList) {
        if (s.isFriend) friends.add(s.partnerId);
      }
      setFriendPartnerIds(friends);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể tải phiên gần đây.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleToggleTranscript = async (sessionId: string) => {
    if (expandedSessionId === sessionId) {
      setExpandedSessionId(null);
      return;
    }
    setExpandedSessionId(sessionId);
    if (sessionMessages[sessionId]) return;

    setLoadingMessagesId(sessionId);
    try {
      const response = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`);
      if (response.status === 423) {
        setIsStealthMode(true);
        setIsUnlocked(false);
        setSessions([]);
        setSessionMessages({});
        setExpandedSessionId(null);
        setPinError('Kho riêng tư đã khóa lại. Vui lòng nhập mã PIN.');
        return;
      }
      const data = (await response.json()) as { messages?: SessionMessage[]; error?: string };
      if (!response.ok) throw new Error(data.error || 'Không thể tải tin nhắn.');
      setSessionMessages((prev) => ({ ...prev, [sessionId]: Array.isArray(data.messages) ? data.messages : [] }));
    } catch (msgErr) {
      setFriendRequestErrors((prev) => ({
        ...prev,
        [sessionId]: msgErr instanceof Error ? msgErr.message : 'Không thể tải tin nhắn.',
      }));
    } finally {
      setLoadingMessagesId(null);
    }
  };

  const handleToggleEvidence = (sessionId: string, messageId: string) => {
    setSelectedEvidenceIds((prev) => {
      const current = new Set(prev[sessionId] || []);
      if (current.has(messageId)) current.delete(messageId);
      else current.add(messageId);
      return { ...prev, [sessionId]: current };
    });
  };

  const handleBlockPartner = (partnerId: string, partnerName: string) => {
    setBlockingPartner({ id: partnerId, name: partnerName });
  };

  const handleConfirmBlock = async () => {
    if (!blockingPartner) return;
    try {
      const response = await apiFetch('/api/v1/blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: blockingPartner.id }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Chặn thất bại.');
      setBlockedPartnerIds((prev) => new Set(prev).add(blockingPartner.id));
      setToastMsg(`Đã chặn ${blockingPartner.name || 'người dùng'}.`);
      setTimeout(() => setToastMsg(null), 3000);
    } catch (blockErr) {
      setToastMsg(blockErr instanceof Error ? blockErr.message : 'Chặn thất bại.');
      setTimeout(() => setToastMsg(null), 3000);
    } finally {
      setBlockingPartner(null);
    }
  };

  const handleReportSession = (session: RecentSession) => {
    if (!onOpenReport) {
      window.alert('Tính năng báo cáo chưa khả dụng.');
      return;
    }
    const selected = Array.from(selectedEvidenceIds[session.id] || []);
    const evidenceMessageIds = selected.length > 0
      ? selected
      : (sessionMessages[session.id] || []).map((m) => m.id);
    onOpenReport({
      sessionId: session.id,
      reportedUserId: session.partnerId,
      evidenceMessageIds,
    });
  };

  const sendFriendRequest = useCallback(async (partnerId: string) => {
    setSendingPartnerIds((current) => new Set(current).add(partnerId));
    setFriendRequestErrors((current) => {
      const next = { ...current };
      delete next[partnerId];
      return next;
    });

    try {
      const response = await apiFetch('/api/v1/friends/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: partnerId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        const errorText = payload.error || '';
        if (errorText === 'Hai bạn đã là bạn bè.' || errorText.includes('đã là bạn bè')) {
          setFriendPartnerIds((current) => new Set(current).add(partnerId));
          setFriendRequestErrors((current) => {
            const next = { ...current };
            delete next[partnerId];
            return next;
          });
          return;
        }
        throw new Error(payload.error || 'Không thể gửi lời mời kết bạn.');
      }
      setSentPartnerIds((current) => new Set(current).add(partnerId));
    } catch (requestError) {
      const errMsg = requestError instanceof Error ? requestError.message : 'Không thể gửi lời mời kết bạn.';
      if (errMsg === 'Hai bạn đã là bạn bè.' || errMsg.includes('đã là bạn bè')) {
        setFriendPartnerIds((current) => new Set(current).add(partnerId));
        setFriendRequestErrors((current) => {
          const next = { ...current };
          delete next[partnerId];
          return next;
        });
      } else {
        setFriendRequestErrors((current) => ({
          ...current,
          [partnerId]: errMsg,
        }));
      }
    } finally {
      setSendingPartnerIds((current) => {
        const next = new Set(current);
        next.delete(partnerId);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    void loadStealthConfig();
  }, [loadStealthConfig]);

  // Tự động khóa lại & ngụy trang ngay khi tắt màn hình, chuyển tab hoặc rời khỏi trang
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && isStealthMode && isUnlocked) {
        setIsUnlocked(false);
        setPinInput('');
        setSessions([]);
        setSessionMessages({});
        setExpandedSessionId(null);
        void apiFetch('/api/v1/users/me/stealth-vault/lock', {
          method: 'POST',
          keepalive: true,
        }).catch(() => undefined);
      }
    };

    const handlePageHide = () => {
      if (isStealthMode && isUnlocked) {
        setIsUnlocked(false);
        setPinInput('');
        setSessions([]);
        setSessionMessages({});
        setExpandedSessionId(null);
        void apiFetch('/api/v1/users/me/stealth-vault/lock', {
          method: 'POST',
          keepalive: true,
        }).catch(() => undefined);
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
      if (isStealthMode && isUnlocked) {
        void apiFetch('/api/v1/users/me/stealth-vault/lock', {
          method: 'POST',
          keepalive: true,
        }).catch(() => undefined);
      }
    };
  }, [isStealthMode, isUnlocked]);

  useEffect(() => {
    if (!isStealthLoading && !stealthConfigError && (!isStealthMode || isUnlocked)) {
      void loadSessions();
    }
  }, [isStealthLoading, stealthConfigError, isStealthMode, isUnlocked, loadSessions]);

  return (
    <section className="space-y-4 py-4" aria-labelledby="recent-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">Dấu vết cuộc trò chuyện</p>
          <h1 id="recent-title" className="mt-1 text-xl font-extrabold tracking-tight text-slate-900">Phiên gần đây</h1>
          <p className="mt-1 text-sm text-slate-500">Xem lại các phiên còn trong thời hạn lưu trữ.</p>
        </div>
        <div className="flex items-center gap-2">
          {isStealthMode && isUnlocked && (
            <button
              type="button"
              onClick={() => void handleLockAgain()}
              title="Khóa lại kho trò chuyện"
              className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-200"
            >
              <Lock size={13} />
              <span>Khóa</span>
            </button>
          )}
          <button type="button" onClick={() => void loadSessions()} disabled={isLoading || isStealthLoading || Boolean(stealthConfigError) || (isStealthMode && !isUnlocked)} className="rounded-full p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50" aria-label="Làm mới phiên gần đây">
            <RefreshCw size={17} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {isStealthLoading ? (
        <p className="rounded-2xl bg-slate-50 p-5 text-center text-sm text-slate-500" role="status">Đang kiểm tra Kho riêng tư…</p>
      ) : stealthConfigError ? (
        <div className="rounded-2xl border border-rose-100 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
          <p>{stealthConfigError}</p>
          <button type="button" onClick={() => void loadStealthConfig()} className="mt-2 font-semibold underline">Thử lại</button>
        </div>
      ) : isStealthMode && !isUnlocked ? (
        <div className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-50 to-amber-50/30 p-5 shadow-sm text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
              <EyeOff size={22} />
            </div>
            <h2 className="mt-3 text-base font-bold text-slate-800">Kho lưu trữ đã được ngụy trang</h2>
            <p className="mt-1 text-xs text-slate-500">
              Chế độ ngụy trang (Stealth Vault) đang bật. Nhập mã PIN 4 số để mở khóa nhật ký trò chuyện.
            </p>

            <form onSubmit={handleUnlockPin} className="mt-4 flex flex-col items-center gap-2">
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="• • • •"
                className="w-32 rounded-2xl border border-slate-200 bg-white py-2.5 text-center text-lg font-mono font-bold tracking-widest text-slate-900 shadow-inner outline-none focus:border-blue-500"
              />
              {pinError && <p className="text-xs font-semibold text-rose-600">{pinError}</p>}
              <button
                type="submit"
                disabled={pinInput.length !== 4 || isUnlocking}
                className="mt-1 rounded-full bg-blue-600 px-6 py-2 text-xs font-bold text-white shadow-md transition hover:bg-blue-700 disabled:opacity-40"
              >
                {isUnlocking ? 'Đang mở khóa…' : 'Mở khóa'}
              </button>
            </form>
          </div>

          {/* Decoy Notes */}
          <div className="space-y-2.5">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Ghi chú cá nhân</p>
            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
              <h3 className="text-xs font-bold text-slate-800">Danh mục mua sắm gia đình</h3>
              <p className="mt-1 text-[11px] text-slate-500">Sữa tươi không đường, bánh mì ngũ cốc, táo Fuji, dầu olive...</p>
              <span className="mt-2 block text-[10px] text-slate-400">Hôm nay lúc 09:15</span>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
              <h3 className="text-xs font-bold text-slate-800">Lịch trình làm việc tuần này</h3>
              <p className="mt-1 text-[11px] text-slate-500">Chuẩn bị tài liệu báo cáo quý, họp rà soát tiến độ với nhóm thiết kế...</p>
              <span className="mt-2 block text-[10px] text-slate-400">Hôm qua lúc 17:30</span>
            </div>
          </div>
        </div>
      ) : (
        <>
          {isLoading && <p className="rounded-2xl bg-slate-50 p-5 text-center text-sm text-slate-500" role="status">Đang tải phiên gần đây…</p>}
          {!isLoading && error && (
            <div className="rounded-2xl border border-rose-100 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
              <p>{error}</p>
              <button type="button" onClick={() => void loadSessions()} className="mt-2 font-semibold underline">Thử lại</button>
            </div>
          )}
          {!isLoading && !error && sessions.length === 0 && (
            <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50/70 px-6 py-10 text-center">
              <Clock3 className="mx-auto text-blue-500" size={30} />
              <h2 className="mt-3 text-sm font-bold text-slate-800">Chưa có phiên gần đây</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">Các phiên trò chuyện còn hạn sẽ xuất hiện ở đây.</p>
              <button type="button" onClick={onOpenChat} className="mt-4 rounded-full bg-blue-600 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-blue-700">Bắt đầu trò chuyện</button>
            </div>
          )}
          {!isLoading && !error && sessions.length > 0 && (
            <div className="space-y-3" role="list" aria-label="Các phiên gần đây">
          {sessions.map((session) => (
            <article key={session.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm" role="listitem">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 font-bold text-slate-600">
                  {(session.partnerName || '?').slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h2 className="truncate text-sm font-bold text-slate-900">{session.partnerName || 'Người lạ'}</h2>
                      <p className="mt-0.5 text-xs text-slate-500">{session.partnerAge} tuổi · {session.partnerGender}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-700">Còn {session.remainingDays} ngày</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500">
                    <span className="flex items-center gap-1.5"><MessageSquareText size={14} /> {session.messagesCount} tin nhắn</span>
                    <time className="flex items-center justify-end gap-1.5" dateTime={session.endedAt}><Clock3 size={14} /> {formatDate(session.endedAt)}</time>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {session.isFriend || friendPartnerIds.has(session.partnerId) ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">
                    <Check size={13} />
                    <span>Đã là bạn bè</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void sendFriendRequest(session.partnerId)}
                    disabled={sendingPartnerIds.has(session.partnerId) || sentPartnerIds.has(session.partnerId)}
                    className="rounded-full border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {sentPartnerIds.has(session.partnerId)
                      ? 'Đã gửi lời mời'
                      : sendingPartnerIds.has(session.partnerId)
                        ? 'Đang gửi…'
                        : 'Gửi lời mời kết bạn'}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void handleToggleTranscript(session.id)}
                  className="flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  {expandedSessionId === session.id ? (
                    <>
                      <span>Thu gọn</span>
                      <ChevronUp size={14} />
                    </>
                  ) : (
                    <>
                      <span>Xem tin nhắn</span>
                      <ChevronDown size={14} />
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => handleReportSession(session)}
                  className="flex items-center gap-1 rounded-full border border-rose-200 px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50"
                  title="Báo cáo phiên chat này"
                >
                  <ShieldAlert size={13} />
                  <span>
                    Báo cáo{' '}
                    {selectedEvidenceIds[session.id]?.size
                      ? `(${selectedEvidenceIds[session.id].size})`
                      : ''}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => handleBlockPartner(session.partnerId, session.partnerName)}
                  disabled={blockedPartnerIds.has(session.partnerId)}
                  className="flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                  title="Chặn tài khoản này"
                >
                  <Ban size={13} />
                  <span>{blockedPartnerIds.has(session.partnerId) ? 'Đã chặn' : 'Chặn'}</span>
                </button>
              </div>

              {expandedSessionId === session.id && (
                <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                  <div className="mb-2 flex items-center justify-between text-slate-500 font-semibold">
                    <span>Lịch sử tin nhắn (Giải mã qua KMS)</span>
                    {onOpenReport && (sessionMessages[session.id] || []).length > 0 && (
                      <span className="text-[11px] text-slate-400">Chọn tin để làm bằng chứng</span>
                    )}
                  </div>
                  {loadingMessagesId === session.id ? (
                    <p className="py-3 text-center text-slate-400">Đang giải mã tin nhắn…</p>
                  ) : (sessionMessages[session.id] || []).length === 0 ? (
                    <p className="py-2 text-center text-slate-400">Không có tin nhắn nào trong phiên này.</p>
                  ) : (
                    <div className="max-h-48 space-y-1.5 overflow-y-auto">
                      {(sessionMessages[session.id] || []).map((msg) => {
                        const isEvidence = selectedEvidenceIds[session.id]?.has(msg.id) ?? false;
                        return (
                          <div
                            key={msg.id}
                            onClick={() => handleToggleEvidence(session.id, msg.id)}
                            className={`flex cursor-pointer items-start gap-2 rounded-lg p-1.5 transition ${
                              isEvidence ? 'bg-rose-100/70 border border-rose-300' : 'hover:bg-slate-100/80'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isEvidence}
                              onChange={() => {}}
                              className="mt-0.5 h-3.5 w-3.5 rounded text-rose-600"
                            />
                            <div className="min-w-0 flex-1">
                              <span className="font-semibold text-slate-700">
                                {msg.senderId === session.partnerId ? session.partnerName : 'Bạn'}:{' '}
                              </span>
                              <span className="text-slate-800 break-words">{msg.content}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {friendRequestErrors[session.partnerId] && (
                <p className="mt-2 text-xs text-rose-600" role="alert">{friendRequestErrors[session.partnerId]}</p>
              )}
            </article>
          ))}
        </div>
          )}

          <div className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-500">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />
            <span>Phiên chat ngẫu nhiên đã kết thúc và còn hạn được hiển thị tại đây. Bạn có thể gửi lời mời kết bạn khi phiên vẫn còn hiệu lực.</span>
          </div>
        </>
      )}

      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-lg animate-fade-in">
          {toastMsg}
        </div>
      )}

      {/* Confirmation Modal: Block Partner */}
      {blockingPartner && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-xs rounded-3xl bg-white p-5 shadow-2xl">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
              <Ban size={24} />
            </div>
            <h3 className="mt-3 text-center text-sm font-bold text-slate-900">
              Chặn người dùng này?
            </h3>
            <p className="mt-1.5 text-center text-[11.5px] leading-relaxed text-slate-500">
              Bạn và <strong>{blockingPartner.name || 'người này'}</strong> sẽ không bao giờ được ghép đôi lại với nhau hoặc gửi tin nhắn cho nhau.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setBlockingPartner(null)}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={handleConfirmBlock}
                className="flex-1 rounded-xl bg-rose-600 py-2.5 text-xs font-bold text-white shadow-md shadow-rose-600/30 hover:bg-rose-700"
              >
                Xác nhận chặn
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

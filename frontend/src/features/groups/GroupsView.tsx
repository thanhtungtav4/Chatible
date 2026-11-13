import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SocketEvents } from '@chatible/shared';
import { ArrowLeft, Ban, Globe, Lock, Megaphone, RefreshCw, Send, ShieldAlert, Users } from 'lucide-react';
import { API_BASE_URL, apiFetch } from '../../api.js';
import type { ReportReason } from '../safety/ReportModal.js';
import { triggerPushNotification } from '../notifications/pushNotification.js';

type RoomType = 'BROADCAST' | 'PUBLIC' | 'PRIVATE_PASSCODE';

type CommunityRoom = {
  id: string;
  name: string;
  description: string | null;
  type: RoomType;
  memberCount: number;
  isJoined: boolean;
  isUnlocked: boolean;
  canPost: boolean;
  createdAt: string;
};

type CommunityMessage = {
  id: string;
  roomId: string;
  senderNickname: string;
  senderColor: string;
  isAdmin: boolean;
  isSelf: boolean;
  canReport?: boolean;
  messageType: string;
  content: string;
  sentAt: string;
};

const GROUP_REPORT_REASONS: Array<{ value: ReportReason; label: string }> = [
  { value: 'HARASSMENT', label: 'Quấy rối, xúc phạm hoặc lăng mạ' },
  { value: 'THREAT', label: 'Đe dọa bạo lực hoặc gây hại' },
  { value: 'UNDERAGE', label: 'Nghi ngờ dưới 18 tuổi' },
  { value: 'NONCONSENSUAL_MEDIA', label: 'Phát tán nội dung nhạy cảm trái phép' },
  { value: 'SPAM', label: 'Spam, quảng cáo hoặc lừa đảo' },
  { value: 'OTHER', label: 'Vi phạm khác' },
];

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

export function GroupsView({ currentUserId }: { currentUserId: string }) {
  const [rooms, setRooms] = useState<CommunityRoom[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CommunityMessage[]>([]);
  const [passcodeInput, setPasscodeInput] = useState('');
  const [draft, setDraft] = useState('');
  const [isLoadingRooms, setIsLoadingRooms] = useState(true);
  const [isLoadingMsgs, setIsLoadingMsgs] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [reportingMsg, setReportingMsg] = useState<CommunityMessage | null>(null);
  const [reportReason, setReportReason] = useState<ReportReason>('HARASSMENT');
  const [reportDesc, setReportDesc] = useState('');
  const [isModBusy, setIsModBusy] = useState(false);
  const [blockingMsg, setBlockingMsg] = useState<CommunityMessage | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const selectedRoom = useMemo(
    () => rooms.find((r) => r.id === selectedRoomId) || null,
    [rooms, selectedRoomId]
  );

  const loadRooms = useCallback(async () => {
    setIsLoadingRooms(true);
    setError(null);
    try {
      const res = await apiFetch('/api/v1/groups');
      const data = (await res.json().catch(() => ({}))) as { rooms?: CommunityRoom[]; error?: string };
      if (!res.ok) throw new Error(data.error || 'Không thể tải danh sách Nhóm & Kênh.');
      setRooms(Array.isArray(data.rooms) ? data.rooms : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi tải danh sách phòng.');
    } finally {
      setIsLoadingRooms(false);
    }
  }, []);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  useEffect(() => {
    const socket = io(API_BASE_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on(SocketEvents.GROUP_MESSAGE_RECEIVE, (incoming: CommunityMessage & { senderId?: string }) => {
      if (!selectedRoomId || incoming.roomId !== selectedRoomId) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === incoming.id)) return prev;
        return [
          ...prev,
          {
            ...incoming,
            isSelf: incoming.isSelf ?? incoming.senderId === currentUserId,
          },
        ];
      });

      const isSelf = incoming.isSelf ?? incoming.senderId === currentUserId;
      if (!isSelf) {
        const senderName = incoming.senderNickname || 'Thành viên';
        let preview = incoming.content || '';
        if (incoming.messageType === 'IMAGE') preview = '📷 Đã gửi một hình ảnh';
        else if (incoming.messageType === 'AUDIO') preview = '🎵 Đã gửi một đoạn ghi âm';
        else if (incoming.messageType === 'VIDEO') preview = '🎥 Đã gửi một video';

        const room = rooms.find((r) => r.id === incoming.roomId);
        const roomName = room ? room.name : 'Nhóm cộng đồng';

        void triggerPushNotification({
          type: 'GROUP',
          title: roomName,
          senderName,
          content: preview,
          tag: `group-${incoming.roomId}`,
        });
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [selectedRoomId, currentUserId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadMessagesForRoom = useCallback(async (roomId: string) => {
    setIsLoadingMsgs(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/groups/${encodeURIComponent(roomId)}/messages`);
      const data = (await res.json().catch(() => ({}))) as { messages?: CommunityMessage[]; error?: string };
      if (!res.ok) throw new Error(data.error || 'Không thể tải tin nhắn.');
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      socketRef.current?.emit(SocketEvents.GROUP_JOIN, { roomId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể mở phòng.');
    } finally {
      setIsLoadingMsgs(false);
    }
  }, []);

  const handleSelectRoom = async (room: CommunityRoom) => {
    setSelectedRoomId(room.id);
    setUnlockError(null);
    setError(null);
    setMessages([]);

    if (room.type === 'PRIVATE_PASSCODE' && !room.isUnlocked) {
      return;
    }

    if (!room.isJoined) {
      try {
        const joinRes = await apiFetch(`/api/v1/groups/${encodeURIComponent(room.id)}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!joinRes.ok) {
          const d = (await joinRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error || 'Không thể tham gia phòng.');
        }
        await loadRooms();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Lỗi tham gia.');
        return;
      }
    }

    await loadMessagesForRoom(room.id);
  };

  const handleUnlockPrivateRoom = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedRoom || !passcodeInput.trim()) return;
    setIsUnlocking(true);
    setUnlockError(null);
    try {
      const res = await apiFetch(`/api/v1/groups/${encodeURIComponent(selectedRoom.id)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: passcodeInput.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { unlocked?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error || 'Mật khẩu không chính xác.');
      setPasscodeInput('');
      await loadRooms();
      await loadMessagesForRoom(selectedRoom.id);
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : 'Không thể mở khóa nhóm.');
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedRoom || !draft.trim() || isSending) return;
    setIsSending(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/groups/${encodeURIComponent(selectedRoom.id)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft.trim(), type: 'TEXT' }),
      });
      const data = (await res.json().catch(() => ({}))) as CommunityMessage & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Không gửi được tin.');
      setDraft('');
      setMessages((prev) => (prev.some((m) => m.id === data.id) ? prev : [...prev, data]));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi gửi tin.');
    } finally {
      setIsSending(false);
    }
  };

  const handleSubmitGroupReport = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedRoom || !reportingMsg || isModBusy) return;
    setIsModBusy(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/v1/groups/${encodeURIComponent(selectedRoom.id)}/messages/${encodeURIComponent(reportingMsg.id)}/report`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason: reportReason,
            description: reportDesc.trim() || undefined,
          }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Không thể gửi báo cáo.');
      setReportingMsg(null);
      setReportDesc('');
      setToastMsg('Đã gửi báo cáo lên quản trị viên và ẩn tin nhắn từ tài khoản này.');
      setTimeout(() => setToastMsg(null), 3500);
      await loadMessagesForRoom(selectedRoom.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi gửi báo cáo.');
    } finally {
      setIsModBusy(false);
    }
  };

  const handleConfirmGroupBlock = async () => {
    if (!selectedRoom || !blockingMsg || isModBusy) return;
    setIsModBusy(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/v1/groups/${encodeURIComponent(selectedRoom.id)}/messages/${encodeURIComponent(blockingMsg.id)}/block`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Không thể chặn thành viên này.');
      setBlockingMsg(null);
      setToastMsg('Đã chặn thành viên — tin nhắn từ họ đã bị ẩn khỏi nhóm.');
      setTimeout(() => setToastMsg(null), 3500);
      await loadMessagesForRoom(selectedRoom.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi chặn thành viên.');
    } finally {
      setIsModBusy(false);
    }
  };

  const renderRoomBadge = (type: RoomType) => {
    if (type === 'BROADCAST') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
          <Megaphone size={11} /> Kênh Thông Báo
        </span>
      );
    }
    if (type === 'PRIVATE_PASSCODE') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-700">
          <Lock size={11} /> Mật Khẩu
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
        <Globe size={11} /> Công Khai
      </span>
    );
  };

  if (selectedRoom) {
    const lockedPrivate = selectedRoom.type === 'PRIVATE_PASSCODE' && !selectedRoom.isUnlocked;

    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3 pt-1">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => {
                socketRef.current?.emit(SocketEvents.GROUP_LEAVE, { roomId: selectedRoom.id });
                setSelectedRoomId(null);
              }}
              className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100"
            >
              <ArrowLeft size={18} />
            </button>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold text-slate-900">{selectedRoom.name}</h2>
              <div className="mt-0.5 flex items-center gap-2">{renderRoomBadge(selectedRoom.type)}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadMessagesForRoom(selectedRoom.id)}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="Làm mới"
          >
            <RefreshCw size={15} />
          </button>
        </div>

        {lockedPrivate ? (
          <div className="flex flex-1 flex-col items-center justify-center p-5 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
              <Lock size={24} />
            </div>
            <h3 className="mt-3 text-sm font-bold text-slate-900">Nhóm Bảo Mật Bằng Mật Khẩu</h3>
            <p className="mt-1 text-xs text-slate-500">
              Nhập đúng mã passcode từ người quản trị để mở khóa đọc và gửi tin nhắn.
            </p>
            <form onSubmit={handleUnlockPrivateRoom} className="mt-4 flex w-full max-w-xs flex-col gap-2">
              <input
                type="password"
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
                placeholder="Nhập mã mật khẩu phòng…"
                required
                className="rounded-xl border border-slate-200 px-3.5 py-2.5 text-center text-sm font-bold text-slate-900 outline-none focus:border-indigo-500"
              />
              {unlockError && <p className="text-xs font-semibold text-rose-600">{unlockError}</p>}
              <button
                type="submit"
                disabled={isUnlocking || !passcodeInput.trim()}
                className="rounded-xl bg-indigo-600 py-2.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {isUnlocking ? 'Đang xác thực…' : 'Mở khóa tham gia'}
              </button>
            </form>
          </div>
        ) : (
          <>
            {error && (
              <div className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</div>
            )}
            <div className="flex-1 space-y-3 overflow-y-auto py-3">
              {isLoadingMsgs ? (
                <p className="py-8 text-center text-xs text-slate-400">Đang tải tin nhắn…</p>
              ) : messages.length === 0 ? (
                <p className="py-8 text-center text-xs text-slate-400">Chưa có tin nhắn nào trong phòng này.</p>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={`flex flex-col ${msg.isSelf ? 'items-end' : 'items-start'}`}>
                    <div className="mb-1 flex items-center gap-1.5 px-1">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: msg.senderColor }}
                      />
                      <span className="text-[10px] font-bold text-slate-600">
                        {msg.senderNickname}
                        {msg.isAdmin && ' (Admin)'}
                      </span>
                    </div>
                    <div
                      className={`max-w-[82%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed ${
                        msg.isSelf
                          ? 'bg-blue-600 text-white'
                          : msg.isAdmin
                            ? 'border border-amber-200 bg-amber-50 text-amber-950'
                            : 'border border-slate-100 bg-slate-100 text-slate-800'
                      }`}
                    >
                      {msg.content}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 px-1 text-[9px] text-slate-400">
                      <span>{formatTime(msg.sentAt)}</span>
                      {!msg.isSelf && !msg.isAdmin && msg.canReport !== false && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setReportingMsg(msg);
                              setReportReason('HARASSMENT');
                              setReportDesc('');
                            }}
                            className="inline-flex items-center gap-0.5 font-semibold text-rose-500 hover:underline"
                          >
                            <ShieldAlert size={10} /> Báo cáo
                          </button>
                          <button
                            type="button"
                            onClick={() => setBlockingMsg(msg)}
                            className="inline-flex items-center gap-0.5 font-semibold text-slate-500 hover:underline"
                          >
                            <Ban size={10} /> Chặn
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {selectedRoom.type === 'BROADCAST' && !selectedRoom.canPost ? (
              <div className="border-t border-slate-100 bg-amber-50/70 px-3 py-2.5 text-center text-[11px] font-semibold text-amber-800">
                📢 Kênh thông báo một chiều — Chỉ Quản trị viên có quyền đăng tin.
              </div>
            ) : (
              <form onSubmit={handleSendMessage} className="flex items-center gap-2 border-t border-slate-100 pt-2.5">
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Nhắn tin vào nhóm…"
                  maxLength={4000}
                  className="flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-900 outline-none focus:border-blue-500 focus:bg-white"
                />
                <button
                  type="submit"
                  disabled={isSending || !draft.trim()}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-white disabled:opacity-50"
                >
                  <Send size={15} />
                </button>
              </form>
            )}
          </>
        )}
        {toastMsg && (
          <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-lg">
            {toastMsg}
          </div>
        )}

        {reportingMsg && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
            <form onSubmit={(e) => void handleSubmitGroupReport(e)} className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl space-y-3">
              <div className="flex items-center gap-2 text-rose-600">
                <ShieldAlert size={20} />
                <h3 className="text-sm font-bold text-slate-900">Báo cáo tin nhắn nhóm</h3>
              </div>
              <p className="rounded-xl bg-slate-50 p-2.5 text-[11px] text-slate-600 line-clamp-2">
                <strong>{reportingMsg.senderNickname}:</strong> {reportingMsg.content}
              </p>
              <div className="space-y-1.5">
                {GROUP_REPORT_REASONS.map((opt) => (
                  <label key={opt.value} className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-100 p-2 text-xs text-slate-700 hover:bg-slate-50">
                    <input
                      type="radio"
                      name="grp-report-reason"
                      checked={reportReason === opt.value}
                      onChange={() => setReportReason(opt.value)}
                      className="text-rose-600"
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
              <textarea
                rows={2}
                value={reportDesc}
                onChange={(e) => setReportDesc(e.target.value)}
                placeholder="Mô tả thêm (tùy chọn)..."
                maxLength={500}
                className="w-full rounded-xl border border-slate-200 p-2 text-xs text-slate-800 outline-none focus:border-blue-500"
              />
              <p className="text-[10px] text-slate-400">
                Hệ thống sẽ đóng băng bằng chứng cho Quản trị viên xử lý và tự động chặn thành viên này khỏi luồng hiển thị của bạn.
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setReportingMsg(null)} disabled={isModBusy} className="flex-1 rounded-xl border border-slate-200 py-2 text-xs font-bold text-slate-600">Hủy</button>
                <button type="submit" disabled={isModBusy} className="flex-1 rounded-xl bg-rose-600 py-2 text-xs font-bold text-white disabled:opacity-50">Gửi báo cáo</button>
              </div>
            </form>
          </div>
        )}

        {blockingMsg && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
            <div className="w-full max-w-xs rounded-3xl bg-white p-5 shadow-2xl">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
                <Ban size={24} />
              </div>
              <h3 className="mt-3 text-center text-sm font-bold text-slate-900">Chặn thành viên {blockingMsg.senderNickname}?</h3>
              <p className="mt-1.5 text-center text-[11px] leading-relaxed text-slate-500">
                Mọi tin nhắn của người này trong nhóm và tính năng ghép đôi 1-1 sẽ bị ẩn khỏi bạn ngay lập tức.
              </p>
              <div className="mt-4 flex gap-2">
                <button type="button" onClick={() => setBlockingMsg(null)} disabled={isModBusy} className="flex-1 rounded-xl border border-slate-200 py-2 text-xs font-bold text-slate-600">Hủy</button>
                <button type="button" onClick={() => void handleConfirmGroupBlock()} disabled={isModBusy} className="flex-1 rounded-xl bg-rose-600 py-2 text-xs font-bold text-white disabled:opacity-50">Xác nhận chặn</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 py-2">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-extrabold text-slate-900">Kênh & Nhóm Cộng Đồng</h1>
          <p className="text-xs text-slate-500">Thông báo chính thức, phòng chat mở & nhóm bảo mật</p>
        </div>
        <button
          type="button"
          onClick={() => void loadRooms()}
          className="rounded-full bg-slate-100 p-2 text-slate-500 hover:bg-slate-200"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      {error && <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</div>}

      {isLoadingRooms ? (
        <p className="py-10 text-center text-xs text-slate-400">Đang tải danh sách phòng…</p>
      ) : rooms.length === 0 ? (
        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-6 text-center">
          <Users className="mx-auto text-slate-400" size={28} />
          <p className="mt-2 text-xs text-slate-500">Chưa có kênh hoặc nhóm cộng đồng nào.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              onClick={() => void handleSelectRoom(room)}
              className="flex w-full items-start justify-between rounded-2xl border border-slate-100 bg-white p-3.5 text-left shadow-sm transition hover:border-blue-200 hover:bg-blue-50/20"
            >
              <div className="min-w-0 flex-1 pr-3">
                <div className="flex items-center gap-2">{renderRoomBadge(room.type)}</div>
                <h2 className="mt-1.5 truncate text-sm font-bold text-slate-900">{room.name}</h2>
                {room.description && (
                  <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{room.description}</p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <span className="text-[11px] font-semibold text-slate-400">{room.memberCount} thành viên</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

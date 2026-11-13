import React, { useState, useRef } from 'react';
import { BookOpen, FileText, Lock, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../../api.js';
import { triggerHaptic } from '../mobile/haptic.js';

interface StealthCamouflageScreenProps {
  onUnlock: () => void;
}

export function StealthCamouflageScreen({ onUnlock }: StealthCamouflageScreenProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePinSubmit = async (enteredPin: string) => {
    if (enteredPin.length !== 4 || isVerifying) return;
    setIsVerifying(true);
    setError(null);
    try {
      const res = await apiFetch('/api/v1/users/me/stealth-vault/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: enteredPin }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Mã PIN không chính xác.');
      }
      triggerHaptic('success');
      onUnlock();
    } catch (err) {
      triggerHaptic('error');
      setError(err instanceof Error ? err.message : 'Mã PIN không chính xác.');
      setPin('');
      inputRef.current?.focus();
    } finally {
      setIsVerifying(false);
    }
  };

  const handlePinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const clean = e.target.value.replace(/\D/g, '').slice(0, 4);
    setPin(clean);
    setError(null);
    if (clean.length === 4) {
      void handlePinSubmit(clean);
    }
  };

  const decoyNotes = [
    {
      id: '1',
      title: 'Danh mục mua sắm gia đình',
      preview: 'Sữa tươi không đường 2L, bánh mì ngũ cốc nguyên hạt, táo Fuji giòn, dầu olive ép lạnh, trà thảo mộc hoa cúc...',
      time: 'Hôm nay lúc 08:30',
      tag: 'Cá nhân',
    },
    {
      id: '2',
      title: 'Kế hoạch & Lịch công việc tuần này',
      preview: 'Hoàn thiện tài liệu báo cáo quý, họp rà soát tiến độ thiết kế UI/UX với team frontend, gửi email tổng kết cho đối tác...',
      time: 'Hôm qua lúc 17:15',
      tag: 'Công việc',
    },
    {
      id: '3',
      title: 'Ý tưởng học tập & đọc sách',
      preview: 'Đọc tiếp chương 4 cuốn Atomic Habits - Thay đổi thói quen nhỏ. Ghi chép áp dụng phương pháp Pomodoro 25/5 trong giờ làm việc...',
      time: '2 ngày trước',
      tag: 'Học tập',
    },
    {
      id: '4',
      title: 'Lịch tập thể dục & chạy bộ',
      preview: 'Chạy bộ 5km công viên buổi sáng các ngày 2-4-6. Uống đủ 2 lít nước mỗi ngày, hạn chế đồ ngọt sau 20h tối...',
      time: '3 ngày trước',
      tag: 'Sức khỏe',
    },
  ];

  const filteredNotes = searchQuery.trim()
    ? decoyNotes.filter(
        (n) =>
          n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          n.preview.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : decoyNotes;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-slate-50 text-slate-800 animate-in fade-in duration-150">
      {/* Camouflage Note Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200/80 bg-white px-4 py-3 shadow-xs">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-700">
            <BookOpen size={18} />
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-900 leading-tight">Ghi chú cá nhân</h1>
            <span className="text-[10px] text-slate-400 font-medium">Đồng bộ ngoại tuyến</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-500">
          <Lock size={12} className="text-slate-400" />
          <span>Riêng tư</span>
        </div>
      </div>

      {/* Camouflage Search Bar */}
      <div className="p-3 bg-white border-b border-slate-100">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Tìm kiếm trong ghi chú..."
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 placeholder-slate-400 outline-none focus:border-amber-500 focus:bg-white"
        />
      </div>

      {/* Camouflage Decoy Notes List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {filteredNotes.map((note) => (
          <div key={note.id} className="rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-2xs hover:border-slate-300 transition">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-bold text-slate-900 line-clamp-1">{note.title}</h2>
              <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500">
                {note.tag}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500 line-clamp-2">{note.preview}</p>
            <div className="mt-2.5 flex items-center justify-between text-[10px] text-slate-400">
              <span>{note.time}</span>
              <FileText size={12} />
            </div>
          </div>
        ))}
      </div>

      {/* Subtle Bottom PIN Unlock Pad */}
      <div className="shrink-0 border-t border-slate-200 bg-white p-4 shadow-lg">
        <div className="mx-auto flex max-w-[280px] flex-col items-center">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
            <ShieldCheck size={15} className="text-indigo-600" />
            <span>Mở khóa ứng dụng</span>
          </div>
          <p className="mt-0.5 text-center text-[10.5px] text-slate-400">
            Nhập mã PIN 4 số để trở lại Chatible
          </p>

          <form onSubmit={(e) => { e.preventDefault(); void handlePinSubmit(pin); }} className="mt-3 flex flex-col items-center gap-2 w-full">
            <input
              ref={inputRef}
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              autoFocus
              onChange={handlePinChange}
              placeholder="• • • •"
              className="w-32 rounded-2xl border border-slate-300 bg-slate-50 py-2 text-center font-mono text-xl font-extrabold tracking-[0.4em] text-slate-900 shadow-inner outline-none focus:border-indigo-600 focus:bg-white"
            />
            {error && <p className="text-[11px] font-semibold text-rose-600">{error}</p>}
            {isVerifying && <p className="text-[11px] font-semibold text-indigo-600 animate-pulse">Đang xác thực…</p>}
          </form>
        </div>
      </div>
    </div>
  );
}

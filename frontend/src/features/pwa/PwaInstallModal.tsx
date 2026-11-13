import React from 'react';
import { Smartphone, Share, PlusSquare, MoreVertical, X, Sparkles, CheckCircle2 } from 'lucide-react';

interface PwaInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  isIOS: boolean;
  canPromptNative: boolean;
  onPromptNative: () => void;
}

export function PwaInstallModal({
  isOpen,
  onClose,
  isIOS,
  canPromptNative,
  onPromptNative,
}: PwaInstallModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4 backdrop-blur-sm animate-fade-in">
      <div
        className="w-full max-w-md rounded-t-3xl sm:rounded-3xl bg-white p-6 shadow-2xl transition-all"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pwa-install-title"
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-md shadow-blue-500/20">
              <img src="/favicon.svg" alt="Chatible" className="h-7 w-7" />
            </div>
            <div>
              <h3 id="pwa-install-title" className="text-base font-bold text-slate-900 flex items-center gap-1.5">
                Cài đặt Chatible (Shortapp)
                <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                  <Sparkles size={11} className="mr-0.5" /> Web App
                </span>
              </h3>
              <p className="text-xs text-slate-500">Mở toàn màn hình không có thanh URL trình duyệt</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 space-y-3.5">
          {canPromptNative ? (
            <div className="space-y-4">
              <div className="rounded-2xl bg-blue-50/60 p-4 border border-blue-100">
                <div className="flex items-center gap-2 text-xs font-semibold text-blue-900 mb-1">
                  <CheckCircle2 size={16} className="text-blue-600 shrink-0" />
                  Sẵn sàng thêm vào màn hình chính
                </div>
                <p className="text-xs text-blue-800 leading-relaxed">
                  Thiết bị của bạn hỗ trợ cài đặt ứng dụng trực tiếp chỉ với 1 chạm. Bấm nút bên dưới để tạo Shortapp.
                </p>
              </div>

              <button
                type="button"
                onClick={onPromptNative}
                className="w-full rounded-2xl bg-blue-600 py-3 px-4 text-sm font-bold text-white shadow-lg shadow-blue-500/25 hover:bg-blue-700 active:scale-[0.99] transition"
              >
                Cài đặt Chatible ngay
              </button>
            </div>
          ) : isIOS ? (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-slate-700">
                Để tạo Shortapp trên iPhone / iPad (Safari):
              </p>

              <div className="space-y-2.5 text-xs text-slate-600">
                <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 border border-slate-100">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white shadow-sm border border-slate-200 text-blue-600 shrink-0">
                    <Share size={16} />
                  </div>
                  <div>
                    <span className="font-bold text-slate-800">Bước 1:</span> Bấm vào nút <strong>Chia sẻ (Share)</strong> ở thanh dưới trình duyệt Safari.
                  </div>
                </div>

                <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 border border-slate-100">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white shadow-sm border border-slate-200 text-blue-600 shrink-0">
                    <PlusSquare size={16} />
                  </div>
                  <div>
                    <span className="font-bold text-slate-800">Bước 2:</span> Cuộn xuống và chọn <strong>"Thêm vào MH chính" (Add to Home Screen)</strong>.
                  </div>
                </div>

                <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 border border-slate-100">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white shadow-sm border border-slate-200 text-emerald-600 shrink-0">
                    <Smartphone size={16} />
                  </div>
                  <div>
                    <span className="font-bold text-slate-800">Bước 3:</span> Bấm <strong>"Thêm" (Add)</strong> ở góc trên bên phải để hoàn tất.
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-slate-700">
                Cách thêm vào màn hình chính:
              </p>

              <div className="space-y-2.5 text-xs text-slate-600">
                <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 border border-slate-100">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white shadow-sm border border-slate-200 text-slate-700 shrink-0">
                    <MoreVertical size={16} />
                  </div>
                  <div>
                    <span className="font-bold text-slate-800">Bước 1:</span> Nhấn vào biểu tượng <strong>Menu ⋮ (3 chấm)</strong> ở góc trên trình duyệt.
                  </div>
                </div>

                <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 border border-slate-100">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white shadow-sm border border-slate-200 text-blue-600 shrink-0">
                    <Smartphone size={16} />
                  </div>
                  <div>
                    <span className="font-bold text-slate-800">Bước 2:</span> Chọn <strong>"Cài đặt ứng dụng"</strong> hoặc <strong>"Thêm vào màn hình chính"</strong>.
                  </div>
                </div>

                <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 border border-slate-100">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white shadow-sm border border-slate-200 text-emerald-600 shrink-0">
                    <CheckCircle2 size={16} />
                  </div>
                  <div>
                    <span className="font-bold text-slate-800">Bước 3:</span> Xác nhận để biểu tượng Chatible xuất hiện ngoài màn hình chính.
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-100 transition"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

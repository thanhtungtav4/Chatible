import { useState, type FormEvent } from 'react';
import { AlertOctagon, CheckCircle2, ShieldAlert, X } from 'lucide-react';
import { apiFetch } from '../../api.js';

export type ReportReason =
  | 'UNDERAGE'
  | 'HARASSMENT'
  | 'NONCONSENSUAL_MEDIA'
  | 'THREAT'
  | 'SPAM'
  | 'OTHER';

interface ReasonOption {
  value: ReportReason;
  label: string;
  description: string;
  icon: string;
}

const REASONS: ReasonOption[] = [
  {
    value: 'UNDERAGE',
    label: 'Chưa đủ 18 tuổi',
    description: 'Nghi vấn người này chưa đủ tuổi thành niên tham gia nền tảng',
    icon: '🔞',
  },
  {
    value: 'HARASSMENT',
    label: 'Quấy rối / Xúc phạm',
    description: 'Ngôn từ thù địch, lăng mạ, bắt nạt hoặc quấy rối',
    icon: '⚠️',
  },
  {
    value: 'NONCONSENSUAL_MEDIA',
    label: 'Media nhạy cảm không đồng thuận',
    description: 'Gửi hình ảnh, âm thanh hoặc video nhạy cảm trái phép',
    icon: '🚫',
  },
  {
    value: 'THREAT',
    label: 'Đe dọa / Tống tiền',
    description: 'Đe dọa bạo lực, đe dọa an toàn hoặc tống tiền',
    icon: '⚡',
  },
  {
    value: 'SPAM',
    label: 'Spam / Lừa đảo',
    description: 'Phát tán tin nhắn rác, quảng cáo hoặc lừa đảo tài chính',
    icon: '📢',
  },
  {
    value: 'OTHER',
    label: 'Lý do khác',
    description: 'Hành vi vi phạm tiêu chuẩn cộng đồng khác',
    icon: '💬',
  },
];

export interface ReportModalProps {
  isOpen: boolean;
  sessionId: string;
  reportedUserId: string;
  reportedUserName?: string;
  evidenceMessageIds?: string[];
  onClose: () => void;
  onSuccess?: () => void;
}

export function ReportModal({
  isOpen,
  sessionId,
  reportedUserId,
  reportedUserName,
  evidenceMessageIds = [],
  onClose,
  onSuccess,
}: ReportModalProps) {
  const [selectedReason, setSelectedReason] = useState<ReportReason>('HARASSMENT');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const response = await apiFetch('/api/v1/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          reportedUserId,
          reason: selectedReason,
          description: description.trim() || undefined,
          evidenceMessages: evidenceMessageIds.map((messageId) => ({ messageId })),
        }),
      });

      const data = (await response.json()) as { reportId?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error || 'Không thể gửi báo cáo.');
      }

      setIsSuccess(true);
      setTimeout(() => {
        setIsSuccess(false);
        setDescription('');
        onSuccess?.();
        onClose();
      }, 1500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Không thể gửi báo cáo.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-modal-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-rose-50 text-rose-600">
              <ShieldAlert size={20} />
            </div>
            <div>
              <h2 id="report-modal-title" className="text-sm font-bold text-slate-900">
                Báo cáo vi phạm an toàn
              </h2>
              <p className="text-[11px] text-slate-500">
                Đối tượng:{' '}
                <strong className="text-slate-700">
                  {reportedUserName || 'Người lạ'}
                </strong>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Đóng"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        {isSuccess ? (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <CheckCircle2 size={48} className="text-emerald-500" />
            <h3 className="mt-3 text-base font-bold text-slate-900">
              Đã gửi báo cáo thành công
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Bằng chứng đã được đóng băng an toàn qua KMS và chuyển đến Quản trị viên xử lý.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {errorMsg && (
                <div className="flex items-center gap-2 rounded-xl bg-rose-50 p-3 text-xs text-rose-700">
                  <AlertOctagon size={16} className="shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* Reasons */}
              <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  Chọn lý do vi phạm chính
                </label>
                <div className="mt-2 space-y-2">
                  {REASONS.map((reason) => {
                    const isSelected = selectedReason === reason.value;
                    return (
                      <button
                        key={reason.value}
                        type="button"
                        onClick={() => setSelectedReason(reason.value)}
                        className={`flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition ${
                          isSelected
                            ? 'border-rose-400 bg-rose-50/60 ring-2 ring-rose-300'
                            : 'border-slate-200 bg-white hover:border-slate-300'
                        }`}
                      >
                        <span className="text-xl">{reason.icon}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-bold text-slate-800">
                            {reason.label}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {reason.description}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Description */}
              <div>
                <label
                  htmlFor="report-description"
                  className="text-[11px] font-bold uppercase tracking-wider text-slate-500"
                >
                  Mô tả chi tiết (Tùy chọn)
                </label>
                <textarea
                  id="report-description"
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Cung cấp thêm ngữ cảnh sự việc nếu có..."
                  className="mt-1.5 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-800 outline-none transition focus:border-rose-500 focus:bg-white"
                />
              </div>

              {/* Evidence Info Pill */}
              <div className="rounded-2xl border border-blue-100 bg-blue-50/80 p-3 text-[11px] leading-relaxed text-blue-900">
                🔒 <strong>Bảo toàn chứng cứ KMS:</strong>{' '}
                {evidenceMessageIds.length > 0 ? (
                  <span>
                    <strong>{evidenceMessageIds.length}</strong> tin nhắn đã được đính kèm làm
                    bằng chứng giải mã độc quyền.
                  </span>
                ) : (
                  <span>
                    Toàn bộ ngữ cảnh phiên chat hiện tại sẽ được bảo lưu phục vụ phân xử.
                  </span>
                )}
              </div>
            </div>

            {/* Footer Actions */}
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="rounded-full px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100"
              >
                Hủy bỏ
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex items-center gap-1.5 rounded-full bg-rose-600 px-5 py-2 text-xs font-bold text-white shadow-md shadow-rose-600/30 transition hover:bg-rose-700 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <span>Đang gửi...</span>
                ) : (
                  <>
                    <ShieldAlert size={14} />
                    <span>Gửi báo cáo ngay</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

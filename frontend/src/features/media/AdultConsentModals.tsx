import { AlertTriangle, Flame } from 'lucide-react';

interface AdultReceiveConsentModalProps {
  open: boolean;
  description: string;
  ackLabel: string;
  adultPolicyAck: boolean;
  busy: boolean;
  onAckChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function AdultReceiveConsentModal({
  open,
  description,
  ackLabel,
  adultPolicyAck,
  busy,
  onAckChange,
  onCancel,
  onConfirm,
}: AdultReceiveConsentModalProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
          <Flame size={24} />
        </div>
        <h3 className="mt-3 text-center text-sm font-bold text-slate-900">
          Bật quyền nhận nội dung 18+?
        </h3>
        <p className="mt-2 text-[11.5px] leading-relaxed text-slate-600">
          {description}
        </p>
        <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-xl bg-slate-50 p-2.5 text-[11px] text-slate-700">
          <input
            type="checkbox"
            checked={adultPolicyAck}
            onChange={(event) => onAckChange(event.target.checked)}
            className="mt-0.5 rounded text-rose-600 focus:ring-rose-500"
          />
          <span>{ackLabel}</span>
        </label>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
          >
            Hủy bỏ
          </button>
          <button
            type="button"
            disabled={!adultPolicyAck || busy}
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-rose-600 py-2.5 text-xs font-bold text-white shadow-md shadow-rose-600/30 hover:bg-rose-700 disabled:opacity-50"
          >
            Đồng ý bật 18+
          </button>
        </div>
      </div>
    </div>
  );
}

interface AdultSenderCommitmentsModalProps {
  open: boolean;
  confirm18Plus: boolean;
  confirmConsent: boolean;
  busy: boolean;
  onConfirm18PlusChange: (checked: boolean) => void;
  onConfirmConsentChange: (checked: boolean) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function AdultSenderCommitmentsModal({
  open,
  confirm18Plus,
  confirmConsent,
  busy,
  onConfirm18PlusChange,
  onConfirmConsentChange,
  onCancel,
  onSubmit,
}: AdultSenderCommitmentsModalProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <AlertTriangle size={24} />
        </div>
        <h3 className="mt-3 text-center text-sm font-bold text-slate-900">
          Xác nhận trước khi gửi nội dung 18+
        </h3>
        <p className="mt-1.5 text-center text-[11px] text-slate-500">
          Yêu cầu bắt buộc theo chính sách an toàn trước khi mã hóa và tải tệp lên.
        </p>
        <div className="mt-3 space-y-2 text-[11px] text-slate-700">
          <label className="flex cursor-pointer items-start gap-2 rounded-xl bg-slate-50 p-2.5">
            <input
              type="checkbox"
              checked={confirm18Plus}
              onChange={(event) => onConfirm18PlusChange(event.target.checked)}
              className="mt-0.5 rounded text-rose-600"
            />
            <span>Tôi xác nhận mọi nhân vật trong ảnh/video đều đủ 18 tuổi trở lên.</span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-xl bg-slate-50 p-2.5">
            <input
              type="checkbox"
              checked={confirmConsent}
              onChange={(event) => onConfirmConsentChange(event.target.checked)}
              className="mt-0.5 rounded text-rose-600"
            />
            <span>Tôi xác nhận nội dung có sự đồng thuận hợp pháp, không xâm phạm riêng tư hoặc quấy rối.</span>
          </label>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
          >
            Hủy
          </button>
          <button
            type="button"
            disabled={!confirm18Plus || !confirmConsent || busy}
            onClick={onSubmit}
            className="flex-1 rounded-xl bg-rose-600 py-2.5 text-xs font-bold text-white disabled:opacity-50"
          >
            Xác nhận & Gửi
          </button>
        </div>
      </div>
    </div>
  );
}

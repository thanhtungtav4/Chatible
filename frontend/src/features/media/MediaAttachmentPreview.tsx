import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Ban, Eye, Maximize2, X } from 'lucide-react';
import type { ClientMediaType } from './encryptedMediaClient.js';
import type { MediaViewState } from './mediaPreviewLifecycle.js';

interface MediaAttachmentPreviewProps {
  title: string;
  mediaType: ClientMediaType;
  isAdult?: boolean;
  isMine: boolean;
  viewState?: MediaViewState;
  revokedFallback?: boolean;
  busy: boolean;
  localPreviewUrl?: string;
  uploadProgress?: number;
  audioExtra?: ReactNode;
  onView: () => void;
  onRevoke: () => void;
}

function CircularProgress({ percent }: { percent: number }) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const safePercent = Math.min(100, Math.max(0, percent));
  const strokeDashoffset = circumference - (safePercent / 100) * circumference;

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/45 backdrop-blur-[1px] rounded-lg">
      <div className="relative flex items-center justify-center">
        <svg className="w-12 h-12 -rotate-90 transform" viewBox="0 0 44 44">
          <circle
            cx="22"
            cy="22"
            r={radius}
            className="text-white/25"
            strokeWidth="3.5"
            stroke="currentColor"
            fill="transparent"
          />
          <circle
            cx="22"
            cy="22"
            r={radius}
            className="text-white transition-all duration-150 ease-out"
            strokeWidth="3.5"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            stroke="currentColor"
            fill="transparent"
          />
        </svg>
        <span className="absolute text-[11px] font-bold text-white tracking-tighter">
          {Math.round(safePercent)}%
        </span>
      </div>
      <span className="mt-1 text-[9.5px] font-medium text-white/90">Đang tải lên…</span>
    </div>
  );
}

export function MediaAttachmentPreview({
  title,
  mediaType,
  isAdult,
  isMine,
  viewState,
  revokedFallback,
  busy,
  localPreviewUrl,
  uploadProgress,
  audioExtra,
  onView,
  onRevoke,
}: MediaAttachmentPreviewProps) {
  const isRevoked = Boolean(viewState?.revoked || revokedFallback);
  const previewUrl = isRevoked ? undefined : (localPreviewUrl || viewState?.previewUrl);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);

  useEffect(() => {
    if (!isLightboxOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsLightboxOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLightboxOpen]);

  useEffect(() => {
    if (!previewUrl && isLightboxOpen) {
      setIsLightboxOpen(false);
    }
  }, [previewUrl, isLightboxOpen]);

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="font-semibold">{title}</span>
        {isAdult && (
          <span className="rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[9px] font-bold">
            🔞 18+
          </span>
        )}
      </div>

      {previewUrl && mediaType === 'IMAGE' && (
        <>
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (uploadProgress === undefined || uploadProgress >= 100) {
                setIsLightboxOpen(true);
              }
            }}
            onKeyDown={(e) => {
              if (
                (e.key === 'Enter' || e.key === ' ') &&
                (uploadProgress === undefined || uploadProgress >= 100)
              ) {
                e.preventDefault();
                setIsLightboxOpen(true);
              }
            }}
            className="group relative select-none overflow-hidden rounded-lg cursor-pointer transition hover:opacity-95"
            title="Bấm để xem ảnh kích thước đầy đủ"
          >
            <img
              src={previewUrl}
              alt={viewState?.watermarkText || 'Media'}
              draggable={false}
              onContextMenu={(event) => event.preventDefault()}
              className="max-h-56 select-none rounded-lg object-cover transition duration-150 group-hover:scale-[1.01]"
            />
            {/* Zoom hint badge on hover */}
            <div className="absolute top-2 right-2 rounded-full bg-black/50 p-1.5 text-white opacity-0 transition duration-150 group-hover:opacity-100 pointer-events-none shadow-sm">
              <Maximize2 size={13} />
            </div>

            {uploadProgress !== undefined && uploadProgress < 100 && (
              <CircularProgress percent={uploadProgress} />
            )}
            {viewState?.watermarkedMode !== 'embedded' && viewState?.watermarkText && (
              <span className="pointer-events-none absolute inset-x-1 bottom-1 rounded bg-black/55 px-1 py-0.5 text-[9px] text-white">
                {viewState.watermarkText}
              </span>
            )}
          </div>

          {/* Fullscreen Lightbox Modal */}
          {isLightboxOpen && typeof document !== 'undefined' && createPortal(
            <div
              role="dialog"
              aria-label="Xem ảnh kích thước đầy đủ"
              aria-modal="true"
              onClick={() => setIsLightboxOpen(false)}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-3 sm:p-6 backdrop-blur-sm animate-in fade-in select-none"
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsLightboxOpen(false);
                }}
                className="absolute top-4 right-4 z-10 rounded-full bg-white/20 p-2 text-white hover:bg-white/30 transition shadow-lg focus:outline-none"
                aria-label="Đóng"
                title="Đóng (Esc)"
              >
                <X size={22} />
              </button>

              <div
                className="relative flex max-h-[92vh] max-w-[96vw] items-center justify-center overflow-hidden rounded-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <img
                  src={previewUrl}
                  alt={viewState?.watermarkText || 'Xem ảnh phóng to'}
                  draggable={false}
                  onContextMenu={(e) => e.preventDefault()}
                  className="max-h-[88vh] max-w-[94vw] rounded-xl object-contain shadow-2xl"
                />
                {viewState?.watermarkedMode !== 'embedded' && viewState?.watermarkText && (
                  <span className="pointer-events-none absolute inset-x-2 bottom-3 rounded-lg bg-black/60 px-3 py-1 text-center text-xs text-white">
                    {viewState.watermarkText}
                  </span>
                )}
              </div>
            </div>,
            document.body
          )}
        </>
      )}

      {mediaType === 'AUDIO' && (
        <>
          {audioExtra}
          {previewUrl && (
            <audio
              controls
              controlsList="nodownload"
              onContextMenu={(event) => event.preventDefault()}
              src={previewUrl}
              className="max-w-full"
            />
          )}
        </>
      )}

      {previewUrl && mediaType === 'VIDEO' && (
        <div className="relative select-none">
          <video
            controls
            controlsList="nodownload noplaybackrate"
            disablePictureInPicture
            onContextMenu={(event) => event.preventDefault()}
            src={previewUrl}
            className="max-h-56 rounded-lg"
          />
          {viewState?.watermarkedMode !== 'embedded' && viewState?.watermarkText && (
            <span className="pointer-events-none absolute inset-x-1 bottom-8 rounded bg-black/55 px-1 py-0.5 text-[9px] text-white">
              {viewState.watermarkText}
            </span>
          )}
        </div>
      )}

      {!previewUrl && !isRevoked && (
        <button
          type="button"
          onClick={onView}
          disabled={busy}
          className="flex items-center gap-1 rounded-full bg-white/85 px-2.5 py-1 text-[11px] font-bold text-blue-700"
        >
          <Eye size={12} />Xem trong 5 phút
        </button>
      )}

      {isRevoked && <span className="text-[10px] opacity-75">Media đã bị thu hồi</span>}

      {isMine && !isRevoked && (
        <button
          type="button"
          onClick={onRevoke}
          className="flex items-center gap-1 text-[10px] font-semibold opacity-80 hover:opacity-100"
        >
          <Ban size={11} />Thu hồi quyền xem
        </button>
      )}
    </div>
  );
}

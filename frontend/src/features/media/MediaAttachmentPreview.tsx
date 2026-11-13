import type { ReactNode } from 'react';
import { Ban, Eye } from 'lucide-react';
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
  audioExtra?: ReactNode;
  onView: () => void;
  onRevoke: () => void;
}

export function MediaAttachmentPreview({
  title,
  mediaType,
  isAdult,
  isMine,
  viewState,
  revokedFallback,
  busy,
  audioExtra,
  onView,
  onRevoke,
}: MediaAttachmentPreviewProps) {
  const isRevoked = Boolean(viewState?.revoked || revokedFallback);
  const previewUrl = isRevoked ? undefined : viewState?.previewUrl;

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
        <div className="relative select-none">
          <img
            src={previewUrl}
            alt={viewState?.watermarkText || 'Media'}
            draggable={false}
            onContextMenu={(event) => event.preventDefault()}
            className="max-h-56 select-none rounded-lg"
          />
          {viewState?.watermarkedMode !== 'embedded' && viewState?.watermarkText && (
            <span className="pointer-events-none absolute inset-x-1 bottom-1 rounded bg-black/55 px-1 py-0.5 text-[9px] text-white">
              {viewState.watermarkText}
            </span>
          )}
        </div>
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

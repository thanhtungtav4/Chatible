import React from 'react';
import { SmilePlus } from 'lucide-react';

export const POPULAR_REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '👍', '🔥'] as const;

interface ReactionPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function ReactionPickerPopup({ onSelect, onClose }: ReactionPickerProps) {
  return (
    <div
      role="menu"
      aria-label="Chọn biểu cảm"
      className="absolute -top-10 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 rounded-full bg-white px-2 py-1 shadow-lg shadow-black/10 border border-slate-200 animate-in fade-in zoom-in-95 duration-150"
      onClick={(e) => e.stopPropagation()}
    >
      {POPULAR_REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => {
            onSelect(emoji);
            onClose();
          }}
          className="flex h-7 w-7 items-center justify-center rounded-full text-base transition-transform hover:scale-130 active:scale-95"
          aria-label={`Thả biểu cảm ${emoji}`}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

interface ReactionBadgesProps {
  reactions?: Record<string, string>; // userId -> emoji
  myUserId: string;
  isMine: boolean;
  onToggleReaction: (emoji: string) => void;
}

export function ReactionBadges({ reactions, myUserId, isMine, onToggleReaction }: ReactionBadgesProps) {
  if (!reactions || Object.keys(reactions).length === 0) return null;

  // Group by emoji
  const counts: Record<string, { count: number; hasMine: boolean }> = {};
  for (const [uid, emoji] of Object.entries(reactions)) {
    if (!counts[emoji]) {
      counts[emoji] = { count: 0, hasMine: false };
    }
    counts[emoji]!.count += 1;
    if (uid === myUserId) {
      counts[emoji]!.hasMine = true;
    }
  }

  const entries = Object.entries(counts);
  if (entries.length === 0) return null;

  return (
    <div
      className={`absolute -bottom-3 flex flex-wrap gap-1 z-10 ${
        isMine ? 'right-2' : 'left-2'
      }`}
    >
      {entries.map(([emoji, meta]) => (
        <button
          key={emoji}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleReaction(emoji);
          }}
          title={meta.hasMine ? 'Bấm để gỡ biểu cảm' : 'Bấm để thả biểu cảm tương tự'}
          className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] leading-none shadow-xs border transition active:scale-90 ${
            meta.hasMine
              ? 'bg-blue-50 border-blue-300 text-blue-700 font-bold'
              : 'bg-white border-slate-200 text-slate-700'
          }`}
        >
          <span>{emoji}</span>
          {meta.count > 1 && <span className="text-[9px] font-semibold">{meta.count}</span>}
        </button>
      ))}
    </div>
  );
}

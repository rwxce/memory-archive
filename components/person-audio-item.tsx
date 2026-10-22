'use client';

import { Pause, Play } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { PersonMediaItem } from '@/lib/domain/library';
import { AVATAR_TINTS, tintIndex } from './avatar-tint';
import { cn } from '@/components/ui/utils';
import { formatClock } from './clock';
import { formatDayTime } from './format';
import { Waveform } from './waveform';

/** Who sent it, as shown: "You" for the archive's owner, the participant's name, or "Unknown sender". */
export function useAudioAuthor(item: PersonMediaItem): string {
  const t = useTranslations('personAudio');
  return item.isMe ? t('you') : item.participantName || t('unknownAuthor');
}

/**
 * One voice message or audio file as a compact row: a tinted round Play/Pause button, who, its
 * length (once the player has learned it), a decorative mini waveform and the date. Nothing is
 * read until Play is pressed; the one shared player lives in the hero above the list. Names and
 * captions are untrusted text and only ever rendered as text.
 */
export function PersonAudioItem({
  item,
  current,
  playing,
  duration,
  onToggle,
}: {
  item: PersonMediaItem;
  /** This is the item in the player. */
  current: boolean;
  playing: boolean;
  /** Seconds, when the player has loaded it before. */
  duration?: number;
  onToggle: () => void;
}) {
  const t = useTranslations('personAudio');
  const locale = useLocale();
  const when = formatDayTime(item.sentAt, locale);
  const author = useAudioAuthor(item);
  const label = `${author}, ${when}`;
  const on = current && playing;
  return (
    <li className={cn('flex items-center gap-3 rounded-[20px] py-2.5 ps-2.5 pe-3.5', current ? 'bg-ac-soft' : 'bg-sf lg:in-data-panel:bg-bg')}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={t(on ? 'pauseLabel' : 'playLabel', { label })}
        aria-pressed={current ? on : undefined}
        className={cn(
          AVATAR_TINTS[tintIndex(author)],
          'text-ink focus-visible:ring-ring/50 flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]',
        )}
      >
        {on ? <Pause className="size-[18px]" fill="currentColor" aria-hidden /> : <Play className="size-[18px]" fill="currentColor" aria-hidden />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex justify-between gap-2 text-sm">
          <span className="truncate font-semibold" dir="auto">
            {author}
          </span>
          {duration !== undefined && <span className="text-mu shrink-0">{formatClock(duration)}</span>}
        </div>
        <Waveform seed={String(item.id)} bars={30} tone="muted" className="h-4 w-full justify-between" />
        <p className="text-mu text-xs break-words">
          <time dateTime={item.sentAt}>{when}</time>
          <span dir="auto">
            {' · '}
            {item.conversationTitle}
          </span>
        </p>
        {item.body && (
          <p className="text-t2 text-sm leading-snug break-words whitespace-pre-line" dir="auto">
            {item.body}
          </p>
        )}
      </div>
    </li>
  );
}

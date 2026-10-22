'use client';

import { useEffect, useRef } from 'react';
import { ImageOff, Loader, Play } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useMediaUrl } from '@/hooks/use-media-url';
import { Link } from '@/i18n/navigation';
import type { PersonMediaItem } from '@/lib/domain/library';
import { formatDayTime } from './format';

/**
 * The file of one item: a Play button until it is asked for, so scrolling a list of thousands reads
 * nothing; then the same lazy read as the conversation view (`useMediaUrl`) and a native player. Only
 * the item the screen marks `active` has its file; when another one starts, this one goes back to
 * its button, which stops it and frees its object URL.
 */
function Player({ item, label, active, onPlay }: { item: PersonMediaItem; label: string; active: boolean; onPlay: () => void }) {
  const t = useTranslations('personAudio');
  const tm = useTranslations('conversation.media');
  const media = useMediaUrl({ sha256: item.mediaSha256, mime: item.mediaMime, name: item.mediaName }, active);
  const player = useRef<HTMLAudioElement>(null);
  const ready = media.status === 'ready';
  // The button the person pressed is gone: keep the keyboard where they were.
  useEffect(() => {
    if (ready) player.current?.focus();
  }, [ready]);

  if (!active) {
    return (
      <Button variant="outline" onClick={onPlay} aria-label={t('playLabel', { label })} className="min-h-11 w-fit">
        <Play aria-hidden />
        {t('play')}
      </Button>
    );
  }
  if (media.status === 'missing' || media.status === 'error') {
    return (
      <p role="note" className="bg-muted/60 text-muted-foreground flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm">
        <ImageOff className="size-5 shrink-0" aria-hidden />
        {tm(media.status === 'missing' ? 'missing' : 'error')}
      </p>
    );
  }
  if (!ready) {
    return (
      <p role="status" className="bg-muted/60 text-muted-foreground flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm">
        <Loader className="size-4 motion-safe:animate-spin" aria-hidden />
        {tm('loading', { name: item.mediaName || tm('audio') })}
      </p>
    );
  }
  return <audio ref={player} controls autoPlay preload="none" src={media.url} aria-label={label} className="w-full" />;
}

/**
 * One voice message or audio file: when, who, which conversation, its caption, the player and the
 * way to the message. Names and captions are untrusted text and only ever rendered as text.
 */
export function PersonAudioItem({ item, personId, active, onPlay }: { item: PersonMediaItem; personId: string; active: boolean; onPlay: () => void }) {
  const t = useTranslations('personAudio');
  const locale = useLocale();
  const when = formatDayTime(item.sentAt, locale);
  const author = item.isMe ? t('you') : item.participantName || t('unknownAuthor');
  const href = `/conversation?id=${encodeURIComponent(item.conversationId)}&from=${encodeURIComponent(personId)}&date=${item.sentAt.slice(0, 10)}`;
  return (
    <li className="bg-card flex flex-col gap-2 rounded-xl border p-4">
      <p className="text-sm break-words">
        <time dateTime={item.sentAt} className="font-medium">
          {when}
        </time>
        <span className="text-muted-foreground" dir="auto">
          {' · '}
          {author}
        </span>
      </p>
      <p className="text-muted-foreground text-sm break-words" dir="auto">
        {item.conversationTitle}
      </p>
      {item.body && (
        <p className="leading-relaxed break-words whitespace-pre-line" dir="auto">
          {item.body}
        </p>
      )}
      <Player item={item} label={`${author}, ${when}`} active={active} onPlay={onPlay} />
      <Link
        href={href}
        aria-label={t('openLabel', { title: item.conversationTitle, when })}
        className="text-primary focus-visible:ring-ring/50 flex min-h-11 w-fit items-center rounded-md text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px]"
      >
        {t('open')}
      </Link>
    </li>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Film, ImageOff, Loader, Mic, Play } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useBlobSize, useMediaUrl } from '@/hooks/use-media-url';
import type { ConversationMessage } from '@/lib/domain/library';
import { formatBytes } from './format';

type Kind = 'photo' | 'sticker' | 'video' | 'audio' | 'document';
const KINDS: readonly string[] = ['photo', 'sticker', 'video', 'audio', 'document'];
export const isMediaMessage = (type: string): type is Kind => KINDS.includes(type);

const boxClass = 'bg-muted/60 text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-2 text-sm break-words';

/**
 * The file of a media message. The bytes are read only when this row is mounted (the list
 * mounts rows near the view), waiting in a shared queue; the object URL is revoked when the row
 * leaves. File names are untrusted: they only ever appear as text and in attributes.
 *
 * - photo, sticker, voice message: read when the row appears;
 * - video: a Play button, so a long video is not read into memory just because it scrolled by;
 * - document: a chip with name and size; Save reads it on demand;
 * - the file is not in the archive: a calm "not saved" note with the name.
 */
export function MessageMedia({ message }: { message: ConversationMessage }) {
  const kind = message.type as Kind;
  const source = { sha256: message.mediaSha256, mime: message.mediaMime, name: message.mediaName };
  if (kind === 'video') return <VideoMedia message={message} source={source} />;
  if (kind === 'document') return <DocumentMedia message={message} source={source} />;
  return <InlineMedia kind={kind} message={message} source={source} />;
}

type Source = { sha256: string | null; mime: string | null; name: string };

function useLabel(message: ConversationMessage) {
  const t = useTranslations('conversation.media');
  const kind = message.type as Kind;
  return { t, name: message.mediaName || t(kind) };
}

function Missing({ name, error = false }: { name: string; error?: boolean }) {
  const t = useTranslations('conversation.media');
  return (
    <div className={boxClass} role="note">
      <ImageOff className="size-5 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block">{t(error ? 'error' : 'missing')}</span>
        <span className="block text-xs opacity-80" dir="auto">
          {name}
        </span>
      </span>
    </div>
  );
}

function Loading({ name, icon }: { name: string; icon: 'image' | 'video' | 'audio' }) {
  const t = useTranslations('conversation.media');
  const Icon = icon === 'audio' ? Mic : icon === 'video' ? Film : Loader;
  return (
    <div className={`${boxClass} ${icon === 'audio' ? 'min-h-12 w-60' : 'min-h-36 w-52'} max-w-full justify-center`}>
      <Icon className={`size-5 shrink-0 ${icon === 'image' ? 'motion-safe:animate-spin' : ''}`} aria-hidden />
      <span className="min-w-0 text-center text-xs" dir="auto">
        {t('loading', { name })}
      </span>
    </div>
  );
}

function InlineMedia({ kind, message, source }: { kind: Kind; message: ConversationMessage; source: Source }) {
  const { name } = useLabel(message);
  const media = useMediaUrl(source);
  if (media.status === 'missing') return <Missing name={name} />;
  if (media.status === 'error') return <Missing name={name} error />;
  if (media.status !== 'ready') return <Loading name={name} icon={kind === 'audio' ? 'audio' : 'image'} />;
  if (kind === 'audio') return <audio controls preload="none" src={media.url} aria-label={name} className="w-60 max-w-full" />;
  return <img src={media.url} alt={name} decoding="async" className="block max-h-72 max-w-full rounded-md object-contain" />;
}

function VideoMedia({ message, source }: { message: ConversationMessage; source: Source }) {
  const { t, name } = useLabel(message);
  const [wanted, setWanted] = useState(false);
  const media = useMediaUrl(source, wanted || source.sha256 === null);
  if (media.status === 'missing') return <Missing name={name} />;
  if (media.status === 'error') return <Missing name={name} error />;
  if (media.status === 'ready') return <video controls autoPlay preload="none" src={media.url} aria-label={name} className="block max-h-80 w-72 max-w-full rounded-md bg-black" />;
  if (wanted) return <Loading name={name} icon="video" />;
  return (
    <button
      type="button"
      onClick={() => setWanted(true)}
      aria-label={t('playLabel', { name })}
      className={`${boxClass} focus-visible:ring-ring/50 hover:bg-muted min-h-12 w-72 max-w-full outline-none focus-visible:ring-[3px]`}
    >
      <Play className="size-5 shrink-0" aria-hidden />
      <span className="min-w-0 text-start" dir="auto">
        {name}
      </span>
    </button>
  );
}

function DocumentMedia({ message, source }: { message: ConversationMessage; source: Source }) {
  const { t, name } = useLabel(message);
  const locale = useLocale();
  const [wanted, setWanted] = useState(false);
  const size = useBlobSize(source.sha256);
  const media = useMediaUrl(source, wanted);
  const link = useRef<HTMLAnchorElement>(null);
  const saved = useRef(false);
  // Once the bytes are read for a Save, the browser's own download starts (once).
  useEffect(() => {
    if (media.status === 'ready' && !saved.current) {
      saved.current = true;
      link.current?.click();
    }
  }, [media.status]);

  if (source.sha256 === null || media.status === 'missing') return <Missing name={name} />;
  if (media.status === 'error') return <Missing name={name} error />;
  return (
    <div className={`${boxClass} w-72 max-w-full`}>
      <FileText className="size-6 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block font-medium" dir="auto">
          {name}
        </span>
        {size !== undefined && <span className="block text-xs">{formatBytes(size, locale)}</span>}
      </span>
      {media.status === 'ready' ? (
        <Button asChild variant="outline">
          <a ref={link} href={media.url} download={name} aria-label={t('saveLabel', { name })}>
            <Download aria-hidden />
            {t('save')}
          </a>
        </Button>
      ) : (
        <Button variant="outline" aria-label={t('saveLabel', { name })} aria-disabled={media.status === 'loading' || undefined} onClick={() => media.status === 'idle' && setWanted(true)}>
          {media.status === 'loading' ? <Loader className="motion-safe:animate-spin" aria-hidden /> : <Download aria-hidden />}
          {t('save')}
        </Button>
      )}
    </div>
  );
}

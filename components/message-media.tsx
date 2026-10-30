'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Film, ImageOff, Loader, Mic, Pause, Play } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useBlobSize, useMediaUrl } from '@/hooks/use-media-url';
import type { ConversationMessage } from '@/lib/domain/library';
import { formatBytes } from './format';
import { Waveform } from './waveform';

type Kind = 'photo' | 'sticker' | 'video' | 'audio' | 'document';
const KINDS: readonly string[] = ['photo', 'sticker', 'video', 'audio', 'document'];
export const isMediaMessage = (type: string): type is Kind => KINDS.includes(type);

const boxClass = 'bg-sf2 text-t2 flex items-center gap-2 rounded-2xl px-3 py-2 text-sm break-words';

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

function Missing({ name, error = false, tooLarge = false }: { name: string; error?: boolean; tooLarge?: boolean }) {
  const t = useTranslations('conversation.media');
  return (
    <div className={boxClass} role="note">
      <ImageOff className="size-5 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block">{t(tooLarge ? 'tooLarge' : error ? 'error' : 'missing')}</span>
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

/** 83 seconds as "1:23"; nothing until the browser has read the file's length. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * A voice message: a round play/pause button, a decorative waveform (seeded, not the audio's real
 * shape; it fills as the message plays) and the length once the browser has read it from the file.
 * The `<audio>` element has no controls of its own; the button is the control.
 */
function VoicePlayer({ url, name, seed, own }: { url: string; name: string; seed: string; own: boolean }) {
  const t = useTranslations('conversation.media');
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number>();
  const [progress, setProgress] = useState(0);
  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play()?.catch(() => setPlaying(false));
    else element.pause();
  };
  return (
    <div className="flex items-center gap-2.5 pe-1">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t('pauseLabel', { name }) : t('playLabel', { name })}
        className={`${own ? 'bg-out-ink text-out-b' : 'bg-ac text-ac-ink'} focus-visible:ring-ring/50 flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]`}
      >
        {playing ? <Pause className="size-4 fill-current" aria-hidden /> : <Play className="size-4 fill-current" aria-hidden />}
      </button>
      <Waveform seed={seed} bars={26} progress={progress} onAccent={own} className="h-7 min-w-0" />
      {duration !== undefined && <span className={`${own ? 'text-out-mu' : 'text-mu'} shrink-0 text-xs tabular-nums`}>{clock(duration)}</span>}
      <audio
        ref={audio}
        src={url}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const length = event.currentTarget.duration;
          if (Number.isFinite(length) && length > 0) setDuration(length);
        }}
        onTimeUpdate={(event) => {
          const { currentTime, duration: length } = event.currentTarget;
          setProgress(Number.isFinite(length) && length > 0 ? currentTime / length : 0);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
        }}
      />
    </div>
  );
}

function InlineMedia({ kind, message, source }: { kind: Kind; message: ConversationMessage; source: Source }) {
  const { name } = useLabel(message);
  const media = useMediaUrl(source);
  if (media.status === 'missing') return <Missing name={name} />;
  if (media.status === 'too-large') return <Missing name={name} tooLarge />;
  if (media.status === 'error') return <Missing name={name} error />;
  if (media.status !== 'ready') return <Loading name={name} icon={kind === 'audio' ? 'audio' : 'image'} />;
  if (kind === 'audio') return <VoicePlayer url={media.url} name={name} own={message.isMe} seed={`${message.mediaSha256 ?? ''}${message.id}`} />;
  return <img src={media.url} alt={name} decoding="async" className="block max-h-72 max-w-full rounded-[17px] object-contain" />;
}

function VideoMedia({ message, source }: { message: ConversationMessage; source: Source }) {
  const { t, name } = useLabel(message);
  const [wanted, setWanted] = useState(false);
  const media = useMediaUrl(source, wanted || source.sha256 === null);
  if (media.status === 'missing') return <Missing name={name} />;
  if (media.status === 'too-large') return <Missing name={name} tooLarge />;
  if (media.status === 'error') return <Missing name={name} error />;
  if (media.status === 'ready') return <video controls autoPlay preload="none" src={media.url} aria-label={name} className="block max-h-80 w-72 max-w-full rounded-[17px] bg-black" />;
  if (wanted) return <Loading name={name} icon="video" />;
  return (
    <button
      type="button"
      onClick={() => setWanted(true)}
      aria-label={t('playLabel', { name })}
      className={`${boxClass} focus-visible:ring-ring/50 hover:bg-line min-h-12 w-72 max-w-full outline-none focus-visible:ring-[3px]`}
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
  if (media.status === 'too-large') return <Missing name={name} tooLarge />;
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

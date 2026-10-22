import { cn } from '@/components/ui/utils';

/** A small seeded PRNG (mulberry32) so the same seed always gives the same bars. */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % 10000) / 10000;
  };
}

const TONES = {
  accent: ['bg-ac', 'bg-ac/40'],
  'on-accent': ['bg-ac-ink', 'bg-out-mu/60'],
  muted: ['bg-ac', 'bg-nav-off'],
} as const;

/** Bar heights as fractions (0.2 to 1) of the height; deterministic per `seed`. */
export function waveformHeights(seed: string, bars: number): number[] {
  const next = rng(seed);
  return Array.from({ length: bars }, () => 0.2 + next() * 0.8);
}

/**
 * A decorative waveform for a voice message. It is not the audio's real shape: it is seeded
 * (so a message always looks the same) and hidden from assistive technology. `progress`
 * (0 to 1) colors the bars already played.
 */
export function Waveform({
  seed,
  bars = 32,
  progress = 0,
  tone = 'accent',
  onAccent = false,
  className,
}: {
  seed: string;
  bars?: number;
  progress?: number;
  /** `accent` on a plain surface, `on-accent` on the accent card, `muted` for the compact rows. */
  tone?: 'accent' | 'on-accent' | 'muted';
  /** Shorthand for `tone="on-accent"` (a voice message inside an outgoing bubble). */
  onAccent?: boolean;
  className?: string;
}) {
  const colors = TONES[onAccent ? 'on-accent' : tone];
  const heights = waveformHeights(seed, bars);
  return (
    <span aria-hidden className={cn('flex h-6 items-center gap-0.5', className)}>
      {heights.map((height, i) => (
        <span
          key={i}
          className={cn('w-0.5 rounded-full', i / bars < progress ? colors[0] : colors[1])}
          style={{ height: `${Math.round(height * 100)}%` }}
        />
      ))}
    </span>
  );
}

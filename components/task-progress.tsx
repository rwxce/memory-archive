import { cn } from '@/components/ui/utils';

/**
 * A progress bar for a task that can take a while. `value` is 0-100, or `undefined` when the total
 * is not known yet (then it pulses, and stands still under reduced motion). `text` is the sentence
 * ("12 of 340 files checked") a screen reader gets as the bar's value; the screen shows and announces
 * that sentence itself in a status region next to the bar.
 */
export function TaskProgress({ label, text, value }: { label: string; text: string; value?: number }) {
  const percent = value === undefined ? undefined : Math.round(Math.min(100, Math.max(0, value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={text}
      className="bg-sf2 h-2 w-full overflow-hidden rounded-full"
    >
      <div
        className={cn('bg-primary h-full rounded-full', percent === undefined ? 'w-1/3 motion-safe:animate-pulse' : 'transition-[width] motion-reduce:transition-none')}
        style={percent === undefined ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

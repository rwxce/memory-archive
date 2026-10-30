import { avatarLetter, AVATAR_TINTS, tintIndex } from './avatar-tint';
import { cn } from '@/components/ui/utils';

const SIZES = {
  sm: 'size-[30px] rounded-[9px] text-base',
  md: 'size-[52px] rounded-2xl text-[1.625rem]',
  lg: 'size-16 rounded-[20px] text-4xl',
  xl: 'size-[104px] rounded-[34px] text-6xl',
} as const;

/**
 * A single-letter avatar tile, or the person's photo when `photoUrl` is given. Decorative (`aria-hidden`): the name always sits next to it.
 * The tint comes from the name, so it is the same everywhere; `tone="accent"` is the solid
 * accent tile used for the featured person.
 */
export function PersonAvatar({
  name,
  size = 'md',
  tone = 'auto',
  photoUrl,
  className,
}: {
  name: string;
  size?: keyof typeof SIZES;
  tone?: 'auto' | 'accent';
  /** The person's photo (an object URL); the initial shows when absent. */
  photoUrl?: string | null;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'font-display flex shrink-0 items-center justify-center overflow-hidden',
        tone === 'accent' ? 'bg-ac text-ac-ink' : cn(AVATAR_TINTS[tintIndex(name)], 'text-ink'),
        SIZES[size],
        className,
      )}
    >
      {photoUrl ? <img src={photoUrl} alt="" draggable={false} className="size-full object-cover" /> : avatarLetter(name)}
    </span>
  );
}

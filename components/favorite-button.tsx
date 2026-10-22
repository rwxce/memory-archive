'use client';

import { Star } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';

/**
 * The star beside a bubble. A toggle (`aria-pressed`), filled when the message is a favorite. Like
 * Details it is quiet until hovered or focused on a pointer device, but a favorite always shows its
 * star; on touch it is always there. The 44 px target does not add to the row's height.
 */
export function FavoriteButton({ favorite, onToggle }: { favorite: boolean; onToggle: () => void }) {
  const t = useTranslations('conversation.favorite');
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={favorite ? t('remove') : t('add')}
      aria-pressed={favorite}
      onClick={onToggle}
      className={cn(
        'text-muted-foreground -my-2 rounded-full',
        '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 focus-visible:opacity-100',
        favorite && 'text-primary opacity-100!',
      )}
    >
      <Star aria-hidden className={cn(favorite && 'fill-current')} />
    </Button>
  );
}

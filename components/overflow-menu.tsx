'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { cn } from '@/components/ui/utils';

export type OverflowItem = {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** A link item; otherwise `onSelect` runs. */
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
};

const itemClass =
  'focus-visible:bg-sf2 hover:bg-sf2 flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-start text-sm font-medium outline-none aria-disabled:opacity-50 [&_svg]:size-[18px] [&_svg]:shrink-0';

/**
 * The round "..." button of a screen and the menu it opens (the menu-button pattern, built by
 * hand): `aria-haspopup`/`aria-expanded`, arrow keys and Home/End among the items, Escape closes and returns focus to the button, Tab and a press outside close it. Choosing
 * an item closes the menu first; focus then goes back to the button unless the action moves it.
 */
export function OverflowMenu({ id, label, items, className }: { id?: string; label: string; items: OverflowItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const entries = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return;
    entries()[0]?.focus();
    const away = (event: Event) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    const list = entries();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      setOpen(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next =
        event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : event.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
      list[next]?.focus();
    }
  };

  return (
    <div ref={root} className={cn('relative', className)}>
      <button
        ref={button}
        id={id}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="bg-sf2 text-foreground hover:bg-line focus-visible:ring-ring/50 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]"
      >
        <MoreHorizontal className="size-5" aria-hidden />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className="bg-popover shadow-soft border-line absolute end-0 top-12 z-30 flex w-64 max-w-[calc(100vw-2.5rem)] flex-col gap-0.5 rounded-2xl border p-1.5"
        >
          {items.map((item) =>
            item.href !== undefined ? (
              <Link key={item.id} id={item.id} role="menuitem" href={item.href} tabIndex={-1} onClick={() => close(false)} className={itemClass}>
                {item.icon}
                {item.label}
              </Link>
            ) : (
              <button
                key={item.id}
                id={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.disabled || undefined}
                onClick={() => {
                  if (item.disabled) return;
                  close(false);
                  item.onSelect?.();
                }}
                className={itemClass}
              >
                {item.icon}
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

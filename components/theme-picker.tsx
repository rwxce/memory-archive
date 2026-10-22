'use client';

import { useRef, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/components/ui/utils';
import { THEME_CHOICES, type ThemeChoice } from '@/hooks/theme';
import { useTheme } from '@/hooks/use-theme';
import { nextRadioIndex } from './radio-keys';

/**
 * What each tile previews. These are the two themes' own colors on purpose (a swatch of the
 * theme, not of the current one), so they do not follow the active theme.
 */
const PREVIEW: Record<ThemeChoice, { background: string; text: string; accent: string }> = {
  system: { background: 'linear-gradient(90deg, #ffffff 50%, #1c1b22 50%)', text: '#a39eb2', accent: '#7a68f0' },
  light: { background: '#ffffff', text: '#17151f', accent: '#5b45e0' },
  dark: { background: '#1c1b22', text: '#e8e6ef', accent: '#9a8ef0' },
};

/** Same as the device / Light / Dark as three preview tiles in a radiogroup, remembered on this device. */
export function ThemePicker() {
  const t = useTranslations('settings.theme');
  const [choice, setChoice] = useTheme();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  return (
    <div role="radiogroup" aria-label={t('title')} className="grid grid-cols-3 gap-2">
      {THEME_CHOICES.map((option, index) => {
        const selected = option === choice;
        const p = PREVIEW[option];
        return (
          <button
            key={option}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => setChoice(option)}
            onKeyDown={(event) => {
              const to = nextRadioIndex(event.key, index, THEME_CHOICES.length, getComputedStyle(event.currentTarget).direction === 'rtl');
              if (to === undefined) return;
              event.preventDefault();
              refs.current[to]?.focus();
              setChoice(THEME_CHOICES[to]);
            }}
            className={cn(
              'bg-bg focus-visible:ring-ring/50 flex min-h-11 flex-col items-center gap-2 rounded-[18px] border-2 px-1.5 pt-2 pb-2.5 outline-none focus-visible:ring-[3px]',
              selected ? 'border-ac' : 'border-line',
            )}
          >
            <span
              aria-hidden
              className="border-line box-border flex h-[54px] w-full flex-col justify-center gap-[5px] rounded-xl border px-2.5"
              style={{ background: p.background } as CSSProperties}
            >
              <span className="h-1.5 w-[70%] rounded-[3px]" style={{ background: p.text }} />
              <span className="h-1.5 w-[45%] rounded-[3px]" style={{ background: p.accent }} />
            </span>
            <span className="text-center text-xs leading-tight font-medium">{t(option)}</span>
          </button>
        );
      })}
    </div>
  );
}

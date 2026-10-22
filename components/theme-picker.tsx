'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { THEME_CHOICES, type ThemeChoice } from '@/hooks/theme';
import { useTheme } from '@/hooks/use-theme';

const ICONS: Record<ThemeChoice, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

/** Same as the device / Light / Dark, remembered on this device. */
export function ThemePicker() {
  const t = useTranslations('settings.theme');
  const [choice, setChoice] = useTheme();

  return (
    <div role="group" aria-label={t('title')} className="grid gap-2 sm:grid-cols-3">
      {THEME_CHOICES.map((option) => {
        const Icon = ICONS[option];
        const selected = option === choice;
        return (
          <Button
            key={option}
            type="button"
            variant={selected ? 'secondary' : 'outline'}
            aria-pressed={selected}
            className={selected ? 'ring-ring/60 ring-2' : undefined}
            onClick={() => setChoice(option)}
          >
            <Icon aria-hidden />
            {t(option)}
          </Button>
        );
      })}
    </div>
  );
}

import { useTranslations } from 'next-intl';
import { Waveform } from '@/components/waveform';

/**
 * The decorative picture on the welcome: two photo cards, a mock chat and soft shapes.
 * Entirely `aria-hidden`; its sample strings are translated like everything else. The stage is a
 * fixed 390 px wide scene centered in its box, so it crops evenly on narrower phones.
 */
export function WelcomeHero() {
  const t = useTranslations('welcome.mock');
  return (
    <div aria-hidden className="relative h-[360px] shrink-0 overflow-hidden lg:h-[480px] lg:rounded-[32px]">
      <div className="absolute inset-y-0 left-1/2 w-[390px] -translate-x-1/2">
        <div className="bg-ac-soft absolute top-10 -left-10 size-[260px] rounded-full" />
        <div className="bg-peach absolute top-[150px] -right-[50px] size-[200px] rounded-full" />
        <div className="bg-sf absolute top-[86px] left-11 h-[190px] w-[150px] -rotate-[7deg] rounded-[10px] px-2.5 pt-2.5 pb-[34px] shadow-[0_14px_30px_var(--sh)]">
          <div className="bg-ph-0 size-full rounded-[5px]" />
        </div>
        <div className="bg-sf absolute top-[66px] left-[198px] h-[190px] w-[150px] rotate-6 rounded-[10px] px-2.5 pt-2.5 pb-[34px] shadow-[0_20px_30px_var(--sh)]">
          <div className="bg-ph-2 size-full rounded-[5px]" />
        </div>
        <div className="bg-bg border-line absolute top-[150px] left-[110px] flex h-[196px] w-[172px] flex-col gap-2.5 rounded-2xl border p-3 shadow-[0_20px_40px_var(--sh)]">
          <div className="flex items-center gap-2">
            <span className="bg-ac text-ac-ink font-display flex size-7 items-center justify-center rounded-[9px] text-[17px]">
              {Array.from(t('name'))[0]}
            </span>
            <span className="text-xs font-semibold">{t('name')}</span>
          </div>
          <p className="bg-in-b max-w-[124px] self-start rounded-[12px_12px_12px_4px] px-2.5 py-[7px] text-[11px] leading-snug">{t('received')}</p>
          <p className="bg-out-b text-out-ink max-w-[124px] self-end rounded-[12px_12px_4px_12px] px-2.5 py-[7px] text-[11px] leading-snug">{t('sent')}</p>
          <div className="bg-in-b flex h-6 items-center self-start rounded-xl px-2.5">
            <Waveform seed="welcome-hero" bars={10} className="h-4" />
          </div>
        </div>
      </div>
    </div>
  );
}

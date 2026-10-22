import { LockKeyhole } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Eyebrow } from '@/components/eyebrow';
import { GitHubLink } from '@/components/github-link';
import { LibraryProblem } from '@/components/library-problem';
import { PageTitle } from '@/components/page-title';
import { PillButton } from '@/components/pill-button';
import { SectionCard } from '@/components/section-card';
import { WelcomeActions } from '@/components/welcome-actions';
import { WelcomeHero } from '@/components/welcome-hero';
import { Link } from '@/i18n/navigation';

/** First run: what this is, that it stays on this device, and two ways in. Full screen, no tab bar. */
export function Welcome() {
  const t = useTranslations('welcome');
  const tn = useTranslations('nav');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col lg:grid lg:grid-cols-2 lg:items-center lg:gap-14 lg:px-10">
      <WelcomeHero />
      <div className="flex flex-1 flex-col gap-5 px-7 pt-2 pb-9 lg:px-0 lg:pt-9">
        <Eyebrow>{t('eyebrow')}</Eyebrow>
        <PageTitle className="text-5xl sm:text-6xl" accent={t('titleAccent')}>
          {t('titleStart')}
        </PageTitle>
        <p className="text-t2 max-w-prose text-base leading-relaxed text-pretty">{t('body')}</p>
        <SectionCard tone="mint" className="text-foreground flex-row items-center gap-2.5 rounded-2xl px-3.5 py-3 text-[13px] leading-snug">
          <LockKeyhole className="size-5 shrink-0" strokeWidth={1.75} aria-hidden />
          <p>{t('privacy')}</p>
        </SectionCard>
        <div className="mt-auto flex flex-col gap-3 pt-4">
          <WelcomeActions />
          <PillButton asChild variant="ghost-link" className="self-center">
            <Link href="/settings">{tn('settings')}</Link>
          </PillButton>
          <GitHubLink className="text-mu hover:text-foreground self-center text-sm" />
        </div>
        <LibraryProblem />
      </div>
    </main>
  );
}

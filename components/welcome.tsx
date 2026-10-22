import { ImageIcon, LockKeyhole, MessageCircleHeart, Mic } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AppHeader } from '@/components/app-header';
import { LibraryProblem } from '@/components/library-problem';
import { WelcomeActions } from '@/components/welcome-actions';

/** First run: what this is, that it stays on this device, and two ways in. */
export function Welcome() {
  const t = useTranslations('welcome');

  return (
    <>
      <AppHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 pt-10 pb-16 sm:px-6 sm:pt-20">
        <div className="text-primary/80 flex items-center gap-3" aria-hidden>
          <MessageCircleHeart className="size-7" />
          <ImageIcon className="size-7" />
          <Mic className="size-7" />
        </div>
        <section className="flex flex-col gap-5">
          <h1 className="font-serif text-4xl leading-tight text-balance sm:text-5xl">{t('title')}</h1>
          <p className="text-muted-foreground max-w-prose text-lg leading-relaxed text-pretty">{t('body')}</p>
        </section>
        <WelcomeActions />
        <p className="bg-muted text-muted-foreground flex items-start gap-3 rounded-lg p-4 text-sm leading-relaxed">
          <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('privacy')}
        </p>
        <LibraryProblem />
      </main>
    </>
  );
}

'use client';

import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { Download, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { GitHubLink } from '@/components/github-link';
import { ProfileAvatar } from '@/components/profile-avatar';
import { cn } from '@/components/ui/utils';
import { useLibraryInternals } from '@/hooks/use-library';
import { useMediaQuery } from '@/hooks/use-media-query';
import { usePeople } from '@/hooks/use-people';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { activeTab } from './nav-items';

const rowClass =
  'focus-visible:ring-ring/50 flex min-h-11 items-center gap-2.5 rounded-2xl px-2 py-1 text-sm outline-none focus-visible:ring-[3px]';

/**
 * The desktop navigation (from `lg`; hidden below): brand, search, the people, Import, Settings.
 * Mounted only on a wide screen (an empty column is reserved in the HTML meanwhile); the people list only shows once some screen has opened the library (the sidebar never opens it,
 * so Settings still does not hold the library).
 */
export function Sidebar() {
  const t = useTranslations('nav');
  const tp = useTranslations('people');
  const pathname = usePathname();
  const router = useRouter();
  const wide = useMediaQuery('(min-width: 64rem)');
  const [query, setQuery] = useState('');
  const tab = activeTab(pathname);

  const search = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  };

  // The column is reserved in the HTML from `lg` so the page does not jump when the sidebar mounts.
  if (!wide) return <div aria-hidden className="hidden w-72 shrink-0 lg:block" />;

  return (
    <aside className="sticky top-0 hidden h-dvh w-72 shrink-0 flex-col gap-6 overflow-y-auto p-5 lg:flex">
      <Link href="/people" className={cn(rowClass, 'font-semibold')}>
        <span aria-hidden className="bg-ac text-ac-ink font-display flex size-[34px] items-center justify-center rounded-[11px] text-[22px]">
          {t('brand').charAt(0).toLowerCase()}
        </span>
        {t('brand')}
      </Link>
      <form role="search" onSubmit={search} className="bg-sf focus-within:ring-ring/50 flex h-11 items-center gap-2 rounded-2xl px-3 focus-within:ring-[3px]">
        <Search className="text-mu size-[18px] shrink-0" aria-hidden />
        <label htmlFor="sidebar-search" className="sr-only">
          {t('searchLabel')}
        </label>
        <input
          id="sidebar-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('searchPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </form>
      <nav aria-label={tp('title')} className="flex flex-col gap-0.5">
        <p className="text-mu px-2 pb-2 text-xs font-semibold tracking-widest uppercase">{tp('title')}</p>
        <SidebarPeople />
        <Link href="/people?new=1" className={cn(rowClass, 'text-t2 hover:bg-sf')}>
          <span aria-hidden className="border-nav-off flex size-[30px] items-center justify-center rounded-[9px] border-[1.5px] border-dashed">
            <Plus className="size-3.5" />
          </span>
          {tp('add')}
        </Link>
      </nav>
      <div className="border-line mt-auto flex flex-col gap-0.5 border-t pt-2">
        <Link href="/import" aria-current={tab === 'import' ? 'page' : undefined} className={cn(rowClass, 'hover:bg-sf', tab === 'import' && 'bg-ac-soft text-ac-tx font-medium')}>
          <Download className="size-[18px]" aria-hidden />
          {tp('import')}
        </Link>
        <Link href="/settings" aria-current={tab === 'settings' ? 'page' : undefined} className={cn(rowClass, 'hover:bg-sf', tab === 'settings' && 'bg-ac-soft text-ac-tx font-medium')}>
          <SlidersHorizontal className="size-[18px]" aria-hidden />
          {t('settings')}
        </Link>
        <GitHubLink className={cn(rowClass, 'text-t2 hover:bg-sf')} />
      </div>
    </aside>
  );
}

function SidebarPeople() {
  const { state } = useLibraryInternals();
  if (state.status !== 'ready') return null;
  return <ReadyPeople />;
}

function ReadyPeople() {
  const result = usePeople();
  const pathname = usePathname();
  const current = useSearchParams().get('id');
  if (result.status !== 'ready') return null;
  const onPerson = pathname.startsWith('/person');
  return (
    <>
      {result.people.active.map((person) => {
        const here = onPerson && current === person.id;
        return (
          <Link
            key={person.id}
            href={`/person?id=${encodeURIComponent(person.id)}`}
            aria-current={here ? 'page' : undefined}
            className={cn(rowClass, here ? 'bg-ac-soft' : 'hover:bg-sf')}
          >
            <ProfileAvatar person={person} size="sm" />
            <span className="min-w-0 truncate font-medium">{person.displayName}</span>
          </Link>
        );
      })}
    </>
  );
}

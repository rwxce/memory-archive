'use client';

import { Highlighter, History, Images, Mic, NotebookPen, Search, Star } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

export type PersonSection = 'audio' | 'favorites' | 'gallery' | 'highlights' | 'notes' | 'search' | 'timeline';

/**
 * The person's page now leads to its sections with its own bento cards; this pill list is the
 * compact alternative for a sub-page that wants to offer its siblings.
 * The places a person's page leads to, as links: shown on the person's page and on each of those
 * pages, with the current one marked. Only sections that exist are listed; each new section adds
 * its entry here.
 */
export function PersonSections({ personId, current }: { personId: string; current?: PersonSection }) {
  const t = useTranslations('person');
  const sections = [
    { id: 'timeline' as const, href: `/person/timeline?id=${encodeURIComponent(personId)}`, label: t('sectionTimeline'), Icon: History },
    { id: 'gallery' as const, href: `/person/gallery?id=${encodeURIComponent(personId)}`, label: t('sectionGallery'), Icon: Images },
    { id: 'audio' as const, href: `/person/audio?id=${encodeURIComponent(personId)}`, label: t('sectionAudio'), Icon: Mic },
    { id: 'favorites' as const, href: `/person/favorites?id=${encodeURIComponent(personId)}`, label: t('sectionFavorites'), Icon: Star },
    { id: 'highlights' as const, href: `/person/highlights?id=${encodeURIComponent(personId)}`, label: t('sectionHighlights'), Icon: Highlighter },
    { id: 'notes' as const, href: `/person/notes?id=${encodeURIComponent(personId)}`, label: t('sectionNotes'), Icon: NotebookPen },
    { id: 'search' as const, href: `/search?person=${encodeURIComponent(personId)}`, label: t('sectionSearch'), Icon: Search },
  ];
  return (
    <nav aria-label={t('sectionsLabel')}>
      <ul className="flex flex-wrap gap-2">
        {sections.map(({ id, href, label, Icon }) => (
          <li key={id}>
            <Link
              href={href}
              aria-current={current === id ? 'page' : undefined}
              className="bg-sf2 hover:bg-line aria-[current=page]:bg-ac aria-[current=page]:text-ac-ink focus-visible:ring-ring/50 flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium outline-none focus-visible:ring-[3px]"
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

import { Download, Search, SlidersHorizontal, Users, type LucideIcon } from 'lucide-react';

export type TabId = 'people' | 'search' | 'import' | 'settings';

/** The four top-level destinations, in the order of the tab bar. `key` is the message under `nav.tabs`. */
export const TABS: readonly { id: TabId; href: string; Icon: LucideIcon }[] = [
  { id: 'people', href: '/people', Icon: Users },
  { id: 'search', href: '/search', Icon: Search },
  { id: 'import', href: '/import', Icon: Download },
  { id: 'settings', href: '/settings', Icon: SlidersHorizontal },
];

/** A path without the trailing slash the static export adds ("/people/" is "/people"; the root stays "/"). */
const normalize = (pathname: string | null) => (pathname && pathname.length > 1 ? pathname.replace(/\/+$/, '') : (pathname ?? '/')) || '/';

/**
 * Which tab a path belongs to, or `undefined` on a sub-screen (a person, a conversation, the import
 * history...). The home page shows People. Only exact top-level paths count: `/import/history` is a
 * sub-screen of Settings, not the Import tab.
 */
export function activeTab(pathname: string | null): TabId | undefined {
  const path = normalize(pathname);
  if (path === '/') return 'people';
  return TABS.find((tab) => tab.href === path)?.id;
}

/** Top-level screens show the tab bar; sub-screens show a back pill instead. */
export const isTopLevel = (pathname: string | null) => activeTab(pathname) !== undefined;

'use client';

import Lenis from 'lenis';
import { useEffect } from 'react';
import { usePathname } from '@/i18n/navigation';

/**
 * True when `node` sits inside a nested element that scrolls natively (the message feed, a note
 * panel, a dialog body...). Lenis would otherwise preventDefault the wheel and scroll the window
 * instead. `data-lenis-prevent` does the same declaratively; this is the safety net for a
 * scroller nobody remembered to mark.
 */
function isInsideNativeScroller(node: Element) {
  for (let el: Element | null = node; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return true;
  }
  return false;
}

/**
 * Smooth (Lenis) scrolling for the page, the same feel as the sibling Zliding app. Uses the Lenis
 * defaults on purpose: a longer duration makes the end of every wheel scroll drag and overshoot.
 * Off under prefers-reduced-motion, recreated on route change, and paused while something holds a
 * `data-scroll-locked` lock on `<body>` (Lenis re-asserts the scroll position every frame and
 * would fight it). Nested scrollers keep native scrolling. No network: it only listens to input.
 */
export function SmoothScrollProvider() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const lenis = new Lenis({ autoRaf: true, prevent: isInsideNativeScroller });

    const syncWithScrollLock = () => {
      if (document.body.hasAttribute('data-scroll-locked')) lenis.stop();
      else lenis.start();
    };
    syncWithScrollLock();
    const observer = new MutationObserver(syncWithScrollLock);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-scroll-locked'] });

    // In-page `#hash` links: a native jump would be overwritten by Lenis on the next frame, so
    // Lenis scrolls there and the hash goes into the history like a normal anchor.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href^="#"]');
      const href = anchor?.getAttribute('href');
      if (!href || href === '#') return;
      // getElementById, not querySelector: an arbitrary hash is not always a valid selector.
      const target = document.getElementById(href.slice(1));
      if (!target) return;
      event.preventDefault();
      lenis.scrollTo(target);
      window.history.pushState(null, '', href);
    };
    document.addEventListener('click', onClick);

    return () => {
      document.removeEventListener('click', onClick);
      observer.disconnect();
      lenis.destroy();
    };
  }, [pathname]);

  return null;
}

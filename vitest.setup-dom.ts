// Component tests run as a phone-sized screen: no media query matches, so the desktop sidebar
// (mounted only from `lg`) is absent unless a test installs its own `matchMedia`.
if (typeof window !== 'undefined') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

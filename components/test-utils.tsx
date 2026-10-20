import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

// React's act() environment flag for DOM tests without a testing library.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type Rendered = { container: HTMLElement; root: Root; unmount: () => void };

/** Render a client component with the English messages into a fresh container. */
export async function render(ui: ReactNode, messages: Record<string, unknown> = en): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        {ui}
      </NextIntlClientProvider>,
    );
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export async function click(el: Element | null | undefined) {
  if (!el) throw new Error('click: element not found');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

import { act, type ReactNode } from 'react';
import { vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { LibraryProvider } from '@/hooks/use-library';
import en from '@/messages/en.json';
import type { Library } from '@/lib/usecases/library';
import { createTestLibrary, libraryOf } from '@/lib/usecases/test-client';

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

/**
 * Render a screen inside a LibraryProvider backed by a real in-memory library
 * (the real use cases and queries; no worker, no OPFS). `close` is a spy for
 * the library's close(); `open` can be replaced to test loading and failures.
 */
export async function renderWithLibrary(
  ui: ReactNode,
  options: { lib?: Awaited<ReturnType<typeof createTestLibrary>>; open?: () => Promise<Library>; messages?: Record<string, unknown> } = {},
): Promise<Rendered & { lib: Awaited<ReturnType<typeof createTestLibrary>>; close: ReturnType<typeof vi.fn> }> {
  const lib = options.lib ?? (await createTestLibrary());
  const close = vi.fn();
  const open = options.open ?? (async () => libraryOf(lib.deps, close));
  const view = await render(<LibraryProvider open={open}>{ui}</LibraryProvider>, options.messages);
  return Object.assign(view, { lib, close });
}

/** Type into a controlled input or textarea the way a person would. */
export async function type(el: Element | null | undefined, value: string) {
  if (!el) throw new Error('type: element not found');
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function submit(form: Element | null | undefined) {
  if (!form) throw new Error('submit: form not found');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** Let pending promises (database calls, effects) settle. */
export async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

import { ViewerDataError, parseViewerData } from '../../lib/exporters/viewer/format';
import { mountViewer } from './app';
import { h } from './dom';
import { makeTranslate, pickLocale } from './strings';

/** Reads the inlined data island and mounts the viewer, or shows why the file cannot be opened. */
export function bootViewer(doc: Document, languages: readonly string[] | undefined): void {
  const locale = pickLocale(languages);
  const t = makeTranslate(locale);
  doc.documentElement.lang = locale;
  const root = doc.getElementById('app');
  if (!root) return;
  const fail = (message: string) => {
    root.replaceChildren(
      h(doc, 'main', { class: 'fatal' }, [h(doc, 'h1', { text: t('errorTitle') }), h(doc, 'p', { text: message })]),
    );
  };
  const island = doc.getElementById('viewer-data');
  const text = island?.textContent ?? '';
  if (text.trim() === '') return fail(t('errorNoData'));
  try {
    mountViewer(root, parseViewerData(text), { locale });
  } catch (error) {
    // Messages from parseViewerData never contain archive text, but only the code is used anyway.
    fail(error instanceof ViewerDataError && error.code === 'newer-schema' ? t('errorNewer') : t('errorInvalid'));
  }
}

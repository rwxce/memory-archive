/**
 * File-content strings of the transcript renderers (day headings, toolbar, page title). The PWA's
 * own UI strings live in messages/*.json; these end up inside exported files. No `lang` keeps the
 * legacy CLI output (pt-BR, "WhatsApp Backup" title suffix) byte for byte.
 */

export const EXPORT_LANGS = ['ca', 'es', 'en'] as const;
export type ExportLang = (typeof EXPORT_LANGS)[number];

export interface RenderLabels {
  /** BCP 47 tag for `<html lang>` and the day heading date format. */
  locale: string;
  /** Appended to the page title, or `''` for the conversation title alone. */
  titleSuffix: string;
  searchPlaceholder: string;
  searchLabel: string;
  senderLabel: string;
  allSenders: string;
  theme: string;
}

const LEGACY: RenderLabels = {
  locale: 'pt-BR',
  titleSuffix: ' — WhatsApp Backup',
  searchPlaceholder: 'Buscar…',
  searchLabel: 'Buscar mensagens',
  senderLabel: 'Filtrar por remetente',
  allSenders: 'Todos os contatos',
  theme: '🌓 Tema',
};

const BY_LANG: Record<ExportLang, RenderLabels> = {
  ca: {
    locale: 'ca',
    titleSuffix: '',
    searchPlaceholder: 'Cerca…',
    searchLabel: 'Cerca als missatges',
    senderLabel: 'Filtra per remitent',
    allSenders: 'Tots els remitents',
    theme: '🌓 Tema',
  },
  es: {
    locale: 'es',
    titleSuffix: '',
    searchPlaceholder: 'Buscar…',
    searchLabel: 'Buscar en los mensajes',
    senderLabel: 'Filtrar por remitente',
    allSenders: 'Todos los remitentes',
    theme: '🌓 Tema',
  },
  en: {
    locale: 'en',
    titleSuffix: '',
    searchPlaceholder: 'Search…',
    searchLabel: 'Search messages',
    senderLabel: 'Filter by sender',
    allSenders: 'All senders',
    theme: '🌓 Theme',
  },
};

export function labelsFor(lang?: ExportLang): RenderLabels {
  return lang ? BY_LANG[lang] : LEGACY;
}

/** "01 de gener de 2026"-style heading for a `yyyy-mm-dd` day. Noon UTC avoids TZ/DST drift. */
export function formatDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(day + 'T12:00:00Z'),
  );
}

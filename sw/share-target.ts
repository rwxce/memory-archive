import { storeSharedFiles } from '../lib/storage/share-inbox';

/** `share_target.action` in the manifest, relative to the app scope. */
export const SHARE_TARGET_PATH = 'share-target/';
/** Form field the manifest declares for shared files. */
export const SHARE_TARGET_FILES_FIELD = 'files';

/**
 * Handle the Web Share Target POST: keep the shared ZIP / TXT files in the
 * share inbox and send the person to the import screen (`/?to=import`, which
 * picks their language). Always answers with a 303 redirect so a reload never
 * re-posts the files.
 */
export async function handleShareTarget(
  request: Request,
  cacheStorage: CacheStorage,
  scopeUrl: string,
): Promise<Response> {
  let stored = 0;
  try {
    const form = await request.formData();
    const files = form.getAll(SHARE_TARGET_FILES_FIELD).filter((v): v is File => typeof v !== 'string');
    stored = await storeSharedFiles(cacheStorage, scopeUrl, files);
  } catch {
    // Unreadable form or storage full: the import screen shows what arrived.
  }
  const target = new URL('./', scopeUrl);
  target.searchParams.set('to', 'import');
  target.searchParams.set('received', String(stored));
  return Response.redirect(target.href, 303);
}

/** UI locales; the offline fallback picks the page in the request's language. */
export const SW_LOCALES = ['en', 'ca', 'es'] as const;

/** Precached offline page for a navigation to `pathname` (under `basePath`). */
export function offlinePageFor(pathname: string, basePath: string): string {
  const rest = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
  const first = rest.split('/')[1] ?? '';
  const locale = (SW_LOCALES as readonly string[]).includes(first) ? first : SW_LOCALES[0];
  return `${basePath}/${locale}/offline/index.html`;
}

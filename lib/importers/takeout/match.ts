/**
 * Which sidecar belongs to which picture. Takeout names sidecars after the picture, but with
 * variants that all exist in real exports:
 *
 * - `IMG_1.jpg.json` (older exports) and `IMG_1.jpg.supplemental-metadata.json` (newer ones);
 * - long names: the whole sidecar name is cut to about 46 characters before `.json`, so the
 *   suffix is shortened (`IMG_1.jpg.supplemental-meta.json`) or, for a long picture name, the
 *   picture name itself is cut (`<first 46 characters>.json`);
 * - duplicates: `IMG_1(1).jpg` has the sidecar `IMG_1.jpg(1).json`;
 * - edited copies: `IMG_1-edited.jpg` has NO sidecar of its own, it uses `IMG_1.jpg`'s.
 *
 * Name matching is tried first; a match that relied on a cut name must be confirmed by the
 * sidecar's own `title` (a sidecar without a title is not accepted that way) (so two long names sharing a prefix do not take each other's dates).
 * Pictures without a name match fall back to the unique sidecar whose `title` is exactly their name
 * and that no other picture claimed, then to the sidecar of their live-photo partner (same folder,
 * same name, other kind). Localized "edited" suffixes
 * ("-bearbeitet", "-modifié", ...) are not recognised: such a file is imported without metadata.
 */

const SUFFIX = '.supplemental-metadata';
/** Google cuts `<name>.supplemental-metadata` to this many characters before `.json`. */
const CUT = 46;
const DUPLICATE = /^(.*)\((\d+)\)(\.[^./]*)$/;
const EDITED = /^(.*)-edited(\.[^./]*)$/;

/** The names a picture's sidecar can be filed under, best first, each with whether a cut name was involved. */
export function sidecarCandidates(fileName: string): { name: string; cut: boolean }[] {
  const out: { name: string; cut: boolean }[] = [];
  const seen = new Set<string>();
  const push = (name: string, cut: boolean) => {
    if (!seen.has(name)) {
      seen.add(name);
      out.push({ name, cut });
    }
  };
  for (const base of nameVariants(fileName)) {
    push(`${base}.json`, false);
    push(`${base}${SUFFIX}.json`, false);
    const full = `${base}${SUFFIX}`;
    for (let k = Math.min(CUT, full.length - 1); k > base.length; k--) push(`${full.slice(0, k)}.json`, true);
    if (base.length > CUT) push(`${base.slice(0, CUT)}.json`, true);
  }
  return out;
}

/** The picture's name, then the same with `(n)` moved the way sidecars write it, then without `-edited`. */
function nameVariants(fileName: string): string[] {
  const variants = [fileName];
  const dup = DUPLICATE.exec(fileName);
  if (dup) variants.push(`${dup[1]}${dup[3]}(${dup[2]})`);
  for (const v of [...variants]) {
    const edited = EDITED.exec(v);
    if (edited) variants.push(`${edited[1]}${edited[2]}`);
  }
  return variants;
}

/** The titles Google may have recorded for a picture: its name without `(n)` and/or `-edited`. */
export function titleKeys(fileName: string): Set<string> {
  const keys = new Set<string>([fileName]);
  for (const key of [...keys]) {
    const dup = DUPLICATE.exec(key);
    if (dup) keys.add(`${dup[1]}${dup[3]}`);
  }
  for (const key of [...keys]) {
    const edited = EDITED.exec(key);
    if (edited) keys.add(`${edited[1]}${edited[2]}`);
  }
  return keys;
}

export interface SidecarInfo {
  name: string;
  title: string | null;
}

/**
 * The sidecar of `fileName` by its name, or null. A match that relied on a cut name is accepted
 * only when the sidecar's own `title` confirms it (a sidecar without a title does not).
 */
export function findSidecarByName(fileName: string, sidecars: ReadonlyMap<string, SidecarInfo>): SidecarInfo | null {
  const keys = titleKeys(fileName);
  for (const candidate of sidecarCandidates(fileName)) {
    const found = sidecars.get(candidate.name);
    if (!found) continue;
    if (candidate.cut && (found.title === null || !keys.has(found.title))) continue;
    return found;
  }
  return null;
}

/**
 * Fallback for a picture no name matched: the one sidecar whose `title` is exactly its name and
 * that no other picture claimed by name. The exact name is required (`IMG_1(1).jpg` must not
 * take the sidecar titled `IMG_1.jpg`, which belongs to the original).
 */
export function findSidecarByTitle(fileName: string, sidecars: ReadonlyMap<string, SidecarInfo>, claimed: ReadonlySet<string>): SidecarInfo | null {
  const byTitle = [...sidecars.values()].filter((s) => s.title === fileName && !claimed.has(s.name));
  return byTitle.length === 1 ? byTitle[0] : null;
}

/** A picture and its live-photo video share the name without extension (same folder, same case). */
export function livePhotoKey(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

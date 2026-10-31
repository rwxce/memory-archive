import { viewerOffset } from '@/hooks/viewer-offset';
import { photoDisplayDate, type PhotoDisplayDate, type PhotoPicture } from '@/lib/domain/photo';

export { viewerOffset };

export interface PhotoDay {
  /** Unique within the list, even if the same day shows up twice (a rare mix of zones). */
  key: string;
  /** `YYYY-MM-DD`, or null for the pictures with no date. */
  day: string | null;
  pictures: PhotoPicture[];
  /** Every picture of the day has a guessed date. */
  allEstimated: boolean;
}

export interface ShownPicture {
  picture: PhotoPicture;
  when: PhotoDisplayDate | null;
}

/** The date of a picture as shown (the one rule, with the viewer's zone). */
export const shownDate = (picture: PhotoPicture, offset = viewerOffset): PhotoDisplayDate | null => photoDisplayDate(picture, offset);

/**
 * Groups the pictures, in the order given, into days of their DISPLAYED date. A new group starts whenever the
 * displayed day changes, so the list order is never rearranged; undated pictures end up in one last group.
 */
export function groupByDay(pictures: readonly PhotoPicture[], offset = viewerOffset): PhotoDay[] {
  const days: PhotoDay[] = [];
  const seen = new Map<string, number>();
  for (const picture of pictures) {
    const when = shownDate(picture, offset);
    const day = when?.day ?? null;
    let current = days[days.length - 1];
    if (!current || current.day !== day) {
      const id = day ?? 'undated';
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      current = { key: n === 1 ? id : `${id}:${n}`, day, pictures: [], allEstimated: true };
      days.push(current);
    }
    current.pictures.push(picture);
    if (!when?.approximate) current.allEstimated = false;
  }
  return days;
}

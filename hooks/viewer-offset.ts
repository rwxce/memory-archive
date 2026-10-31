/** The viewer's own UTC offset (minutes) at an instant: the zone a date recorded as a UTC instant is shown in. */
export const viewerOffset = (epochMs: number): number => -new Date(epochMs).getTimezoneOffset();

/**
 * The index a radio group moves to for a key, as native radios do: arrows step (wrapping),
 * Home and End jump. `undefined` when the key is not one of those. In right-to-left text the
 * horizontal arrows swap.
 */
export function nextRadioIndex(key: string, from: number, count: number, rtl = false): number | undefined {
  const last = count - 1;
  let to: number;
  if (key === 'ArrowRight') to = rtl ? from - 1 : from + 1;
  else if (key === 'ArrowLeft') to = rtl ? from + 1 : from - 1;
  else if (key === 'ArrowDown') to = from + 1;
  else if (key === 'ArrowUp') to = from - 1;
  else if (key === 'Home') to = 0;
  else if (key === 'End') to = last;
  else return undefined;
  return to < 0 ? last : to > last ? 0 : to;
}

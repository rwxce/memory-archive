/** Consecutive items of the same month (`sentAt` stamps, oldest first), keyed `YYYY-MM`. */
export function groupByMonth<T extends { sentAt: string }>(items: T[]): Array<{ month: string; items: T[] }> {
  const groups: Array<{ month: string; items: T[] }> = [];
  for (const item of items) {
    const month = item.sentAt.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last?.month === month) last.items.push(item);
    else groups.push({ month, items: [item] });
  }
  return groups;
}

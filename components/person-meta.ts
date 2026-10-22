import type { Person } from '@/lib/usecases/library';

/** Who comes first on People: the active person whose last message is the most recent. `undefined` when no one has messages. */
export function featuredPerson(people: readonly Person[]): Person | undefined {
  let best: Person | undefined;
  for (const person of people) {
    // Local ISO stamps of one fixed width: string order is time order.
    if (person.lastMessageAt !== null && (best === undefined || person.lastMessageAt > (best.lastMessageAt as string))) best = person;
  }
  return best;
}

/** "2014–2024", or one year, or '' when the person has no dated messages. */
export function yearSpan(person: Pick<Person, 'firstMessageAt' | 'lastMessageAt'>): string {
  if (!person.firstMessageAt || !person.lastMessageAt) return '';
  const a = person.firstMessageAt.slice(0, 4);
  const b = person.lastMessageAt.slice(0, 4);
  return a === b ? a : `${a}–${b}`;
}

/** "Mother · 3 conversations · 2014–2024": the parts that exist, joined by a middle dot. */
export function personMeta(person: Person, conversations: (count: number) => string): string {
  return [person.relationship, conversations(person.conversationCount), yearSpan(person)].filter(Boolean).join(' · ');
}

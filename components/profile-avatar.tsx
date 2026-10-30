'use client';

import type { ComponentProps } from 'react';
import { useProfilePhotoUrl } from '@/hooks/use-people';
import { PersonAvatar } from './person-avatar';

/** `PersonAvatar` for a stored profile: shows its photo when it has one, the initial otherwise. */
export function ProfileAvatar({ person, ...rest }: { person: { id: string; displayName: string; photoSha256: string | null } } & Omit<ComponentProps<typeof PersonAvatar>, 'name' | 'photoUrl'>) {
  const photoUrl = useProfilePhotoUrl(person.id, person.photoSha256);
  return <PersonAvatar name={person.displayName} photoUrl={photoUrl} {...rest} />;
}

import { afterEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { renderWithLibrary, settle, type Rendered } from '@/components/test-utils';
import { useLibrary } from './use-library';
import { usePeople, useProfileActions, type ProfileActions } from './use-people';

let actions: ProfileActions | undefined;
let names: string[] = [];

function Probe() {
  useLibrary();
  const people = usePeople();
  actions = useProfileActions();
  names = people.status === 'ready' ? people.people.active.map((p) => p.displayName) : [];
  return <p data-testid="names">{names.join(',')}</p>;
}

describe('usePeople / useProfileActions', () => {
  let view: Rendered | undefined;
  afterEach(() => view?.unmount());

  test('an action resolves only after the list on screen has been read again', async () => {
    view = await renderWithLibrary(<Probe />);
    await settle();
    const order: string[] = [];
    const lib = (view as Rendered & { lib: { deps: { client: { call: (op: string, ...a: unknown[]) => Promise<unknown> } } } }).lib;
    const call = lib.deps.client.call.bind(lib.deps.client);
    lib.deps.client.call = async (op, ...args) => {
      const result = await call(op, ...args);
      order.push(op);
      return result;
    };
    await act(async () => {
      await actions!.create({ displayName: 'Ana' });
      order.push('resolved');
    });
    expect(order).toEqual(['createProfile', 'listProfiles', 'listConversations', 'resolved']);
    expect(view.container.querySelector('[data-testid="names"]')?.textContent).toBe('Ana');
  });

  test('a failed write rejects and leaves the list as it was', async () => {
    view = await renderWithLibrary(<Probe />);
    await settle();
    await act(async () => {
      await actions!.create({ displayName: 'Ana' });
    });
    expect(names).toEqual(['Ana']);
    await act(async () => {
      await expect(actions!.update('99999999-9999-4999-8999-999999999999', { displayName: 'Nobody' })).rejects.toMatchObject({
        code: 'not-found',
      });
    });
    expect(names).toEqual(['Ana']);
    expect(view.container.querySelector('[data-testid="names"]')?.textContent).toBe('Ana');
  });
});

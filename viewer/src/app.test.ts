import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mountViewer } from './app';
import { bootViewer } from './boot';
import { HASH, conversation, manyMessages, message, viewerData } from './test-data';
import { serializeViewerData } from '../../lib/exporters/viewer/format';

let root: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});
afterEach(() => {
  document.body.replaceChildren();
});

const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T;
const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
const tick = () => new Promise((r) => setTimeout(r, 10));

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('viewer app', () => {
  test('hostile titles, authors, text and file names are shown as text and nothing executes', () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const data = viewerData({
      profiles: [{ id: 'p1', displayName: evil, relationship: '', description: '' }],
      conversations: [
        conversation({
          title: evil,
          isGroup: true,
          messages: [
            message({ author: evil, text: `${evil} javascript:alert(1) [x](javascript:alert(2)) https://example.com/ok` }),
            message({ author: 'Ada', text: '', mediaName: evil, sentAt: '2024-01-02T10:01:00' }),
            message({ author: null, isMe: false, text: evil, sentAt: '2024-01-02T10:02:00' }),
          ],
        }),
      ],
    });
    mountViewer(root, data, { locale: 'en' });
    q('button[data-conv]').click();
    expect(root.querySelector('script, img[onerror], [onerror], iframe')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(q('.title').textContent).toBe(evil);
    expect(qa('.author').map((e) => e.textContent)).toContain(evil);
    expect(q('.file-name').textContent).toBe(evil);
    const links = qa('.thread a[href]');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/ok']);
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0].getAttribute('target')).toBe('_blank');
  });

  test('media: image, video, audio, document by relative path; a missing file shows its name', () => {
    const p = (ext: string, c: string) => `media/${c.repeat(64)}.${ext}`;
    const data = viewerData({
      media: [{ sha256: HASH, path: p('jpg', 'a'), size: 1, mime: 'image/jpeg' }],
      conversations: [
        conversation({
          messages: [
            message({ media: p('jpg', 'a'), mediaName: 'IMG-1.jpg', sentAt: '2024-01-02T10:00:00' }),
            message({ media: p('mp4', 'b'), mediaName: 'VID.mp4', sentAt: '2024-01-02T10:01:00' }),
            message({ media: p('ogg', 'c'), mediaName: 'PTT.ogg', sentAt: '2024-01-02T10:02:00' }),
            message({ media: p('pdf', 'd'), mediaName: 'plan.pdf', sentAt: '2024-01-02T10:03:00' }),
            message({ media: null, mediaName: 'gone.docx', text: 'caption', sentAt: '2024-01-02T10:04:00' }),
          ],
        }),
      ],
    });
    mountViewer(root, data, { locale: 'en' });
    q('button[data-conv]').click();
    expect(q('img').getAttribute('src')).toBe(p('jpg', 'a'));
    expect(q('video').getAttribute('src')).toBe(p('mp4', 'b'));
    expect(q('audio').getAttribute('src')).toBe(p('ogg', 'c'));
    expect(qa('a.file').map((a) => a.getAttribute('href'))).toContain(p('pdf', 'd'));
    expect(q('.file.missing').textContent).toContain('gone.docx');
    expect(q('.file.missing').textContent).toContain('File not included');
  });

  test('a long conversation opens at the end with a bounded number of nodes, and earlier messages load on demand', () => {
    const data = viewerData({ conversations: [conversation({ messages: manyMessages(5000) })] });
    mountViewer(root, data, { locale: 'en' });
    q('button[data-conv]').click();
    expect(qa('.items > li').length).toBe(150);
    expect(q('.items').lastElementChild!.textContent).toContain('message number 4999');
    expect(q('.btn.wide[hidden]').textContent).toBe('Show later messages');
    for (let i = 0; i < 12; i++) qa('.btn.wide').find((b) => b.textContent === 'Show earlier messages')!.click();
    expect(qa('.items > li').length).toBeLessThanOrEqual(450);
    expect(q('.items > li:first-child').getAttribute('data-pos')).not.toBe('4850');
  });

  test('a timeline jump renders the window around that month', () => {
    const data = viewerData({ conversations: [conversation({ messages: manyMessages(3000) })] });
    mountViewer(root, data, { locale: 'en' });
    q('button[data-conv]').click();
    const years = qa('#mv-year option').map((o) => o.getAttribute('value'));
    expect(years).toEqual(['2020', '2021', '2022']);
    const year = q<HTMLSelectElement>('#mv-year');
    year.value = '2020';
    year.dispatchEvent(new Event('change'));
    expect(q('.items > li').textContent).toContain('message number 0');
    expect(qa('#mv-month option')).toHaveLength(12);
    const slider = q<HTMLInputElement>('#mv-pos');
    slider.value = '2000';
    slider.dispatchEvent(new Event('change'));
    expect(qa('.items > li').some((li) => li.textContent?.includes('message number 2000'))).toBe(true);
  });

  test('search highlights hits, results open the conversation at the message, with next/previous', async () => {
    const data = viewerData({
      conversations: [
        conversation({ id: 'a', title: 'First', messages: [message({ text: 'The Camí is long' }), message({ sentAt: '2024-01-03T10:00:00', text: 'again cami here' })] }),
        conversation({ id: 'b', title: 'Second', messages: [message({ text: 'nothing' })] }),
      ],
    });
    mountViewer(root, data, { locale: 'en', searchDelayMs: 0 });
    type(q<HTMLInputElement>('#mv-search'), 'CAMI');
    await tick();
    const results = qa('button.result');
    expect(results).toHaveLength(2);
    expect(results[0].querySelector('mark')!.textContent).toBe('Camí');
    expect(q('section[aria-label="Search results"] p').textContent).toBe('2 messages found.');
    results[1].click();
    expect(q('.title').textContent).toBe('First');
    expect(q('.msg.hit .text').textContent).toBe('again cami here');
    expect(qa('.items mark').map((m) => m.textContent)).toEqual(['Camí', 'cami']);
    expect(q('.matchnav').hidden).toBe(false);
    qa('.matchnav button')[0].click();
    expect(q('.msg.hit .text').textContent).toBe('The Camí is long');
    expect(q('.matchnav span').textContent).toBe('Match 1 of 2');
    type(q<HTMLInputElement>('#mv-search'), '');
    await tick();
    expect(root.querySelector('.items mark')).toBeNull();
    expect(q('.matchnav').hidden).toBe(true);
  });

  test('the date filter narrows the list and the thread; reversed dates are reported', () => {
    const data = viewerData({
      conversations: [
        conversation({ id: 'a', title: 'Old', messages: [message({ sentAt: '2019-01-01T10:00:00' })] }),
        conversation({ id: 'b', title: 'New', messages: [message({ sentAt: '2024-01-01T10:00:00' }), message({ sentAt: '2024-06-01T10:00:00', text: 'later' })] }),
      ],
    });
    mountViewer(root, data, { locale: 'en' });
    expect(qa('button.conv')).toHaveLength(2);
    const from = q<HTMLInputElement>('#mv-from');
    from.value = '2024-03-01';
    from.dispatchEvent(new Event('change'));
    expect(qa('button.conv').map((b) => b.querySelector('.conv-title')!.textContent)).toEqual(['New']);
    q('button.conv').click();
    expect(qa('.items > li')).toHaveLength(1);
    const to = q<HTMLInputElement>('#mv-to');
    to.value = '2024-01-01';
    to.dispatchEvent(new Event('change'));
    expect(q('.note-error').hidden).toBe(false);
    expect(qa('button.conv')).toHaveLength(0);
  });

  test('the profile switcher shows only with several profiles and filters the list', () => {
    const one = viewerData();
    mountViewer(root, one, { locale: 'en' });
    expect(q('#mv-profile').closest('.field')!.hasAttribute('hidden')).toBe(true);
    const two = viewerData({
      profiles: [
        { id: 'p1', displayName: 'Ada', relationship: '', description: '' },
        { id: 'p2', displayName: 'Bo', relationship: '', description: '' },
      ],
      conversations: [conversation({ id: 'a', title: 'A', profileIds: ['p1'] }), conversation({ id: 'b', title: 'B', profileIds: ['p2'] })],
    });
    mountViewer(root, two, { locale: 'es' });
    expect(qa('button.conv')).toHaveLength(2);
    const sel = q<HTMLSelectElement>('#mv-profile');
    sel.value = 'p2';
    sel.dispatchEvent(new Event('change'));
    expect(qa('button.conv .conv-title').map((e) => e.textContent)).toEqual(['B']);
    expect(q('label[for=mv-profile]').textContent).toBe('Perfil');
  });
});

describe('boot', () => {
  const island = (json: string) => {
    const s = document.createElement('script');
    s.type = 'application/json';
    s.id = 'viewer-data';
    s.textContent = json;
    document.body.append(s);
  };

  test('mounts valid data and picks the language', () => {
    island(serializeViewerData(viewerData()));
    bootViewer(document, ['ca-ES']);
    expect(document.documentElement.lang).toBe('ca');
    expect(q('h1').textContent).toBe('Memory Archive');
    expect(q('h2').textContent).toBe('Converses');
  });

  test('a newer schema, damaged data and a missing island show a clear message and no archive text', () => {
    island(JSON.stringify({ ...viewerData(), schemaVersion: 99 }));
    bootViewer(document, ['en']);
    expect(root.textContent).toContain('newer version');
    document.getElementById('viewer-data')!.textContent = '{"secret":"SECRET-TEXT"';
    bootViewer(document, ['en']);
    expect(root.textContent).toContain('damaged');
    expect(root.textContent).not.toContain('SECRET');
    document.getElementById('viewer-data')!.remove();
    bootViewer(document, ['es']);
    expect(root.textContent).toContain('no contiene datos');
  });
});

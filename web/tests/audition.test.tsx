// The audition page in a simulated DOM: a take the listener ruled out is marked but still playable.

import { afterAll, afterEach, expect, test } from 'bun:test';

const { cleanup, render } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { PlayerProvider } = await import('@/components/player');
const { AuditionPage } = await import('@/routes/audition');
type Audition = import('../../src/audition').Audition;

const page: Audition = {
  title: '盲听',
  sections: [
    {
      title: '整首',
      rows: [
        {
          label: '全部版本',
          takes: [
            { src: 'A.ogg', label: 'A', dropped: true },
            { src: 'B.ogg', label: 'B' },
          ],
        },
      ],
    },
  ],
};

/** The server as the page sees it: the audition, and picks that answer with what was sent. */
const sent: unknown[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (!String(url).startsWith('/api/picks/')) return Response.json(page);
  if (init?.method !== 'PUT') return Response.json({});
  const update = JSON.parse(String(init.body));
  sent.push(update);
  return Response.json({ [update.section]: { [update.row]: update.pick } });
}) as unknown as typeof fetch;
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

function show() {
  // A re-registered DOM can report itself offline, which would hold the query instead of fetching.
  const client = new QueryClient({
    defaultOptions: { queries: { networkMode: 'always' }, mutations: { networkMode: 'always' } },
  });
  // Queries bound to this render: `screen` keeps the document of whichever test file loaded it first.
  return render(
    <QueryClientProvider client={client}>
      <PlayerProvider>
        <AuditionPage name='songs' />
      </PlayerProvider>
    </QueryClientProvider>,
  );
}

test('marks a dropped take and leaves it playable', async () => {
  const { findByRole, getByRole } = show();
  const dropped = await findByRole('button', { name: 'A 淘汰' });
  const kept = getByRole('button', { name: 'B' });
  expect(dropped.className).toContain('opacity-55');
  expect(dropped.hasAttribute('disabled')).toBe(false);
  expect(kept.className).not.toContain('opacity-55');
});

test('records the take the listener chooses, and choosing it again clears it', async () => {
  const { findByRole } = show();
  const choice = await findByRole('button', { name: '选 B', pressed: false });
  choice.click();
  await findByRole('button', { name: '选 B', pressed: true });
  expect(sent.at(-1)).toEqual({ section: '整首', row: '全部版本', pick: { take: 'B' } });
  choice.click();
  await findByRole('button', { name: '选 B', pressed: false });
  expect(sent.at(-1)).toEqual({ section: '整首', row: '全部版本', pick: {} });
});

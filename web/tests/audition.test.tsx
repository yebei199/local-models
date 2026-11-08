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

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => Response.json(page)) as unknown as typeof fetch;
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
});

test('marks a dropped take and leaves it playable', async () => {
  // A re-registered DOM can report itself offline, which would hold the query instead of fetching.
  const client = new QueryClient({ defaultOptions: { queries: { networkMode: 'always' } } });
  // Queries bound to this render: `screen` keeps the document of whichever test file loaded it first.
  const { findByRole, getByRole } = render(
    <QueryClientProvider client={client}>
      <PlayerProvider>
        <AuditionPage name='songs' />
      </PlayerProvider>
    </QueryClientProvider>,
  );
  const dropped = await findByRole('button', { name: 'A 淘汰' });
  const kept = getByRole('button', { name: 'B' });
  expect(dropped.className).toContain('opacity-55');
  expect(dropped.hasAttribute('disabled')).toBe(false);
  expect(kept.className).not.toContain('opacity-55');
});

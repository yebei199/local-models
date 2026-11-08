// Typed reads of model-web's JSON API through TanStack Query.
import { queryOptions } from '@tanstack/react-query';
import type { Audition, Entry, Machine } from '../../../src/audition';

/** Server and app are built from one commit and share these types, so the body is trusted as T;
 * a non-2xx answer carries the server's own message, which the page shows verbatim. */
async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

export const pagesQuery = queryOptions({
  queryKey: ['pages'],
  queryFn: () => get<Entry[]>('/api/pages'),
});

/** Polled, because it answers whether the GPU is free right now. */
export const machineQuery = queryOptions({
  queryKey: ['machine'],
  queryFn: () => get<Machine | null>('/api/machine'),
  refetchInterval: 5000,
});

export const auditionQuery = (name: string) =>
  queryOptions({
    queryKey: ['audition', name],
    queryFn: () => get<Audition>(`/api/auditions/${encodeURIComponent(name)}`),
    retry: false,
  });

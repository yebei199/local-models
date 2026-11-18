// An audition page: rows of versions, all played through the one shared player.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { type Track, usePlayer } from '@/components/player';
import { Button } from '@/components/ui/button';
import { Verdict } from '@/components/verdict';
import { auditionQuery, picksQuery, savePick } from '@/lib/api';
import {
  applyPick,
  type Pick,
  type Picks,
  type PickUpdate,
  type Row,
  type Section,
  type Stanza,
} from '../../../src/audition';

type Save = (update: PickUpdate) => void;

/** Every take in a row as a track; ids are positional, since the data has no other stable key. */
function tracks(section: Section, sectionAt: number, row: Row, rowAt: number): Track[] {
  return row.takes.map((take, at) => ({
    id: `${sectionAt}.${rowAt}.${at}`,
    src: take.src,
    title: `${section.title} · ${row.label} · ${take.label}`,
  }));
}

function RowBlock({
  row,
  list,
  pick,
  save,
}: {
  row: Row;
  list: Track[];
  pick: Pick | undefined;
  save: (pick: Pick) => void;
}) {
  const { current, choose } = usePlayer();
  return (
    <div className='grid gap-x-5 gap-y-2 border-t border-line py-3 first:border-t-0 md:grid-cols-[minmax(10em,16em)_minmax(0,1fr)]'>
      <div>
        <span className='font-semibold'>{row.label}</span>
        {row.note && <span className='block text-sm text-mute'>{row.note}</span>}
      </div>
      <div className='grid gap-2'>
        <div className='flex flex-wrap gap-2'>
          {row.takes.map((take, at) => {
            const track = list[at] as Track;
            return (
              <Button
                key={track.id}
                data-track={track.id}
                size='sm'
                aria-pressed={current?.id === track.id}
                className={take.dropped ? 'opacity-55' : undefined}
                onClick={() => choose(track, list)}
              >
                <span className={take.dropped ? 'line-through' : undefined}>{take.label}</span>
                {take.meta && <span className='text-mute tabular-nums'>{take.meta}</span>}
                {take.dropped && <span className='text-xs text-mute'>淘汰</span>}
              </Button>
            );
          })}
        </div>
        <Verdict row={row} pick={pick} save={save} />
      </div>
    </div>
  );
}

function SectionBlock({
  section,
  at,
  picks,
  save,
}: {
  section: Section;
  at: number;
  picks: Picks;
  save: Save;
}) {
  return (
    <section className='mt-9'>
      <h2 className='text-[19px] font-semibold'>{section.title}</h2>
      {section.note && <p className='mt-1 text-sm text-mute'>{section.note}</p>}
      <div className='mt-3 rounded-xl border border-line bg-panel px-4'>
        {section.rows.map((row, rowAt) => (
          <RowBlock
            key={row.label}
            row={row}
            list={tracks(section, at, row, rowAt)}
            pick={picks[section.title]?.[row.label]}
            save={(pick) => save({ section: section.title, row: row.label, pick })}
          />
        ))}
      </div>
    </section>
  );
}

/** Each line with its translation under it, so the takes can be followed while listening. */
function Lyrics({ stanzas }: { stanzas: Stanza[] }) {
  return (
    <section className='mt-9'>
      <h2 className='text-[19px] font-semibold'>歌词</h2>
      <div className='mt-3 grid gap-5 rounded-xl border border-line bg-panel px-4 py-4 md:grid-cols-2'>
        {stanzas.map((stanza, at) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stanzas have no identity beyond their order
          <div key={at}>
            {stanza.label && <div className='text-sm text-accent'>[{stanza.label}]</div>}
            {stanza.lines.map((line, lineAt) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a line can repeat within a stanza
              <p key={lineAt} className='mt-1.5'>
                <span className='block'>{line.text}</span>
                {line.translation && (
                  <span className='block text-sm text-mute'>{line.translation}</span>
                )}
              </p>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Picks show at once and roll back if the server refuses; its answer then replaces the guess. */
function usePicks(name: string): { picks: Picks; save: Save; failure: Error | null } {
  const client = useQueryClient();
  const key = picksQuery(name).queryKey;
  const { data } = useQuery(picksQuery(name));
  const mutation = useMutation({
    mutationFn: (update: PickUpdate) => savePick(name, update),
    onMutate: async (update) => {
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData(key);
      client.setQueryData(key, applyPick(before ?? {}, update));
      return { before };
    },
    onError: (_error, _update, context) => client.setQueryData(key, context?.before),
    onSuccess: (stored) => client.setQueryData(key, stored),
  });
  return { picks: data ?? {}, save: mutation.mutate, failure: mutation.error };
}

export function AuditionPage({ name }: { name: string }) {
  const { data, error } = useQuery(auditionQuery(name));
  const { picks, save, failure } = usePicks(name);
  useEffect(() => {
    if (data) document.title = data.title;
  }, [data]);
  return (
    <main className='mx-auto max-w-[1040px] px-6 pt-9 pb-32'>
      <a className='mb-3.5 inline-block text-sm text-mute no-underline hover:text-accent' href='/'>
        ← 全部试听
      </a>
      {error && <pre className='whitespace-pre-wrap text-busy'>{error.message}</pre>}
      {failure && (
        <p className='mb-3 text-sm text-busy' role='alert'>
          没保存上：{failure.message}
        </p>
      )}
      {data && (
        <>
          <h1 className='text-[28px] leading-tight font-bold'>{data.title}</h1>
          {data.description && <p className='mt-2 max-w-[42em] text-mute'>{data.description}</p>}
          {data.sections.map((section, at) => (
            <SectionBlock key={section.title} section={section} at={at} picks={picks} save={save} />
          ))}
          {data.lyrics && <Lyrics stanzas={data.lyrics} />}
        </>
      )}
    </main>
  );
}

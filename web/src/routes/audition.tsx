// An audition page: rows of versions, all played through the one shared player.
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { type Track, usePlayer } from '@/components/player';
import { Button } from '@/components/ui/button';
import { auditionQuery } from '@/lib/api';
import type { Row, Section, Stanza } from '../../../src/audition';

/** Every take in a row as a track; ids are positional, since the data has no other stable key. */
function tracks(section: Section, sectionAt: number, row: Row, rowAt: number): Track[] {
  return row.takes.map((take, at) => ({
    id: `${sectionAt}.${rowAt}.${at}`,
    src: take.src,
    title: `${section.title} · ${row.label} · ${take.label}`,
  }));
}

function RowBlock({ row, list }: { row: Row; list: Track[] }) {
  const { current, choose } = usePlayer();
  return (
    <div className='grid gap-x-5 gap-y-2 border-t border-line py-3 first:border-t-0 md:grid-cols-[minmax(10em,16em)_minmax(0,1fr)]'>
      <div>
        <span className='font-semibold'>{row.label}</span>
        {row.note && <span className='block text-sm text-mute'>{row.note}</span>}
      </div>
      <div className='flex flex-wrap gap-2'>
        {row.takes.map((take, at) => {
          const track = list[at] as Track;
          return (
            <Button
              key={track.id}
              data-track={track.id}
              size='sm'
              aria-pressed={current?.id === track.id}
              onClick={() => choose(track, list)}
            >
              <span>{take.label}</span>
              {take.meta && <span className='text-mute tabular-nums'>{take.meta}</span>}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function SectionBlock({ section, at }: { section: Section; at: number }) {
  return (
    <section className='mt-9'>
      <h2 className='text-[19px] font-semibold'>{section.title}</h2>
      {section.note && <p className='mt-1 text-sm text-mute'>{section.note}</p>}
      <div className='mt-3 rounded-xl border border-line bg-panel px-4'>
        {section.rows.map((row, rowAt) => (
          <RowBlock key={row.label} row={row} list={tracks(section, at, row, rowAt)} />
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

export function AuditionPage({ name }: { name: string }) {
  const { data, error } = useQuery(auditionQuery(name));
  useEffect(() => {
    if (data) document.title = data.title;
  }, [data]);
  return (
    <main className='mx-auto max-w-[1040px] px-6 pt-9 pb-32'>
      <a className='mb-3.5 inline-block text-sm text-mute no-underline hover:text-accent' href='/'>
        ← 全部试听
      </a>
      {error && <pre className='whitespace-pre-wrap text-busy'>{error.message}</pre>}
      {data && (
        <>
          <h1 className='text-[28px] leading-tight font-bold'>{data.title}</h1>
          {data.description && <p className='mt-2 max-w-[42em] text-mute'>{data.description}</p>}
          {data.sections.map((section, at) => (
            <SectionBlock key={section.title} section={section} at={at} />
          ))}
          {data.lyrics && <Lyrics stanzas={data.lyrics} />}
        </>
      )}
    </main>
  );
}

// Home: machine state first, because it decides whether a job can start now; then the newest pages.
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { machineQuery, pagesQuery } from '@/lib/api';
import type { Entry, Machine } from '../../../src/audition';

function Busy({ name, on }: { name: string; on: boolean }) {
  return (
    <div>
      <div className='text-sm text-mute'>{name}</div>
      <Badge tone={on ? 'on' : 'idle'}>{on ? '运行中' : '空闲'}</Badge>
    </div>
  );
}

function State({ machine }: { machine: Machine }) {
  const gib = (mib: number) => (mib / 1024).toFixed(1);
  const share = Math.round((machine.usedMib / machine.totalMib) * 100);
  return (
    <div className='mt-6 grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-x-7 gap-y-2 rounded-xl border border-line bg-panel px-4 py-3.5'>
      <div>
        <div className='text-sm text-mute'>显存</div>
        <div className='font-semibold tabular-nums'>
          {gib(machine.usedMib)} / {gib(machine.totalMib)} GiB
        </div>
        <div className='mt-1.5 h-1.5 overflow-hidden rounded-full bg-soft'>
          <span className='block h-full bg-accent' style={{ width: `${share}%` }} />
        </div>
      </div>
      <Busy name='语音' on={machine.speech} />
      <Busy name='生图' on={machine.images} />
    </div>
  );
}

function Page({ entry }: { entry: Entry }) {
  const count = entry.takes ? `${entry.takes} 段 · ` : '';
  return (
    <li>
      <a
        className='grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 rounded-xl border border-line bg-panel px-4 py-3 no-underline hover:border-accent'
        href={entry.href}
      >
        <span className='font-semibold'>{entry.title}</span>
        <span className='row-span-2 self-center text-sm tabular-nums text-mute'>
          {count}
          {entry.modified.slice(5, 10)}
        </span>
        {entry.description && <span className='text-sm text-mute'>{entry.description}</span>}
      </a>
    </li>
  );
}

export function Home() {
  const pages = useQuery(pagesQuery);
  const machine = useQuery(machineQuery);
  let list = <p className='mt-6 text-mute'>读取中……</p>;
  if (pages.error) list = <p className='mt-6 text-busy'>{pages.error.message}</p>;
  else if (pages.data?.length === 0)
    list = <p className='mt-6 text-mute'>还没有页面。把试听放进页面目录后会出现在这里。</p>;
  else if (pages.data)
    list = (
      <ul className='mt-6 grid list-none gap-2.5 p-0'>
        {pages.data.map((entry) => (
          <Page key={entry.href} entry={entry} />
        ))}
      </ul>
    );
  return (
    <main className='mx-auto max-w-[1040px] px-6 pt-9 pb-32'>
      <h1 className='text-[28px] leading-tight font-bold'>本地模型</h1>
      {machine.data && <State machine={machine.data} />}
      {list}
    </main>
  );
}

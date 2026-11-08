// One shared player: a single audio element means takes never overlap. Switching always starts the
// take from its beginning: two readings of a line differ in pace and pauses, so a carried-over
// position lands somewhere else in the text and defeats comparing how the same line is read.
import { Pause, Play } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';

/** One playable file. A button that plays it carries `data-track={id}`, so arrow keys can focus it. */
export interface Track {
  id: string;
  src: string;
  title: string;
}

interface Player {
  audio: HTMLAudioElement;
  current: Track | null;
  playing: boolean;
  failed: boolean;
  choose: (track: Track, row: Track[]) => void;
  toggle: () => void;
}

const PlayerContext = createContext<Player | null>(null);

export function usePlayer(): Player {
  const player = useContext(PlayerContext);
  if (!player) throw new Error('usePlayer needs a PlayerProvider');
  return player;
}

/** Text fields keep their own keys; the player only listens when focus is elsewhere. */
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useMemo(() => new Audio(), []);
  const [current, setCurrent] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const row = useRef<Track[]>([]);
  const now = useRef<Track | null>(null);

  const toggle = useCallback(() => {
    if (!now.current) return;
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  }, [audio]);

  /** Choosing the take that is already loaded pauses or resumes it instead of restarting. */
  const choose = useCallback(
    (track: Track, siblings: Track[]) => {
      row.current = siblings;
      if (now.current?.id === track.id) return toggle();
      now.current = track;
      setCurrent(track);
      setFailed(false);
      audio.src = track.src;
      audio.currentTime = 0;
      void audio.play().catch(() => {});
    },
    [audio, toggle],
  );

  useEffect(() => {
    const on = () => setPlaying(true);
    const off = () => setPlaying(false);
    const fail = () => setFailed(true);
    audio.addEventListener('play', on);
    audio.addEventListener('pause', off);
    audio.addEventListener('error', fail);
    return () => {
      audio.removeEventListener('play', on);
      audio.removeEventListener('pause', off);
      audio.removeEventListener('error', fail);
      audio.pause();
    };
  }, [audio]);

  useEffect(() => {
    const step = (by: number) => {
      const list = row.current;
      const at = list.findIndex((track) => track.id === now.current?.id);
      const next = at < 0 ? undefined : list[(at + by + list.length) % list.length];
      if (!next) return;
      choose(next, list);
      // Keyboard focus follows the playing take, so the focus ring never marks a different one.
      document.querySelector<HTMLElement>(`[data-track="${CSS.escape(next.id)}"]`)?.focus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (typing(event.target) || !now.current) return;
      if (event.key === ' ') {
        event.preventDefault();
        toggle();
      } else if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowRight') step(1);
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [choose, toggle]);

  const value = useMemo(
    () => ({ audio, current, playing, failed, choose, toggle }),
    [audio, current, playing, failed, choose, toggle],
  );
  return <PlayerContext value={value}>{children}</PlayerContext>;
}

function stamp(seconds: number): string {
  const whole = Math.floor(Number.isFinite(seconds) ? seconds : 0);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Appears once a take is chosen; position updates re-render only this bar, not the takes. */
export function PlayerBar() {
  const { audio, current, playing, failed, toggle } = usePlayer();
  const [time, setTime] = useState({ at: 0, length: 0 });

  useEffect(() => {
    const update = () => setTime({ at: audio.currentTime, length: audio.duration || 0 });
    audio.addEventListener('timeupdate', update);
    audio.addEventListener('durationchange', update);
    return () => {
      audio.removeEventListener('timeupdate', update);
      audio.removeEventListener('durationchange', update);
    };
  }, [audio]);

  if (!current) return null;
  const share = time.length ? (time.at / time.length) * 1000 : 0;
  const title = failed ? `无法播放：${current.title}` : current.title;
  return (
    <div className='fixed inset-x-0 bottom-0 z-10 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-line bg-panel px-6 py-3 sm:grid-cols-[auto_minmax(8em,16em)_minmax(0,1fr)_auto]'>
      <Button variant='solid' size='icon' aria-label={playing ? '暂停' : '播放'} onClick={toggle}>
        {playing ? <Pause className='size-5' /> : <Play className='size-5' />}
      </Button>
      <div className='truncate text-sm' role='status'>
        {title}
      </div>
      <input
        className='col-span-3 w-full accent-accent sm:col-span-1'
        type='range'
        min={0}
        max={1000}
        value={share}
        aria-label='播放进度'
        onChange={(event) => {
          audio.currentTime = (Number(event.target.value) / 1000) * (audio.duration || 0);
        }}
      />
      <div className='text-sm tabular-nums text-mute'>
        {stamp(time.at)} / {stamp(time.length)}
      </div>
    </div>
  );
}

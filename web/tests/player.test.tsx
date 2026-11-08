// The shared player in a simulated DOM: one audio element, restart on switch, keys within a row.

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';

const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { PlayerProvider, PlayerBar, usePlayer } = await import('@/components/player');
type Track = import('@/components/player').Track;

/** The last audio element the player created; play and pause only flip state and fire events. */
let audio: HTMLMediaElement;

beforeAll(() => {
  const media = window.HTMLMediaElement.prototype;
  let paused = true;
  Object.defineProperty(media, 'paused', { get: () => paused, configurable: true });
  media.play = function (this: HTMLMediaElement) {
    audio = this;
    paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  };
  media.pause = function (this: HTMLMediaElement) {
    paused = true;
    this.dispatchEvent(new Event('pause'));
  };
});

afterEach(cleanup);

const row: Track[] = ['a', 'b', 'c'].map((id) => ({
  id,
  src: `${id}.ogg`,
  title: `第一句 · ${id}`,
}));

function Takes() {
  const { current, choose } = usePlayer();
  return (
    <>
      {row.map((track) => (
        <button
          key={track.id}
          type='button'
          aria-pressed={current?.id === track.id}
          onClick={() => choose(track, row)}
        >
          {track.id}
        </button>
      ))}
      <input aria-label='备注' />
    </>
  );
}

function setup() {
  render(
    <PlayerProvider>
      <Takes />
      <PlayerBar />
    </PlayerProvider>,
  );
  const take = (name: string) => screen.getByRole('button', { name });
  return { take, status: () => screen.getByRole('status').textContent };
}

describe('player', () => {
  test('plays the chosen take and names it', () => {
    const { take, status } = setup();
    fireEvent.click(take('b'));
    expect(audio.src).toBe('http://127.0.0.1/voices/b.ogg');
    expect(audio.paused).toBe(false);
    expect(take('b').getAttribute('aria-pressed')).toBe('true');
    expect(status()).toBe('第一句 · b');
  });

  test('starts a newly chosen take from its beginning', () => {
    const { take } = setup();
    fireEvent.click(take('a'));
    audio.currentTime = 12;
    fireEvent.click(take('c'));
    expect(audio.src).toEndWith('/c.ogg');
    expect(audio.currentTime).toBe(0);
  });

  test('pauses and resumes the current take instead of restarting it', () => {
    const { take } = setup();
    fireEvent.click(take('a'));
    fireEvent.click(take('a'));
    expect(audio.paused).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    expect(audio.paused).toBe(false);
    expect(audio.src).toEndWith('/a.ogg');
  });

  test('arrow keys move within the row and wrap', () => {
    const { take } = setup();
    fireEvent.click(take('c'));
    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowRight' });
    });
    expect(audio.src).toEndWith('/a.ogg');
    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowLeft' });
    });
    expect(audio.src).toEndWith('/c.ogg');
  });

  test('leaves keys alone while typing', () => {
    const { take } = setup();
    fireEvent.click(take('a'));
    fireEvent.keyDown(screen.getByRole('textbox', { name: '备注' }), { key: ' ' });
    expect(audio.paused).toBe(false);
  });
});

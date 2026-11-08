// One shared player: a single audio element means takes never overlap. Switching always starts the
// take from its beginning: two readings of a line differ in pace and pauses, so a carried-over
// position lands somewhere else in the text and defeats comparing how the same line is read.
const audio = new Audio();
const takes = [...document.querySelectorAll('.take')];
const toggle = document.querySelector('.toggle');
const now = document.querySelector('.now');
const seek = document.querySelector('.player input');
const clock = document.querySelector('.clock');
let current = null;

const stamp = (seconds) => {
  const whole = Math.floor(seconds || 0);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

function choose(take) {
  if (take === current) {
    if (audio.paused) audio.play();
    else audio.pause();
    return;
  }
  current?.setAttribute('aria-pressed', 'false');
  take.setAttribute('aria-pressed', 'true');
  current = take;
  now.textContent = take.dataset.title;
  toggle.disabled = false;
  seek.disabled = false;
  audio.src = take.dataset.src;
  audio.play();
}

function neighbour(step) {
  if (!current) return;
  const row = [...current.closest('.row').querySelectorAll('.take')];
  const next = row[(row.indexOf(current) + step + row.length) % row.length];
  choose(next);
  next.focus();
}

for (const take of takes) take.addEventListener('click', () => choose(take));
toggle.addEventListener('click', () => current && choose(current));
seek.addEventListener('input', () => {
  audio.currentTime = (seek.value / 1000) * (audio.duration || 0);
});
audio.addEventListener('timeupdate', () => {
  seek.value = audio.duration ? (audio.currentTime / audio.duration) * 1000 : 0;
  clock.textContent = `${stamp(audio.currentTime)} / ${stamp(audio.duration)}`;
});
audio.addEventListener('play', () => {
  toggle.textContent = '暂停';
});
audio.addEventListener('pause', () => {
  toggle.textContent = '播放';
});
audio.addEventListener('error', () => {
  now.textContent = `无法播放：${current?.dataset.title ?? ''}`;
});
document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.key === ' ' && current) {
    event.preventDefault();
    choose(current);
  } else if (event.key === 'ArrowLeft') {
    neighbour(-1);
  } else if (event.key === 'ArrowRight') {
    neighbour(1);
  }
});

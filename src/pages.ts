// Render the home page and audition pages; pages are data, so every audition shares one player.

/** One playable version. `meta` is a short fact such as its length. */
export interface Take {
  src: string;
  label: string;
  meta?: string;
}

/** One subject and whatever versions of it exist, so a missing version needs no placeholder. */
export interface Row {
  label: string;
  note?: string;
  takes: Take[];
}

export interface Section {
  title: string;
  note?: string;
  rows: Row[];
}

/** The content of a directory's `audition.json`. */
export interface Audition {
  title: string;
  description?: string;
  sections: Section[];
}

/** What the home page shows for one published page. */
export interface Entry {
  href: string;
  title: string;
  description?: string;
  takes?: number;
  modified: Date;
}

/** Live machine state, read when the home page is requested. */
export interface Machine {
  usedMib: number;
  totalMib: number;
  speech: boolean;
  images: boolean;
}

const text = Bun.escapeHTML;

/** Hand-written data fails here with a message naming the field, not later as a blank page. */
export function parseAudition(raw: string): Audition {
  const value = JSON.parse(raw) as Audition;
  if (typeof value.title !== 'string') throw new Error('audition.json needs a title');
  if (!Array.isArray(value.sections)) throw new Error('audition.json needs sections');
  for (const section of value.sections)
    for (const row of section.rows)
      if (!row.takes.length) throw new Error(`${section.title}: row ${row.label} has no takes`);
  return value;
}

/** Count the versions an audition offers. */
export function takeCount(audition: Audition): number {
  const rows = audition.sections.flatMap((section) => section.rows);
  return rows.flatMap((row) => row.takes).length;
}

function shell(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${text(title)}</title>
<link rel="stylesheet" href="/assets/page.css"></head><body>${body}${script}</body></html>`;
}

function gib(mib: number): string {
  return (mib / 1024).toFixed(1);
}

function badge(name: string, busy: boolean): string {
  return `<div><div class="label">${name}</div>
<div class="value badge${busy ? ' on' : ''}">${busy ? '运行中' : '空闲'}</div></div>`;
}

function stateStrip(machine: Machine): string {
  const share = Math.round((machine.usedMib / machine.totalMib) * 100);
  return `<div class="state"><div><div class="label">显存</div>
<div class="value">${gib(machine.usedMib)} / ${gib(machine.totalMib)} GiB</div>
<div class="meter"><span style="width:${share}%"></span></div></div>
${badge('语音', machine.speech)}${badge('生图', machine.images)}</div>`;
}

function entryRow(entry: Entry): string {
  const count = entry.takes ? `${entry.takes} 段 · ` : '';
  const about = entry.description ? `<span class="about">${text(entry.description)}</span>` : '';
  return `<li><a href="${text(entry.href)}"><span class="name">${text(entry.title)}</span>${about}
<span class="facts">${count}${entry.modified.toISOString().slice(5, 10)}</span></a></li>`;
}

/** The newest work comes first, under the state that says whether the GPU is free. */
export function homePage(entries: Entry[], machine: Machine | null): string {
  const list = entries.length
    ? `<ul class="pages">${entries.map(entryRow).join('')}</ul>`
    : '<p class="empty">还没有页面。把试听放进页面目录后会出现在这里。</p>';
  const state = machine ? stateStrip(machine) : '';
  return shell('本地模型', `<main><h1>本地模型</h1>${state}${list}</main>`);
}

function button(take: Take, title: string): string {
  const meta = take.meta ? `<span class="time">${text(take.meta)}</span>` : '';
  return `<button class="take" type="button" aria-pressed="false" data-src="${text(take.src)}"
data-title="${text(title)}"><span>${text(take.label)}</span>${meta}</button>`;
}

function rowBlock(section: Section, row: Row): string {
  const note = row.note ? `<span class="detail">${text(row.note)}</span>` : '';
  const takes = row.takes.map((take) =>
    button(take, `${section.title} · ${row.label} · ${take.label}`),
  );
  return `<div class="row"><div class="subject"><span class="who">${text(row.label)}</span>${note}</div>
<div class="takes">${takes.join('')}</div></div>`;
}

function sectionBlock(section: Section): string {
  const note = section.note ? `<p class="note">${text(section.note)}</p>` : '';
  const rows = section.rows.map((row) => rowBlock(section, row)).join('');
  return `<section><h2>${text(section.title)}</h2>${note}<div class="rows">${rows}</div></section>`;
}

/** Audio paths in the data stay relative, so a page keeps working when its directory moves. */
export function auditionPage(audition: Audition): string {
  const lead = audition.description ? `<p class="lead">${text(audition.description)}</p>` : '';
  const player = `<div class="player"><button class="toggle" type="button" disabled>播放</button>
<div class="now">未选择</div>
<input type="range" min="0" max="1000" value="0" disabled aria-label="播放进度">
<div class="clock">0:00 / 0:00</div></div>`;
  const body = `<main><a class="back" href="/">← 全部试听</a><h1>${text(audition.title)}</h1>${lead}
${audition.sections.map(sectionBlock).join('')}</main>${player}`;
  return shell(audition.title, body, '<script type="module" src="/assets/player.js"></script>');
}

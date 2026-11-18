// The shape of a published audition and of the web API; shared by the server and the browser app.

/** One playable version. `meta` is a short fact such as its length. `dropped` records that the
 * listener ruled it out; it stays playable, since a rejected take is still a reference point. */
export interface Take {
  src: string;
  label: string;
  meta?: string;
  dropped?: boolean;
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

/** One sung or spoken line; the translation is for a listener who does not read the original. */
export interface Line {
  text: string;
  translation?: string;
}

/** A labelled block of lines, such as a verse; the label is optional so plain text works too. */
export interface Stanza {
  label?: string;
  lines: Line[];
}

/** The content of a directory's `audition.json`. `lyrics` is the text every take performs. */
export interface Audition {
  title: string;
  description?: string;
  sections: Section[];
  lyrics?: Stanza[];
}

/** What the home page shows for one published page; `modified` is an ISO timestamp. */
export interface Entry {
  href: string;
  title: string;
  description?: string;
  takes?: number;
  modified: string;
}

/** The listener's verdict on one row: one take by its label, a tie, or none good enough. Either
 * part may stand alone, since a note such as "the tag had no effect" needs no choice. */
export interface Pick {
  take?: string;
  verdict?: 'tie' | 'none';
  note?: string;
}

/** Section title, then row label, then the pick; titles and labels are unique so they serve as keys.
 * Stored beside `audition.json` as `picks.json`, apart from the data the page was published with. */
export type Picks = Record<string, Record<string, Pick>>;

/** One row's new pick as the browser sends it; an empty pick clears the row. */
export interface PickUpdate {
  section: string;
  row: string;
  pick: Pick;
}

/** Live machine state, read when it is requested. */
export interface Machine {
  usedMib: number;
  totalMib: number;
  speech: boolean;
  images: boolean;
}

/** Hand-written data fails here with a message naming the field, not later as a blank page. */
export function parseAudition(raw: string): Audition {
  const value = JSON.parse(raw) as Audition;
  if (typeof value.title !== 'string') throw new Error('audition.json needs a title');
  if (!Array.isArray(value.sections)) throw new Error('audition.json needs sections');
  unique(
    value.sections.map((section) => section.title),
    'section title',
  );
  for (const section of value.sections) {
    unique(
      section.rows.map((row) => row.label),
      `${section.title}: row label`,
    );
    for (const row of section.rows)
      if (!row.takes.length) throw new Error(`${section.title}: row ${row.label} has no takes`);
  }
  if (value.lyrics !== undefined && !Array.isArray(value.lyrics))
    throw new Error('audition.json lyrics must be a list of stanzas');
  for (const stanza of value.lyrics ?? [])
    if (!Array.isArray(stanza.lines)) throw new Error(`lyrics ${stanza.label ?? ''} needs lines`);
  return value;
}

/** Picks are keyed by title and label, so a repeat would make two rows share one verdict. */
function unique(names: string[], what: string): void {
  const repeated = names.find((name, at) => names.indexOf(name) !== at);
  if (repeated !== undefined) throw new Error(`audition.json repeats the ${what} ${repeated}`);
}

const noteLimit = 2000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A take must exist in its row, so a stale tab cannot record a version that is gone. */
function checkPick(value: Record<string, unknown>, row: Row): Pick {
  const { take, verdict, note } = value;
  if (take !== undefined && !row.takes.some((item) => item.label === take))
    throw new Error(`${row.label}: no take ${String(take)}`);
  if (verdict !== undefined && verdict !== 'tie' && verdict !== 'none')
    throw new Error('verdict must be tie or none');
  if (take !== undefined && verdict !== undefined) throw new Error('pick a take or a verdict');
  if (note !== undefined && (typeof note !== 'string' || note.length > noteLimit))
    throw new Error(`note must be text up to ${noteLimit} characters`);
  return {
    ...(typeof take === 'string' ? { take } : {}),
    ...(verdict === 'tie' || verdict === 'none' ? { verdict } : {}),
    ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}),
  };
}

/** Check an update against the page it targets; the body comes off the network. */
export function parsePickUpdate(raw: string, audition: Audition): PickUpdate {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !record(value.pick)) throw new Error('send {section, row, pick}');
  const section = audition.sections.find((item) => item.title === value.section);
  if (!section) throw new Error(`no section ${String(value.section)}`);
  const row = section.rows.find((item) => item.label === value.row);
  if (!row) throw new Error(`${section.title}: no row ${String(value.row)}`);
  return { section: section.title, row: row.label, pick: checkPick(value.pick, row) };
}

/** Fold one update into the stored picks; an empty pick removes its row and then its section. */
export function applyPick(picks: Picks, { section, row, pick }: PickUpdate): Picks {
  const rows = { ...picks[section] };
  if (Object.keys(pick).length) rows[row] = pick;
  else delete rows[row];
  const next = { ...picks, [section]: rows };
  if (!Object.keys(rows).length) delete next[section];
  return next;
}

/** Count the versions an audition offers. */
export function takeCount(audition: Audition): number {
  const rows = audition.sections.flatMap((section) => section.rows);
  return rows.flatMap((row) => row.takes).length;
}

// The shape of a published audition and of the web API; shared by the server and the browser app.

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
  for (const section of value.sections)
    for (const row of section.rows)
      if (!row.takes.length) throw new Error(`${section.title}: row ${row.label} has no takes`);
  if (value.lyrics !== undefined && !Array.isArray(value.lyrics))
    throw new Error('audition.json lyrics must be a list of stanzas');
  for (const stanza of value.lyrics ?? [])
    if (!Array.isArray(stanza.lines)) throw new Error(`lyrics ${stanza.label ?? ''} needs lines`);
  return value;
}

/** Count the versions an audition offers. */
export function takeCount(audition: Audition): number {
  const rows = audition.sections.flatMap((section) => section.rows);
  return rows.flatMap((row) => row.takes).length;
}

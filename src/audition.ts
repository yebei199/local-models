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

/** The content of a directory's `audition.json`. */
export interface Audition {
  title: string;
  description?: string;
  sections: Section[];
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
  return value;
}

/** Count the versions an audition offers. */
export function takeCount(audition: Audition): number {
  const rows = audition.sections.flatMap((section) => section.rows);
  return rows.flatMap((row) => row.takes).length;
}

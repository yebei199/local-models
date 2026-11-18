// The listener's verdict on one row: which take is better, a tie, or none, plus a free note.
import { Button } from '@/components/ui/button';
import type { Pick, Row } from '../../../src/audition';

const verdicts = [
  { verdict: 'tie', label: '差不多' },
  { verdict: 'none', label: '都不行' },
] as const;

/** Choosing the current answer again clears it, so a misclick needs no separate undo control.
 * A choice only makes sense between versions; a single take still takes a note. */
export function Verdict({
  row,
  pick,
  save,
}: {
  row: Row;
  pick: Pick | undefined;
  save: (pick: Pick) => void;
}) {
  const note = pick?.note;
  const keep = note ? { note } : {};
  const choose = (choice: Pick, chosen: boolean) => save(chosen ? keep : { ...choice, ...keep });
  return (
    <div className='flex flex-wrap items-center gap-2'>
      {row.takes.length > 1 && (
        <fieldset
          className='flex flex-wrap items-center gap-1.5'
          aria-label={`${row.label} 的选择`}
        >
          <legend className='float-left mr-1 text-sm text-mute'>选</legend>
          {row.takes.map(({ label }) => (
            <Button
              key={label}
              size='sm'
              variant='ghost'
              aria-label={`选 ${label}`}
              aria-pressed={pick?.take === label}
              className='aria-pressed:bg-accent aria-pressed:text-on-accent'
              onClick={() => choose({ take: label }, pick?.take === label)}
            >
              {label}
            </Button>
          ))}
          {verdicts.map(({ verdict, label }) => (
            <Button
              key={verdict}
              size='sm'
              variant='ghost'
              aria-pressed={pick?.verdict === verdict}
              className='aria-pressed:bg-accent aria-pressed:text-on-accent'
              onClick={() => choose({ verdict }, pick?.verdict === verdict)}
            >
              {label}
            </Button>
          ))}
        </fieldset>
      )}
      <input
        // Remount when the stored note changes, so the field shows what was saved.
        key={note ?? ''}
        className='h-8 min-w-[12em] flex-1 rounded-lg border border-line bg-panel px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/60'
        defaultValue={note ?? ''}
        placeholder='备注（回车保存）'
        aria-label={`${row.label} 的备注`}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        onBlur={(event) => {
          const text = event.currentTarget.value.trim();
          if (text === (note ?? '')) return;
          const { note: _, ...choice } = pick ?? {};
          save(text ? { ...choice, note: text } : choice);
        }}
      />
    </div>
  );
}

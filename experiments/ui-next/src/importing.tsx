import { DownloadSimple } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { FileField, SelectField } from './fields';
import { type DropItem, DropMenu, Modal } from './overlays';
import { words } from './words';

/* Rows in and rows out: a sheet a reader brings is read, matched to what the list keeps, checked and taken in,
   and a list is given back as a sheet. Both speak CSV, since it is what every spreadsheet reads and writes. */

/* A sheet as rows of cells: quoted cells may hold commas, quotes (doubled) and line ends. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at];
    if (quoted) {
      if (char === '"' && source[at + 1] === '"') {
        cell += '"';
        at += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[at + 1] === '\n') at += 1;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // A line with nothing on it is the end of a file, not a row.
  return rows.filter((each) => each.some((value) => value.trim() !== ''));
}

/* Rows as a sheet. A cell that starts as a formula would is led with an apostrophe, so a name a stranger typed
   is not run by the spreadsheet that opens the file. */
export function toCsv(head: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (value: string | number | null | undefined): string => {
    const text = value === null || value === undefined ? '' : String(value);
    const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [head, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
}

/* Hands the reader a file to keep. */
export function download(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const address = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = address;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(address), 1000);
}

export type ImportField = {
  id: string;
  label: string;
  required?: boolean;
  /* What is wrong with a cell for this field, if anything. */
  check?: (value: string) => string | undefined;
};

export type ImportRow = Record<string, string>;
/* How many were taken, and which of the rows handed over were not (by their place among them, from 0) and why. */
export type ImportReport = { taken: number; refused?: { index: number; why: string }[] };

type Step = 'file' | 'match' | 'check' | 'done';
const words_ = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

/* Bringing a sheet into a list, in the three things a reader has to decide and no more: which file, which of
   its columns is which field (matched by name where the names agree, so most sheets need no matching at all),
   and whether to go on once they have seen what would be taken and what would not. A row with a problem is
   never dropped in silence: it is counted, shown with its reason, left out of what is taken, and handed back
   as a sheet of its own to be put right and brought again. */
export function ImportDialog({
  open,
  onOpenChange,
  title,
  fields,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /* What is being brought in: `Import homes`. */
  title: string;
  fields: ImportField[];
  /* Asked to take the rows that passed. It may refuse some of them itself, and says which. */
  onImport: (rows: ImportRow[]) => ImportReport | Promise<ImportReport>;
}) {
  const [step, setStep] = useState<Step>('file');
  const [name, setName] = useState('');
  const [sheet, setSheet] = useState<string[][]>([]);
  const [match, setMatch] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (open) return;
    setStep('file');
    setSheet([]);
    setMatch({});
    setProblem(null);
    setReport(null);
  }, [open]);
  // Each step arrives with the keyboard on its name, so it is read out.
  useEffect(() => {
    if (open && step !== 'file') heading.current?.focus();
  }, [open, step]);

  const head = sheet[0] ?? [];
  const body = sheet.slice(1);
  const read = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    const rows = parseCsv(await file.text());
    if (rows.length < 2) {
      setProblem(words.importEmpty);
      return;
    }
    setProblem(null);
    setName(file.name);
    setSheet(rows);
    const columns = rows[0] ?? [];
    // A column is taken for a field when their names agree, whatever their case and spacing.
    setMatch(
      Object.fromEntries(
        fields.flatMap((field) => {
          const found = columns.findIndex((column) => words_(column) === words_(field.label) || words_(column) === words_(field.id));
          return found < 0 ? [] : [[field.id, String(found)]];
        }),
      ),
    );
    setStep('match');
  };

  const unmatched = fields.filter((field) => field.required && match[field.id] === undefined);
  const checked = useMemo(
    () =>
      body.map((cells, at) => {
        const row: ImportRow = {};
        const wrong: string[] = [];
        for (const field of fields) {
          const column = match[field.id];
          const value = column === undefined ? '' : (cells[Number(column)] ?? '').trim();
          row[field.id] = value;
          if (field.required && value === '') wrong.push(words.importMissing(field.label));
          else if (value !== '') {
            const why = field.check?.(value);
            if (why) wrong.push(`${field.label}: ${why}`);
          }
        }
        return { line: at + 2, row, wrong };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet, match],
  );
  const good = checked.filter((each) => each.wrong.length === 0);
  const bad = checked.filter((each) => each.wrong.length > 0);

  const take = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setReport(await onImport(good.map((each) => each.row)));
      setStep('done');
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : words.importFailed);
    } finally {
      setBusy(false);
    }
  };
  const handBack = () =>
    download(
      `${name.replace(/\.csv$/i, '')}-to-fix.csv`,
      toCsv(
        [...head, words.importWhy],
        bad.map((each) => [...(body[each.line - 2] ?? []), each.wrong.join('; ')]),
      ),
    );

  const foot =
    step === 'match' ? (
      <>
        <Button onClick={() => setStep('file')}>{words.back}</Button>
        <Button intent="primary" disabled={unmatched.length > 0} onClick={() => setStep('check')}>
          {words.importCheck}
        </Button>
      </>
    ) : step === 'check' ? (
      <>
        <Button onClick={() => setStep('match')}>{words.back}</Button>
        <Button intent="primary" busy={busy} disabled={good.length === 0} onClick={() => void take()}>
          {words.importTake(good.length)}
        </Button>
      </>
    ) : step === 'done' ? (
      <Button intent="primary" onClick={() => onOpenChange(false)}>
        {words.done}
      </Button>
    ) : undefined;

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} size="lg" footer={foot} unsaved={step === 'match' || step === 'check'}>
      <div data-slot="import">
        {step === 'file' && (
          <>
            <FileField
              label={words.importFile}
              accept=".csv,text/csv"
              prompt={words.importPrompt}
              hint={words.importNeeds(fields.filter((field) => field.required).map((field) => field.label))}
              error={problem ?? undefined}
              value={[]}
              onValueChange={(files) => void read(files)}
            />
            <Button
              intent="quiet"
              size="sm"
              onClick={() =>
                download(
                  'template.csv',
                  toCsv(
                    fields.map((field) => field.label),
                    [],
                  ),
                )
              }
            >
              <DownloadSimple aria-hidden="true" />
              {words.importTemplate}
            </Button>
          </>
        )}
        {step === 'match' && (
          <>
            <h3 ref={heading} tabIndex={-1}>
              {words.importMatch(name, body.length)}
            </h3>
            <div data-slot="import-match">
              {fields.map((field) => (
                <SelectField
                  key={field.id}
                  label={field.label}
                  required={field.required}
                  placeholder={words.importNoColumn}
                  options={head.map((column, at) => ({
                    value: String(at),
                    label: column || words.importColumn(at + 1),
                    hint: body[0]?.[at],
                  }))}
                  value={match[field.id] ?? null}
                  onValueChange={(value) => {
                    const next = { ...match };
                    if (typeof value === 'string') next[field.id] = value;
                    else delete next[field.id];
                    setMatch(next);
                  }}
                  error={field.required && match[field.id] === undefined ? words.importPick : undefined}
                />
              ))}
            </div>
          </>
        )}
        {step === 'check' && (
          <>
            <h3 ref={heading} tabIndex={-1}>
              {bad.length === 0 ? words.importAllGood(good.length) : words.importSome(good.length, bad.length)}
            </h3>
            {bad.length > 0 && (
              <>
                <ul data-slot="import-problems">
                  {bad.slice(0, 6).map((each) => (
                    <li key={each.line}>
                      <b>{words.importLine(each.line)}</b> {each.wrong.join('; ')}
                    </li>
                  ))}
                  {bad.length > 6 && <li data-slot="import-more">{words.importMore(bad.length - 6)}</li>}
                </ul>
                <Button intent="quiet" size="sm" onClick={handBack}>
                  <DownloadSimple aria-hidden="true" />
                  {words.importHandBack(bad.length)}
                </Button>
              </>
            )}
            <div data-slot="import-preview">
              <table>
                <thead>
                  <tr>
                    {fields.map((field) => (
                      <th key={field.id} scope="col">
                        {field.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {good.slice(0, 5).map((each) => (
                    <tr key={each.line}>
                      {fields.map((field) => (
                        <td key={field.id}>{each.row[field.id]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {problem && (
              <p data-slot="import-failed" role="alert">
                {problem}
              </p>
            )}
          </>
        )}
        {step === 'done' && report && (
          <>
            <h3 ref={heading} tabIndex={-1}>
              {words.importTaken(report.taken)}
            </h3>
            {(report.refused?.length ?? 0) + bad.length > 0 && (
              <ul data-slot="import-problems">
                {bad.length > 0 && <li>{words.importLeftOut(bad.length)}</li>}
                {report.refused?.map((each) => (
                  // Said by the line it has in the reader's own file, not by its place among the rows that passed.
                  <li key={each.index}>
                    <b>{words.importLine(good[each.index]?.line ?? each.index + 2)}</b> {each.why}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/* A list given back as a file: what is shown, or everything, behind one button. */
export function ExportMenu({ items, onAction }: { items: DropItem[]; onAction: (value: string) => void }) {
  return (
    <DropMenu
      trigger={
        <>
          <DownloadSimple aria-hidden="true" />
          {words.exportWord}
        </>
      }
      items={items}
      onAction={onAction}
    />
  );
}

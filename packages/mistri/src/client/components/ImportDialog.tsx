/**
 * Importing a CSV file into a list, in four steps: the file, which field
 * each of its columns fills, a check of every row, and what happened.
 *
 * The browser reads the file only to offer a mapping and show its rows;
 * every judgment is the server's (POST /api/import, server/app/appImport.ts):
 * the check writes nothing and says what is wrong with each row, by field;
 * the import writes the rows the check passed — every one of them in one
 * transaction, or, for a command import, one command per run (a row, or a
 * `group`'s consecutive rows). A command import's check runs each command in
 * a transaction that is always rolled back, so it says what each run would
 * do — create, update or be refused — and how many rows it would write.
 * A refused row is never written; the rows with problems download as a CSV
 * to fix and import again, each cell written so no spreadsheet reads it as
 * a formula.
 */
import { useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, columnLabel, state } from '@mistriwork/kit/client/core.js';
import { activeApp } from '../appState.js';
import { download } from '@mistriwork/kit/client/export.js';
import { plural } from '@mistriwork/kit/client/locale.js';
import { csvField, CRLF } from '@mistriwork/engine/shared/csv.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { CsvError, parseCsv } from '../../shared/csvParse.js';
import { importErrorCsv, importFields, mappingProblem, suggestMapping, type ImportReport, type ImportRun } from '../../shared/appImport.js';
import { IMPORT_LIMITS, type AppImportDef } from '../../shared/appImportDeclaration.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
import './ImportDialog.css';
import { say } from '../copy/lists/components/ImportDialog.js';

type Step = 'file' | 'columns' | 'check' | 'done';
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'file', label: say('file') },
  { id: 'columns', label: say('common.columns') },
  { id: 'check', label: say('check') },
  { id: 'done', label: say('common.done') },
];
/** Rows drawn in the check's table; the rest are counted, and the problems all download. */
const SHOWN = 100;

interface ReadFile {
  name: string;
  text: string;
  header: string[];
  rows: string[][];
  lines: number[];
}

const stem = (name: string) => name.replace(/[^\w.-]+/g, '_');

export function ImportDialog({
  table,
  view,
  def,
  noun,
  onClose,
}: {
  table: TableMeta;
  view?: string;
  def: AppImportDef;
  noun: { one: string; many: string };
  onClose: () => void;
}) {
  const client = useQueryClient();
  const connection = (state as { activeConnection?: string }).activeConnection;
  /* A reference is also said by the captions of its own paths: a sheet's
     "SKU" column names `product_id` where the App captions `product_id.sku`. */
  const labels = (activeApp()?.resources?.[table.id]?.labels ?? {}) as Record<string, string>;
  const fields = importFields(
    table,
    def,
    (column) => columnLabel(table.id, column) ?? undefined,
    undefined,
    undefined,
    new Set(activeApp()?.resources?.[table.id]?.fixed ?? []),
  ).map((field) => ({
    ...field,
    // A repeated group's field keeps its own: "SKU" names `lines.sku`.
    aliases: [
      ...(field.aliases ?? []),
      ...Object.entries(labels)
        .filter(([path]) => path.startsWith(`${field.name}.`) && !path.slice(field.name.length + 1).includes('.'))
        .map(([, said]) => said),
    ],
  }));
  const [step, setStep] = useState<Step>('file');
  const [file, setFile] = useState<ReadFile>();
  const [mapping, setMapping] = useState<Array<string | null>>([]);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<ImportReport>();
  const [result, setResult] = useState<ImportReport>();
  const [dragging, setDragging] = useState(false);
  const title = say('import', { many: noun.many });

  const choose = async (chosen: File | undefined) => {
    setProblem('');
    if (!chosen) return;
    // Measured before it is read: a file past the limit is never held.
    if (chosen.size > IMPORT_LIMITS.bytes) {
      setProblem(say('isLargerThanMb', { name: chosen.name, bytes: IMPORT_LIMITS.bytes / 1024 / 1024 }));
      return;
    }
    try {
      const text = await chosen.text();
      const parsed = parseCsv(text, { maxRows: IMPORT_LIMITS.rows, maxColumns: IMPORT_LIMITS.columns, maxField: IMPORT_LIMITS.field });
      if (!parsed.rows.length) {
        setProblem(say('hasAHeaderAndNoRows', { name: chosen.name }));
        return;
      }
      setFile({ name: chosen.name, text, header: parsed.header, rows: parsed.rows, lines: parsed.lines });
      setMapping(suggestMapping(parsed.header, fields));
      setStep('columns');
    } catch (error) {
      setProblem(
        error instanceof CsvError
          ? say('lineProblem', { line: error.line, message: error.message })
          : say('couldNotBeRead', { name: chosen.name }),
      );
    }
  };

  const send = async (mode: 'check' | 'commit') =>
    (await api('/api/import', {
      table: table.id,
      ...(view ? { view } : {}),
      name: file!.name,
      csv: file!.text,
      mapping,
      mode,
      ...(mode === 'commit' ? { skipRefused: true } : {}),
    })) as ImportReport;

  const check = async () => {
    const issue = mappingProblem(mapping, fields, file!.header.length);
    if (issue) {
      setProblem(issue);
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      const report = await send('check');
      if (report.error) {
        setProblem(report.error);
        return;
      }
      setChecked(report);
      setStep('check');
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setProblem('');
    try {
      const report = await send('commit');
      setResult(report);
      setStep('done');
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
      // Whatever happened, the list below is read again: rows may have landed.
      void client.invalidateQueries({ queryKey: ['run', connection ?? ''] });
      void client.invalidateQueries({ queryKey: ['count', connection ?? ''] });
    }
  };

  const problems = (report: ImportReport | undefined) =>
    report?.refused.length ? (
      <Button
        intent="quiet"
        onClick={() =>
          download(`${stem(table.name)}-import-problems.csv`, importErrorCsv(file!.header, file!.rows, report.refused), 'text/csv')
        }
      >
        {say('downloadTheRowsWithProblems')}
      </Button>
    ) : null;

  const blankSheet = () =>
    download(`${stem(table.name)}-import.csv`, fields.map((field) => csvField(field.label)).join(',') + CRLF, 'text/csv');

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  };

  /* What a row does, said before the file is chosen: a command import names its inputs, and what finds or groups its rows. */
  const lede = () => {
    const command = def.command;
    if (!command) return say('eachRowBecomesANew', { one: noun.one });
    const said = (names: readonly string[]) =>
      names
        .map((column) => (columnLabel(table.id, column) ?? fields.find((field) => field.name === column)?.label ?? column).toLowerCase())
        .join(' and ');
    const inputs = command.input.map((input) => input.label.toLowerCase()).join(' and ');
    const repeated = command.input.find((input) => input.type === 'group' && input.repeat);
    return [
      def.match?.length && command.targets !== 'none'
        ? say('eachRowRecordsOnTheItsFind', { inputs, noun: noun.one, matches: said(def.match) })
        : say('eachRowRecordsOnANew', { inputs, noun: noun.one }),
      def.group?.length && repeated
        ? say('rowsThatAgreeOn', { columns: said(def.group), noun: noun.one, entries: repeated.label.toLowerCase() })
        : '',
    ].join('');
  };

  const current = STEPS.findIndex((item) => item.id === step);
  const mapped = mapping.map((name, index) => ({ name, index })).filter((item) => item.name !== null);

  return (
    <Modal className="confirm import-dialog" ariaLabel={title} onClose={onClose} closeDisabled={busy}>
      <h2>{title}</h2>
      <nav className="multi-step-nav import-steps" aria-label={say('importSteps')}>
        <ol>
          {STEPS.map((item, index) => (
            <li key={item.id}>
              <span
                className="multi-step-nav-item"
                aria-current={index === current ? 'step' : undefined}
                data-done={index < current || undefined}
              >
                <span className="multi-step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="multi-step-label">{item.label}</span>
              </span>
            </li>
          ))}
        </ol>
      </nav>

      {step === 'file' && (
        <div className="import-step">
          <p className="import-lede">
            {say('aCsvFileWhose', { count: IMPORT_LIMITS.rows })} {IMPORT_LIMITS.bytes / 1024 / 1024} {say('mb')}
            {lede()}
          </p>
          <label
            className={`import-drop${dragging ? ' is-over' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
          >
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="import-file"
              onChange={(event) => {
                void choose(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <span className="import-drop-words">
              <strong>{say('chooseACsvFile')}</strong> {say('orDropOneHere')}
            </span>
          </label>
          {problem && (
            <p className="import-problem" role="alert">
              {problem}
            </p>
          )}
          <div className="confirm-actions import-actions">
            <Button intent="quiet" onClick={blankSheet}>
              {say('downloadABlankSheet')}
            </Button>
            <Button intent="secondary" onClick={onClose}>
              {say('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {step === 'columns' && file && (
        <div className="import-step">
          <p className="import-lede">
            <strong>{file.name}</strong> {say('rowsChooseTheField', { count: file.rows.length })}
          </p>
          <ol className="import-map">
            {file.header.map((heading, index) => {
              const sample = file.rows.find((row) => (row[index] ?? '').trim())?.[index];
              return (
                <li key={index} className="import-map-row">
                  <Field
                    label={heading || say('column', { index: index + 1 })}
                    hint={
                      sample
                        ? say('forExample', { sample: sample.length > 40 ? `${sample.slice(0, 40)}…` : sample })
                        : say('emptyInEveryRow')
                    }
                    group
                  >
                    {(control) => (
                      <Dropdown
                        ariaLabel={say('field', { heading: heading || say('columnLower', { index: index + 1 }) })}
                        id={control.id}
                        ariaDescribedBy={control['aria-describedby']}
                        value={mapping[index] ?? ''}
                        items={[
                          { value: '', label: say('leaveOut') },
                          ...fields.map((field) => ({
                            value: field.name,
                            label: field.label,
                            ...(field.required ? { detail: say('common.required') } : field.match ? { detail: say('findsTheRecord') } : {}),
                            disabled: mapping.some((name, other) => other !== index && name === field.name),
                          })),
                        ]}
                        onChange={(next) => {
                          setMapping(mapping.map((name, other) => (other === index ? next || null : name)));
                          setProblem('');
                        }}
                      />
                    )}
                  </Field>
                </li>
              );
            })}
          </ol>
          {problem && (
            <p className="import-problem" role="alert">
              {problem}
            </p>
          )}
          <div className="confirm-actions import-actions">
            <Button
              intent="secondary"
              onClick={() => {
                setStep('file');
                setProblem('');
              }}
            >
              {say('common.back')}
            </Button>
            <Button intent="primary" busy={busy} busyLabel={say('common.checking')} onClick={() => void check()}>
              {say('checkRows', { count: file.rows.length })}
            </Button>
          </div>
        </div>
      )}

      {step === 'check' && file && checked && (
        <div className="import-step">
          <p className="import-lede" role="status">
            {checked.runs ? (
              runsSentence(checked.runs, noun)
            ) : checked.refused.length ? (
              <>
                {say('readyAProblemAndWill', {
                  ready: say('rowsAre', { count: checked.ready }),
                  refused: say('rowsHave', { count: checked.refused.length }),
                })}
              </>
            ) : (
              <>{say('allRowsAreReady', { count: checked.ready })}</>
            )}
          </p>
          <Preview
            file={file}
            report={checked}
            mapped={mapped}
            label={(name) => fields.find((field) => field.name === name)?.label ?? name}
          />
          {problem && (
            <p className="import-problem" role="alert">
              {problem}
            </p>
          )}
          <div className="confirm-actions import-actions">
            {problems(checked)}
            <Button
              intent="secondary"
              onClick={() => {
                setStep('columns');
                setProblem('');
              }}
            >
              {say('common.back')}
            </Button>
            {checked.ready > 0 && (
              <Button intent="primary" busy={busy} busyLabel={say('importing')} onClick={() => void commit()}>
                {checked.refused.length ? say('importTheReadyRows', { count: checked.ready }) : say('importRows', { count: checked.ready })}
              </Button>
            )}
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div className="import-step">
          <p className="import-lede" role="status">
            {doneSentence(result, noun)}
          </p>
          {result.refused.length > 0 && <p className="import-note">{say('rowsWereNotImported', { count: result.refused.length })}</p>}
          {problem && (
            <p className="import-problem" role="alert">
              {problem}
            </p>
          )}
          <div className="confirm-actions import-actions">
            {problems(result)}
            <Button intent="primary" onClick={onClose}>
              {say('common.done')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** A command import's check, run by run: what would be created, updated and refused, each run tried and rolled back. */
function runsSentence(runs: readonly ImportRun[], noun: { one: string; many: string }): string {
  const words = { one: noun.one, other: noun.many };
  const count = (outcome: ImportRun['outcome']) => runs.filter((run) => run.outcome === outcome).length;
  const parts = [
    count('create') ? say('wouldBeCreated', { records: plural(count('create'), words) }) : '',
    count('update') ? say('wouldBeUpdated', { records: plural(count('update'), words) }) : '',
    count('refused') ? say('wouldBeRefused', { records: plural(count('refused'), words) }) : '',
  ].filter(Boolean);
  return say('runsSummary', { parts: parts.join('; ') });
}

const outcomeWord = (outcome: ImportRun['outcome']) =>
  outcome === 'create' ? say('wouldCreate') : outcome === 'update' ? say('wouldUpdate') : say('refused');

function doneSentence(report: ImportReport, noun: { one: string; many: string }): string {
  const words = { one: noun.one, other: noun.many };
  // A command import counts records by run: a `group`'s rows make one.
  const records = plural(report.runs ? report.runs.filter((run) => run.outcome !== 'refused').length : (report.applied ?? 0), words);
  if (report.outcome === 'applied') return say('importedRecords', { records });
  if (report.outcome === 'partial') return say('importedSomeRefused', { records });
  if (report.outcome === 'unknown') return report.error ?? say('theImportCouldNotBeConfirmed');
  return report.error ?? say('nothingWasImported');
}

/**
 * The file's rows as they were read, those with a problem first, each with
 * what is wrong with it. A command import's check says it by run: the run's
 * rows stay together, and its first row says what the run would do and write.
 */
function Preview({
  file,
  report,
  mapped,
  label,
}: {
  file: ReadFile;
  report: ImportReport;
  mapped: Array<{ name: string | null; index: number }>;
  label: (name: string) => string;
}) {
  const refused = new Map(report.refused.map((problem) => [problem.row - 1, problem]));
  const runs = report.runs;
  const order = (
    runs
      ? [...runs.filter((run) => run.outcome === 'refused'), ...runs.filter((run) => run.outcome !== 'refused')].flatMap((run) =>
          run.rows.map((row) => row - 1),
        )
      : [...refused.keys(), ...file.rows.map((_, index) => index).filter((index) => !refused.has(index))]
  ).slice(0, SHOWN);
  const shown = new Set(order);
  const runOf = new Map(runs?.flatMap((run) => run.rows.map((row) => [row - 1, run] as const)));
  return (
    <div className="import-preview" role="region" aria-label={say('theFilesRows')} tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">{say('lineHeading')}</th>
            <th scope="col">{say('check')}</th>
            {runs && <th scope="col">{say('writesHeading')}</th>}
            {mapped.map(({ name, index }) => (
              <th key={index} scope="col">
                {label(name!)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map((index) => {
            const problem = refused.get(index);
            const run = runOf.get(index);
            // A run's first row shown says it for every row of the run; the others leave the cells to it.
            const span = run ? run.rows.filter((row) => shown.has(row - 1)).length : 1;
            const heads = !run || run.rows.find((row) => shown.has(row - 1)) === index + 1;
            return (
              <tr key={index} className={(run ? run.outcome === 'refused' : problem) ? 'is-refused' : undefined}>
                <td className="import-line">{file.lines[index]}</td>
                {run ? (
                  heads && (
                    <>
                      <td className="import-status" rowSpan={span}>
                        <span className="import-outcome" data-outcome={run.outcome}>
                          {outcomeWord(run.outcome)}
                        </span>
                        <Says problems={run.problems} />
                      </td>
                      <td className="import-writes" rowSpan={span}>
                        {Object.entries(run.writes).map(([table, count]) => (
                          <span key={table} className="import-says">
                            {say('writeCount', { table: humanName(table.split('.').pop()!), count })}
                          </span>
                        ))}
                      </td>
                    </>
                  )
                ) : (
                  <td className="import-status">{problem ? <Says problems={problem.problems} /> : say('ready')}</td>
                )}
                {mapped.map(({ index: column }) => (
                  <td key={column}>{file.rows[index][column] ?? ''}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {file.rows.length > SHOWN && <p className="import-note">{say('theFirstOfRows', { shown: SHOWN, count: file.rows.length })}</p>}
    </div>
  );
}

function Says({ problems }: { problems: ReadonlyArray<{ field?: string; message: string }> }) {
  return problems.map((said, n) => (
    <span key={n} className="import-says">
      {said.field ? <b>{said.field}: </b> : null}
      {said.message}
    </span>
  ));
}

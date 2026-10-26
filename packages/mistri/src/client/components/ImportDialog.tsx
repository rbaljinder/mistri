/**
 * Importing a CSV file into a list, in four steps: the file, which field
 * each of its columns fills, a check of every row, and what happened.
 *
 * The browser reads the file only to offer a mapping and show its rows;
 * every judgment is the server's (POST /api/import, server/app/appImport.ts):
 * the check writes nothing and says what is wrong with each row, by field;
 * the import writes the rows the check passed — every one of them in one
 * transaction, or, for a command import, one command per row.
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
import { CsvError, parseCsv } from '../../shared/csvParse.js';
import { importErrorCsv, importFields, mappingProblem, suggestMapping, type ImportReport } from '../../shared/appImport.js';
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
  const fields = importFields(table, def, (column) => columnLabel(table.id, column) ?? undefined).map((field) => ({
    ...field,
    aliases: Object.entries(labels)
      .filter(([path]) => path.startsWith(`${field.name}.`) && !path.slice(field.name.length + 1).includes('.'))
      .map(([, said]) => said),
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

  const current = STEPS.findIndex((item) => item.id === step);
  const mapped = mapping.map((name, index) => ({ name, index })).filter((item) => item.name !== null);

  return (
    <Modal className="confirm import-dialog" aria-label={title} onClose={onClose} closeDisabled={busy}>
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
            {def.command
              ? say('eachRowRecordsOnTheItsFind', {
                  inputs: def.command.input.map((input) => input.label.toLowerCase()).join(' and '),
                  noun: noun.one,
                  matches: def.match!.map((column) => (columnLabel(table.id, column) ?? column).toLowerCase()).join(' and '),
                })
              : say('eachRowBecomesANew', { one: noun.one })}
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
            {checked.refused.length ? (
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

function doneSentence(report: ImportReport, noun: { one: string; many: string }): string {
  const words = { one: noun.one, other: noun.many };
  if (report.outcome === 'applied') return say('importedRecords', { records: plural(report.applied ?? 0, words) });
  if (report.outcome === 'partial') return say('importedSomeRefused', { records: plural(report.applied ?? 0, words) });
  if (report.outcome === 'unknown') return report.error ?? say('theImportCouldNotBeConfirmed');
  return report.error ?? say('nothingWasImported');
}

/** The file's rows as they were read, those with a problem first, each with what is wrong with it. */
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
  const order = [...refused.keys(), ...file.rows.map((_, index) => index).filter((index) => !refused.has(index))].slice(0, SHOWN);
  return (
    <div className="import-preview" role="region" aria-label={say('theFilesRows')} tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">{say('lineHeading')}</th>
            <th scope="col">{say('check')}</th>
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
            return (
              <tr key={index} className={problem ? 'is-refused' : undefined}>
                <td className="import-line">{file.lines[index]}</td>
                <td className="import-status">
                  {problem
                    ? problem.problems.map((said, n) => (
                        <span key={n} className="import-says">
                          {said.field ? <b>{said.field}: </b> : null}
                          {said.message}
                        </span>
                      ))
                    : say('ready')}
                </td>
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

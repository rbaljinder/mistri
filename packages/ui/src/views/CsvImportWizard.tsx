/** Multi-step CSV upload, column-to-schema mapping, cell validation preview, and import summary wizard. */
'use client';

import { Icon } from '../Icon.js';
import { type ChangeEvent, type DragEvent, type Ref, useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { Button } from '../primitives/actions.js';
import { Badge, Code } from '../primitives/display.js';
import { Alert } from '../primitives/feedback.js';
import { TextArea } from '../TextArea.js';
import { Checkbox, Select, type SelectOption } from '../primitives/selection.js';
import { cx } from '../internal/cx.js';
import { coerceCsvNumber, headerSimilarity, parseCsvText } from './csvRules.js';

/** Supported schema column data type in `CsvImportWizard`. */
export type CsvFieldType = 'string' | 'number' | 'date' | 'email';

/** Target schema field definition for `CsvImportWizard`. */
export interface CsvSchemaField {
  key: string;
  label: string;
  required?: boolean;
  type?: CsvFieldType;
  description?: string;
}

/** Mapping from 0-based CSV column index to target schema field key. */
export type CsvColumnMapping = Record<number, string>;

/** Severity level of a cell validation issue in `CsvImportWizard`. */
export type CsvIssueSeverity = 'warning' | 'critical';

/** Cell-level validation diagnostic emitted during `CsvImportWizard` dry-run checks. */
export interface CsvCellIssue {
  fieldKey: string;
  fieldLabel: string;
  severity: CsvIssueSeverity;
  message: string;
}

/** Validated CSV row record with coerced field values and cell diagnostics. */
export interface CsvValidatedRow {
  rowNumber: number;
  rawCells: string[];
  record: Record<string, string | number | null>;
  displayValues: Record<string, string>;
  issues: Record<string, CsvCellIssue>;
  valid: boolean;
}

/** Committed import payload emitted by `CsvImportWizard`. */
export interface CsvImportResult {
  records: Array<Record<string, string | number | null>>;
  validCount: number;
  issueRowCount: number;
  skippedCount: number;
  mapping: Record<string, string>;
}

/** Props for the `CsvImportWizard` component. */
export interface CsvImportWizardProps {
  schemaFields?: ReadonlyArray<CsvSchemaField>;
  sampleCsv?: string;
  initialCsv?: string;
  onCommitImport?: (result: CsvImportResult) => void;
  commitLabel?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

const IGNORE_VALUE = '__nx_ignore__';

/* The most rows the dry-run table draws. The counts above it, and the import itself, cover every row. */
const PREVIEW_ROW_CAP = 200;

const DELIMITER_NAMES = { ',': 'Comma', ';': 'Semicolon', '\t': 'Tab' } as const;

const EMPTY_SCHEMA_FIELDS: readonly CsvSchemaField[] = [];

interface WizardStepSpec {
  id: string;
  title: string;
  description: string;
}

function autoMatchColumns(headers: string[], schemaFields: readonly CsvSchemaField[]): CsvColumnMapping {
  const candidates: Array<{ colIdx: number; fieldKey: string; score: number }> = [];

  headers.forEach((header, colIdx) => {
    schemaFields.forEach((field) => {
      const score = headerSimilarity(header, field);
      if (score >= 55) {
        candidates.push({ colIdx, fieldKey: field.key, score });
      }
    });
  });

  candidates.sort((a, b) => b.score - a.score);

  const usedCols = new Set<number>();
  const usedFields = new Set<string>();
  const mapping: CsvColumnMapping = {};

  for (const cand of candidates) {
    if (usedCols.has(cand.colIdx) || usedFields.has(cand.fieldKey)) continue;
    mapping[cand.colIdx] = cand.fieldKey;
    usedCols.add(cand.colIdx);
    usedFields.add(cand.fieldKey);
  }

  headers.forEach((_, idx) => {
    if (!mapping[idx]) {
      mapping[idx] = IGNORE_VALUE;
    }
  });

  return mapping;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateAndCoerceCell(
  rawValue: string,
  field: CsvSchemaField,
): {
  coerced: string | number | null;
  issue?: CsvCellIssue;
} {
  const val = rawValue.trim();
  const severity: CsvIssueSeverity = field.required ? 'critical' : 'warning';

  if (val === '') {
    if (field.required) {
      return {
        coerced: null,
        issue: {
          fieldKey: field.key,
          fieldLabel: field.label,
          severity: 'critical',
          message: `Required field "${field.label}" is empty`,
        },
      };
    }
    return { coerced: null };
  }

  const fieldType = field.type ?? 'string';

  if (fieldType === 'number') {
    const read = coerceCsvNumber(val);
    if (read.kind === 'number') return { coerced: read.value };
    /* Past 2^53 the value is kept as its digits: an id, which a number would round. */
    if (read.kind === 'text' && read.reason === 'too-large') return { coerced: read.value };
    if (read.kind === 'text') {
      return {
        coerced: read.value,
        issue: {
          fieldKey: field.key,
          fieldLabel: field.label,
          severity,
          message: `"${val}" could be read two ways for "${field.label}" (a thousands comma or a decimal comma); it is kept as text`,
        },
      };
    }
    return {
      coerced: null,
      issue: {
        fieldKey: field.key,
        fieldLabel: field.label,
        severity,
        message: `Expected number for "${field.label}", got "${val}"`,
      },
    };
  }

  if (fieldType === 'email') {
    if (!EMAIL_RE.test(val)) {
      return {
        coerced: val,
        issue: {
          fieldKey: field.key,
          fieldLabel: field.label,
          severity,
          message: `Invalid email address "${val}"`,
        },
      };
    }
    return { coerced: val };
  }

  if (fieldType === 'date') {
    const parsed = Date.parse(val);
    if (Number.isNaN(parsed) || val.length < 6) {
      return {
        coerced: val,
        issue: {
          fieldKey: field.key,
          fieldLabel: field.label,
          severity,
          message: `Unrecognized date "${val}" (expected YYYY-MM-DD)`,
        },
      };
    }
    return { coerced: val };
  }

  return { coerced: val };
}

const WIZARD_STEPS: readonly WizardStepSpec[] = [
  {
    id: 'source',
    title: 'Source CSV',
    description: 'Paste, upload, or load sample',
  },
  {
    id: 'mapping',
    title: 'Column mapping',
    description: 'Match headers to target schema',
  },
  {
    id: 'dry-run',
    title: 'Dry run and commit',
    description: 'Validate types & commit import',
  },
];

function WizardStepBar({
  steps,
  currentStep,
  onStepClick,
}: {
  steps: readonly WizardStepSpec[];
  currentStep: number;
  onStepClick: (index: number) => void;
}) {
  return (
    <ol className="nx-stepper" data-orientation="horizontal" aria-label="Import progress">
      {steps.map((s, idx) => {
        const status = idx < currentStep ? 'complete' : idx === currentStep ? 'active' : 'upcoming';
        return (
          <li key={s.id} className="nx-stepper-item" data-status={status}>
            <button
              type="button"
              onClick={() => onStepClick(idx)}
              aria-current={status === 'active' ? 'step' : undefined}
              className="nx-stepper-trigger nx-focusable"
            >
              <span className="nx-stepper-badge" data-status={status}>
                {status === 'complete' ? <Icon name="check" size={12} weight="bold" /> : idx + 1}
              </span>
              <span className="nx-stepper-copy">
                <span className="nx-stepper-title">{s.title}</span>
                <span className="nx-stepper-description">{s.description}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Three-step CSV import wizard with header auto-matching, cell type validation, and dry-run commit summary. */
export function CsvImportWizard({
  schemaFields = EMPTY_SCHEMA_FIELDS,
  sampleCsv,
  initialCsv = '',
  onCommitImport,
  commitLabel = 'Commit import',
  className,
  ref,
}: CsvImportWizardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [csvText, setCsvText] = useState<string>(initialCsv);
  const deferredCsvText = useDeferredValue(csvText);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const [mapping, setMapping] = useState<CsvColumnMapping>({});
  const [showIssuesOnly, setShowIssuesOnly] = useState(false);
  const [skipInvalidRows, setSkipInvalidRows] = useState(true);
  const [committedResult, setCommittedResult] = useState<CsvImportResult | null>(null);

  /* The text is parsed once, here, and behind the typing: a large paste used to be parsed twice on every keystroke
     (once to draw, once more to match its columns) before the box could show the character typed. */
  const parsed = useMemo(() => parseCsvText(deferredCsvText), [deferredCsvText]);

  /* The columns are matched again when the header line changes, off that one parse. Editing a data row leaves a
     mapping the person has corrected alone. */
  const headerLine = parsed.headers.join('\u001f');
  const [matchedHeaderLine, setMatchedHeaderLine] = useState(headerLine);
  if (matchedHeaderLine !== headerLine) {
    setMatchedHeaderLine(headerLine);
    setMapping(parsed.headers.length > 0 ? autoMatchColumns(parsed.headers, schemaFields) : {});
  }

  const applyCsvSource = useCallback((nextText: string, fileName: string | null = null) => {
    setCsvText(nextText);
    setUploadedFileName(fileName);
    setCommittedResult(null);
  }, []);

  const readCsvFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      applyCsvSource(content, file.name);
    };
    reader.readAsText(file);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      readCsvFile(file);
    }
    e.target.value = '';
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      readCsvFile(file);
    }
  };

  const proceedToMapping = () => {
    if (parsed.headers.length === 0 || parsed.rows.length === 0 || parsed.error) return;
    const hasExistingKeys = Object.keys(mapping).length === parsed.headers.length;
    if (!hasExistingKeys) {
      setMapping(autoMatchColumns(parsed.headers, schemaFields));
    }
    setStep(1);
  };

  /* --- Mapping Analysis --- */
  const mappedFieldToCols = useMemo(() => {
    const byField = new Map<string, number[]>();
    parsed.headers.forEach((_, colIdx) => {
      const target = mapping[colIdx];
      if (target && target !== IGNORE_VALUE) {
        const list = byField.get(target) ?? [];
        list.push(colIdx);
        byField.set(target, list);
      }
    });
    return byField;
  }, [mapping, parsed.headers]);

  const requiredFields = useMemo(() => schemaFields.filter((f) => f.required), [schemaFields]);

  const unmappedRequiredFields = useMemo(
    () => requiredFields.filter((f) => !mappedFieldToCols.has(f.key)),
    [mappedFieldToCols, requiredFields],
  );

  const duplicateMappedFields = useMemo(
    () => schemaFields.filter((f) => (mappedFieldToCols.get(f.key)?.length ?? 0) > 1),
    [mappedFieldToCols, schemaFields],
  );

  const activeMappedSchemaFields = useMemo(
    () => schemaFields.filter((f) => mappedFieldToCols.has(f.key)),
    [mappedFieldToCols, schemaFields],
  );

  const canAdvanceFromMapping =
    activeMappedSchemaFields.length > 0 && unmappedRequiredFields.length === 0 && duplicateMappedFields.length === 0;

  const selectOptions = useMemo<SelectOption<string>[]>(
    () => [
      {
        value: IGNORE_VALUE,
        label: '— Ignore column —',
        textLabel: 'Ignore column',
      },
      ...schemaFields.map((f) => ({
        value: f.key,
        label: `${f.label}${f.required ? ' *' : ''} (${f.type ?? 'string'})`,
        textLabel: `${f.label}${f.required ? ' *' : ''}`,
      })),
    ],
    [schemaFields],
  );

  /* --- Dry-Run Validation --- */
  const validatedRows = useMemo<CsvValidatedRow[]>(() => {
    if (parsed.rows.length === 0) return [];

    return parsed.rows.map((cells, rIdx) => {
      const record: Record<string, string | number | null> = {};
      const displayValues: Record<string, string> = {};
      const issues: Record<string, CsvCellIssue> = {};

      for (const field of activeMappedSchemaFields) {
        const colIdx = mappedFieldToCols.get(field.key)?.[0];
        const rawVal = colIdx !== undefined ? (cells[colIdx] ?? '') : '';
        displayValues[field.key] = rawVal;

        const { coerced, issue } = validateAndCoerceCell(rawVal, field);
        record[field.key] = coerced;
        if (issue) {
          issues[field.key] = issue;
        }
      }

      return {
        rowNumber: rIdx + 1,
        rawCells: cells,
        record,
        displayValues,
        issues,
        valid: Object.keys(issues).length === 0,
      };
    });
  }, [activeMappedSchemaFields, mappedFieldToCols, parsed.rows]);

  const validRows = useMemo(() => validatedRows.filter((r) => r.valid), [validatedRows]);
  const issueRows = useMemo(() => validatedRows.filter((r) => !r.valid), [validatedRows]);
  const totalCellIssues = useMemo(() => validatedRows.reduce((acc, r) => acc + Object.keys(r.issues).length, 0), [validatedRows]);

  /* Every row is validated and counted; only the first of them are drawn. A table of every row of a fifty-thousand
     line file was fifty thousand table rows built on the main thread to show a screenful. */
  const matchingPreviewRows = showIssuesOnly ? issueRows : validatedRows;
  const displayedPreviewRows = useMemo(() => matchingPreviewRows.slice(0, PREVIEW_ROW_CAP), [matchingPreviewRows]);

  const handleCommit = () => {
    const rowsToImport = skipInvalidRows ? validRows : validatedRows;
    const headerToFieldMap: Record<string, string> = {};
    parsed.headers.forEach((h, idx) => {
      const target = mapping[idx];
      if (target && target !== IGNORE_VALUE) {
        headerToFieldMap[h] = target;
      }
    });

    const result: CsvImportResult = {
      records: rowsToImport.map((r) => r.record),
      validCount: validRows.length,
      issueRowCount: issueRows.length,
      skippedCount: skipInvalidRows ? issueRows.length : 0,
      mapping: headerToFieldMap,
    };

    setCommittedResult(result);
    onCommitImport?.(result);
  };

  const resetWizard = () => {
    setCsvText('');
    setUploadedFileName(null);
    setMapping({});
    setShowIssuesOnly(false);
    setCommittedResult(null);
    setStep(0);
  };

  return (
    <div ref={ref} className={cx('nx-csv-wizard', className)}>
      {/* Top Stepper Header */}
      <div className="nx-csv-wizard-head">
        <WizardStepBar
          steps={WIZARD_STEPS}
          currentStep={step}
          onStepClick={(nextIdx) => {
            if (nextIdx === 0) setStep(0);
            else if (nextIdx === 1 && parsed.headers.length > 0 && parsed.rows.length > 0) {
              proceedToMapping();
            } else if (nextIdx === 2 && canAdvanceFromMapping) {
              setStep(2);
            }
          }}
        />
      </div>

      {/* STEP 1: SOURCE CSV */}
      {step === 0 && (
        <div className="nx-csv-step">
          <div className="nx-csv-source-toolbar">
            <div className="nx-csv-source-copy">
              <h3 className="nx-csv-step-title">Provide source CSV data</h3>
              <p className="nx-csv-step-desc">
                {sampleCsv ? (
                  <>
                    Upload a <Code>.csv</Code> file, paste comma-separated rows directly, or load sample records to test dry-run validation.
                  </>
                ) : (
                  <>
                    Upload a <Code>.csv</Code> file or paste comma-separated rows directly.
                  </>
                )}
              </p>
            </div>

            <div className="nx-csv-source-actions">
              {sampleCsv !== undefined ? (
                <Button
                  size="sm"
                  variant="soft"
                  leadingIcon={<Icon name="sparkle" size={14} weight="bold" />}
                  onClick={() => applyCsvSource(sampleCsv, 'sample.csv')}
                >
                  Load sample dataset
                </Button>
              ) : null}
              {csvText.length > 0 && (
                <Button size="sm" variant="ghost" leadingIcon={<Icon name="trash" size={14} />} onClick={() => applyCsvSource('', null)}>
                  Clear
                </Button>
              )}
            </div>
          </div>

          {/* File Upload / Drag Dropzone */}
          <div
            data-dragging={dragActive ? '' : undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className="nx-csv-dropzone nx-focusable"
          >
            <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleFileChange} className="nx-sr-only" tabIndex={-1} />
            <div className="nx-csv-dropzone-icon" aria-hidden="true">
              {uploadedFileName ? <Icon name="file-csv" size={22} weight="bold" /> : <Icon name="upload-simple" size={20} weight="bold" />}
            </div>
            <div className="nx-csv-dropzone-text">
              {uploadedFileName ? (
                <>
                  <span className="nx-csv-dropzone-primary">Loaded {uploadedFileName}</span>
                  <span className="nx-csv-dropzone-sub">Click or drop another .csv file to replace</span>
                </>
              ) : (
                <>
                  <span className="nx-csv-dropzone-primary">Drop a .csv file here, or click to browse</span>
                  <span className="nx-csv-dropzone-sub">RFC-4180 compliant — supports quoted commas &amp; UTF-8 text</span>
                </>
              )}
            </div>
          </div>

          <TextArea
            label="Raw CSV Content"
            monospace
            rows={7}
            value={csvText}
            onValueChange={(next) => applyCsvSource(next, uploadedFileName)}
            placeholder={'column_a,column_b\nvalue_1,value_2'}
          />

          {parsed.error ? <Alert tone="critical" title="This CSV could not be read to the end" description={parsed.error.message} /> : null}

          <div className="nx-csv-step-footer">
            <div className="nx-csv-parse-status">
              {parsed.headers.length > 0 ? (
                <>
                  <Badge tone="good" pill>
                    {parsed.headers.length} columns
                  </Badge>
                  <Badge tone={parsed.rows.length > 0 ? 'accent' : 'warning'} pill>
                    {parsed.rows.length} {parsed.rows.length === 1 ? 'data row' : 'data rows'}
                  </Badge>
                  {parsed.delimiter !== ',' ? (
                    <Badge tone="neutral" pill>
                      {DELIMITER_NAMES[parsed.delimiter]}-separated
                    </Badge>
                  ) : null}
                </>
              ) : (
                <span className="nx-csv-muted-note">Paste or upload CSV rows with a header line to continue.</span>
              )}
            </div>

            <Button
              variant="primary"
              trailingIcon={<Icon name="arrow-right" size={14} weight="bold" />}
              disabled={parsed.headers.length === 0 || parsed.rows.length === 0 || parsed.error !== undefined}
              onClick={proceedToMapping}
            >
              Map columns
            </Button>
          </div>
        </div>
      )}

      {/* STEP 2: COLUMN MAPPING */}
      {step === 1 && (
        <div className="nx-csv-step">
          <div className="nx-csv-source-toolbar">
            <div className="nx-csv-source-copy">
              <h3 className="nx-csv-step-title">Map CSV columns to target schema</h3>
              <p className="nx-csv-step-desc">
                Columns were auto-matched by header similarity. Ensure all required schema fields are mapped before running dry-run
                validation.
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Icon name="arrows-left-right" size={14} />}
              onClick={() => setMapping(autoMatchColumns(parsed.headers, schemaFields))}
            >
              Auto-Match
            </Button>
          </div>

          {/* Schema Field Coverage Bar */}
          <div className="nx-csv-schema-bar">
            <div className="nx-csv-schema-summary">
              <span className="nx-csv-schema-label">Target schema fields</span>
              <span className="nx-csv-schema-tally">
                {requiredFields.length - unmappedRequiredFields.length} of {requiredFields.length} required mapped
              </span>
            </div>
            <div className="nx-csv-schema-pills">
              {schemaFields.map((field) => {
                const mappedCount = mappedFieldToCols.get(field.key)?.length ?? 0;
                const isMapped = mappedCount === 1;
                const isDuplicate = mappedCount > 1;
                const tone = isDuplicate ? 'critical' : isMapped ? 'good' : field.required ? 'warning' : 'neutral';

                return (
                  <Badge
                    key={field.key}
                    tone={tone}
                    icon={
                      isMapped ? (
                        <Icon name="check" size={11} weight="bold" />
                      ) : field.required ? (
                        <Icon name="warning" size={11} weight="bold" />
                      ) : undefined
                    }
                  >
                    {field.label}
                    {field.required ? ' *' : ''}
                  </Badge>
                );
              })}
            </div>
          </div>

          {duplicateMappedFields.length > 0 && (
            <Alert
              tone="critical"
              title="Duplicate column mapping"
              description={`Each target field can only be mapped once: ${duplicateMappedFields.map((f) => f.label).join(', ')}.`}
            />
          )}

          {/* Column Mapping Rows */}
          <div className="nx-csv-mapping-table-wrap">
            <table className="nx-csv-mapping-table">
              <thead>
                <tr>
                  <th>CSV Header</th>
                  <th>Sample values</th>
                  <th aria-hidden="true" />
                  <th>Target schema field</th>
                </tr>
              </thead>
              <tbody>
                {parsed.headers.map((header, colIdx) => {
                  const selectedTarget = mapping[colIdx] ?? IGNORE_VALUE;
                  const isIgnored = selectedTarget === IGNORE_VALUE;
                  const sampleVals = parsed.rows
                    .slice(0, 2)
                    .map((r) => r[colIdx])
                    .filter(Boolean);
                  const matchedSchema = schemaFields.find((f) => f.key === selectedTarget);

                  return (
                    <tr key={`${header}-${colIdx}`} data-ignored={isIgnored ? '' : undefined}>
                      <td>
                        <div className="nx-csv-col-name">
                          <span className="nx-csv-col-index">#{colIdx + 1}</span>
                          <span>{header}</span>
                        </div>
                      </td>
                      <td>
                        <div className="nx-csv-samples">
                          {sampleVals.length > 0 ? (
                            sampleVals.map((sv, sIdx) => <Code key={sIdx}>{sv}</Code>)
                          ) : (
                            <span className="nx-csv-muted-note">Empty</span>
                          )}
                        </div>
                      </td>
                      <td className="nx-csv-map-arrow" aria-hidden="true">
                        <Icon name="arrow-right" size={14} />
                      </td>
                      <td className="nx-csv-map-select-cell">
                        <div className="nx-csv-map-select-row">
                          <Select<string>
                            size="sm"
                            ariaLabel={`Target schema field for ${header}`}
                            options={selectOptions}
                            value={selectedTarget}
                            onValueChange={(next) => {
                              if (next !== null) {
                                setMapping((prev) => ({
                                  ...prev,
                                  [colIdx]: next,
                                }));
                              }
                            }}
                          />
                          {matchedSchema && <Badge tone="accent">{matchedSchema.type ?? 'string'}</Badge>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="nx-csv-step-footer">
            <Button variant="secondary" leadingIcon={<Icon name="arrow-left" size={14} weight="bold" />} onClick={() => setStep(0)}>
              Back
            </Button>

            <div className="nx-csv-footer-end">
              {unmappedRequiredFields.length > 0 && (
                <span className="nx-csv-unmapped-hint">Missing required: {unmappedRequiredFields.map((f) => f.label).join(', ')}</span>
              )}
              <Button
                variant="primary"
                trailingIcon={<Icon name="arrow-right" size={14} weight="bold" />}
                disabled={!canAdvanceFromMapping}
                onClick={() => setStep(2)}
              >
                Run dry-run validation
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 3: DRY-RUN VALIDATION & COMMIT */}
      {step === 2 && (
        <div className="nx-csv-step">
          {committedResult ? (
            <div className="nx-csv-committed">
              <div className="nx-csv-committed-icon" aria-hidden="true">
                <Icon name="check-circle" size={28} weight="bold" />
              </div>
              <h3 className="nx-csv-committed-title">
                Import committed — {committedResult.records.length} {committedResult.records.length === 1 ? 'record' : 'records'} imported
              </h3>
              <p className="nx-csv-committed-desc">
                {committedResult.skippedCount > 0
                  ? `${committedResult.validCount} clean rows committed and ${committedResult.skippedCount} rows with validation issues were skipped.`
                  : `All ${committedResult.records.length} rows passed dry-run checks and were committed cleanly.`}
              </p>
              <div className="nx-csv-committed-actions">
                <Button variant="secondary" onClick={resetWizard}>
                  Import another CSV
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* Dry-Run Summary Strip */}
              <div className="nx-csv-dryrun-stats">
                <div className="nx-csv-stat-pill" data-tone="neutral">
                  <span className="nx-csv-stat-label">Total rows</span>
                  <span className="nx-csv-stat-val">{validatedRows.length}</span>
                </div>
                <div className="nx-csv-stat-pill" data-tone="good">
                  <span className="nx-csv-stat-label">Valid rows</span>
                  <span className="nx-csv-stat-val">{validRows.length}</span>
                </div>
                <div className="nx-csv-stat-pill" data-tone={issueRows.length > 0 ? 'warning' : 'neutral'}>
                  <span className="nx-csv-stat-label">Warnings / type mismatches</span>
                  <span className="nx-csv-stat-val">
                    {issueRows.length} {totalCellIssues > 0 ? `(${totalCellIssues} ${totalCellIssues === 1 ? 'cell' : 'cells'})` : ''}
                  </span>
                </div>
              </div>

              {/* Filter & Skip Controls */}
              <div className="nx-csv-dryrun-controls">
                <div className="nx-csv-filter-tabs">
                  <Button size="xs" variant={!showIssuesOnly ? 'secondary' : 'ghost'} onClick={() => setShowIssuesOnly(false)}>
                    All rows ({validatedRows.length})
                  </Button>
                  <Button
                    size="xs"
                    variant={showIssuesOnly ? 'secondary' : 'ghost'}
                    disabled={issueRows.length === 0}
                    onClick={() => setShowIssuesOnly(true)}
                  >
                    Issues only ({issueRows.length})
                  </Button>
                </div>

                {issueRows.length > 0 && (
                  <Checkbox
                    size="sm"
                    checked={skipInvalidRows}
                    onCheckedChange={(checked) => setSkipInvalidRows(Boolean(checked))}
                    label={`Skip ${issueRows.length} ${issueRows.length === 1 ? 'row' : 'rows'} with issues on commit`}
                  />
                )}
              </div>

              {/* Preview Table Highlighting Invalid / Warning Cells */}
              <div className="nx-csv-preview-wrap">
                <table className="nx-csv-preview-table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Status</th>
                      {activeMappedSchemaFields.map((field) => (
                        <th key={field.key}>
                          <span>{field.label}</span>
                          <span className="nx-csv-th-type">{field.type ?? 'string'}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayedPreviewRows.map((row) => {
                      const issueList = Object.values(row.issues);
                      const hasCritical = issueList.some((iss) => iss.severity === 'critical');

                      return (
                        <tr key={row.rowNumber} data-invalid={!row.valid ? '' : undefined}>
                          <td className="nx-csv-row-num">#{row.rowNumber}</td>
                          <td>
                            {row.valid ? (
                              <Badge tone="good" icon={<Icon name="check" size={10.5} weight="bold" />}>
                                Valid
                              </Badge>
                            ) : hasCritical ? (
                              <Badge tone="critical" icon={<Icon name="warning" size={11} weight="bold" />}>
                                Type error
                              </Badge>
                            ) : (
                              <Badge tone="warning" icon={<Icon name="warning" size={11} weight="bold" />}>
                                Warning
                              </Badge>
                            )}
                          </td>
                          {activeMappedSchemaFields.map((field) => {
                            const cellIssue = row.issues[field.key];
                            const rawDisplay = row.displayValues[field.key] ?? '';

                            return (
                              <td
                                key={field.key}
                                data-issue={cellIssue?.severity}
                                title={cellIssue?.message}
                                className="nx-csv-preview-cell"
                              >
                                <div className="nx-csv-cell-inner">
                                  <span className="nx-csv-cell-value">
                                    {rawDisplay || <span className="nx-csv-cell-empty">empty</span>}
                                  </span>
                                  {cellIssue && <span className="nx-csv-cell-issue-msg">{cellIssue.message}</span>}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {matchingPreviewRows.length > displayedPreviewRows.length ? (
                <p className="nx-csv-muted-note">
                  Showing the first {displayedPreviewRows.length} of {matchingPreviewRows.length} rows. Every row is validated and counted
                  above, whether or not it is drawn here.
                </p>
              ) : null}

              <div className="nx-csv-step-footer">
                <Button variant="secondary" leadingIcon={<Icon name="arrow-left" size={14} weight="bold" />} onClick={() => setStep(1)}>
                  Back to Mapping
                </Button>

                <Button
                  variant="primary"
                  leadingIcon={<Icon name="check" size={14} weight="bold" />}
                  disabled={skipInvalidRows && validRows.length === 0}
                  onClick={handleCommit}
                >
                  {commitLabel} ({skipInvalidRows ? validRows.length : validatedRows.length}{' '}
                  {(skipInvalidRows ? validRows.length : validatedRows.length) === 1 ? 'row' : 'rows'})
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

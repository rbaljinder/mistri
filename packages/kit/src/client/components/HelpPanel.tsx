/**
 * The query language, written down inside the tool that speaks it:
 * grammar on the left and working examples on the right, every example
 * built from the *connected* schema so clicking one returns rows. The
 * generator (`buildExamples`), the sections' text and the sample fetch
 * stay in `helpContent.js`; this is the panel.
 *
 * The keys for the room the reader is in come first, marked as this page's;
 * an App's reader gets the keys alone (`keysOnly`), with no query language
 * to learn and no examples to fetch.
 */
import { useEffect, useRef, useState } from 'react';
import { currentEntry, state, trapFocus } from '../core.js';
import { SECTIONS, buildExamples, runExample, sampleRows } from '../helpContent.js';
import { say } from '../copy/workbench/components/HelpPanel.js';
import '../help.css';
import { addHostListener, removeHostListener } from '../shellHost.js';

interface Example {
  query: string;
  caption: string;
}
interface Built {
  examples: Record<string, Example>;
  sampleTable?: string | null;
}
interface SectionSpec {
  title: string;
  note: string;
  grammar: Array<[string, string]>;
  keys?: string[];
  absent?: string;
  /** The rooms whose keys these are: the panel puts the section first there. */
  rooms?: string[];
  /** Shown in an App's keys-only panel too. */
  app?: boolean;
}

/**
 * Draw with what is known now, then again when the sample arrives. The
 * first pass is a complete set of examples that all run, built from the
 * schema alone; the second only makes them better. Keys alone need neither.
 */
function useExamples(enabled: boolean): Built {
  const schema = (state as { schema: unknown }).schema;
  const [built, setBuilt] = useState<Built>(() => (enabled ? (buildExamples(schema, {}) as Built) : { examples: {} }));
  useEffect(() => {
    if (!enabled) return;
    const first = buildExamples(schema, {}) as Built;
    setBuilt(first);
    if (!first.sampleTable) return;
    let live = true;
    void (sampleRows(first.sampleTable) as Promise<Array<Record<string, unknown>>>).then((rows) => {
      /* The connection can change while the request is in flight; rows from the database you have just left must not land beside this schema's names. */
      if (!live || !rows.length || (state as { schema: unknown }).schema !== schema) return;
      setBuilt(buildExamples(schema, { [first.sampleTable!]: rows }) as Built);
    });
    return () => {
      live = false;
    };
  }, [schema, enabled]);
  return built;
}

export function HelpPanel({ onClose, keysOnly = false }: { onClose: () => void; keysOnly?: boolean }) {
  const backdrop = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const built = useExamples(!keysOnly);
  useEffect(() => {
    const release = trapFocus(backdrop.current!) as (() => void) | undefined;
    close.current?.focus();
    return () => release?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      /* The panel swallows the single-key shortcuts underneath it; modified keys are left alone so ⌘K and ⌘B still work from here. */
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
    };
    addHostListener(document, 'keydown', onKey, true);
    return () => removeHostListener(document, 'keydown', onKey, true);
  }, [onClose]);
  const label = (state as { schema?: { label?: string } }).schema?.label ?? say('thisDatabase');
  /* The room the panel was opened over: its keys first, the rest in their order. */
  const here = (currentEntry() as { kind?: string } | undefined)?.kind;
  const offered = (SECTIONS as SectionSpec[]).filter((spec) => !keysOnly || spec.app);
  const ordered = [
    ...offered.filter((spec) => here && spec.rooms?.includes(here)),
    ...offered.filter((spec) => !(here && spec.rooms?.includes(here))),
  ];
  const title = keysOnly ? say('keyboard') : say('queryLanguage');
  return (
    <div
      ref={backdrop}
      className="help-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="help-panel" role="dialog" aria-modal="true" aria-label={title}>
        <header className="help-head">
          <div>
            <h2 className="help-title">{title}</h2>
            <p className="help-sub">{keysOnly ? say('theKeysThisPage') : say('everyExampleBelowRuns', { label })}</p>
          </div>
          <button
            ref={close}
            type="button"
            className="help-close"
            aria-label={say('common.close')}
            title={say('closeParenEsc')}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="help-body">
          {ordered.map((spec) => (
            <Section
              key={spec.title}
              spec={spec}
              examples={built.examples}
              onRun={onClose}
              here={Boolean(here && spec.rooms?.includes(here))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Section({
  spec,
  examples,
  onRun,
  here,
}: {
  spec: SectionSpec;
  examples: Record<string, Example>;
  onRun: () => void;
  here: boolean;
}) {
  /* A section with no `keys` is static reference and must not reach for examples it never claimed. */
  const found = (spec.keys ?? []).map((key) => examples[key]).filter(Boolean) as Example[];
  return (
    <section className={`help-section${here ? ' is-here' : ''}`}>
      <h3 className="help-section-title">
        {spec.title}
        {here && <span className="help-here"> {say('thisPage')}</span>}
      </h3>
      <p className="help-note">{spec.note}</p>
      <dl className="help-grammar">
        {spec.grammar.map(([syntax, meaning]) => (
          <div key={syntax}>
            <dt>
              <code>{syntax}</code>
            </dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
      {found.length ? (
        <div className="help-examples">
          {found.map((example) => (
            <button
              key={example.query}
              type="button"
              className="help-example"
              title={say('runThisQuery')}
              onClick={() => {
                onRun();
                runExample(example.query);
              }}
            >
              <code className="help-query">{example.query}</code>
              <span className="help-caption">{example.caption}</span>
            </button>
          ))}
        </div>
      ) : spec.absent ? (
        /* A section with nothing to demonstrate says why: the dot-walk grammar is real even on a schema with no foreign keys. */
        <p className="help-absent">{spec.absent}</p>
      ) : null}
    </section>
  );
}

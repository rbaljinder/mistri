/**
 * The platform's own inputs for the display formats that are edited as
 * something other than a box of text: a rating's stars, a slider along a
 * number's range, a color, a time of day, a month, a year, a JSON
 * document, a code the camera reads and a signature.
 *
 * Each is an input component like an author's (inputRenderers.tsx): it
 * stands in a record's edit form, its New form and a grid cell's editor,
 * hands the form a value through `onChange`, and is fetched the first time a
 * field needs it, so no first page carries it. Until it is here the plain box
 * stands in its place, and the form's rules and the server still judge what
 * it hands back.
 *
 * The native pickers do the hard parts — a color, a time, a month — so a
 * keyboard and a screen reader get the browser's own control; the stars are
 * a radio group, one tab stop, the arrow keys moving the pick.
 */
import { useEffect, useId, useRef, useState, type ComponentType, type KeyboardEvent, type PointerEvent } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { api } from '@mistriwork/kit/client/core.js';
import { pageBridge } from '@mistriwork/kit/client/uiBridge.js';
import { richTextImageAddress } from '@mistriwork/engine/shared/richText.js';
import { appWord } from '@mistriwork/kit/client/messages.js';
import { say } from '../copy/record/components/builtInInputs.js';
import './builtInInputs.css';

interface InputProps {
  value: string | number | boolean | null;
  onChange(value: string | number | boolean | null): void;
  id: string;
  describedBy?: string;
  invalid: boolean;
  disabled: boolean;
  required: boolean;
  label: string;
  field: { name: string; resource?: string; rule?: Rule };
}

type Rule = { outOf?: number; slider?: { min: number; max: number; step?: number }; signature?: true | { table: string; key: string } };

/** The column's display rule, as the App's payload carries it; a command's field brings its own. */
function ruleOf(field: InputProps['field']): Rule {
  if (field.rule) return field.rule;
  const resources = (pageBridge.activeApp() as { resources?: Record<string, { display?: Record<string, Rule> }> } | null)?.resources;
  const display = field.resource ? resources?.[field.resource]?.display : undefined;
  return display && Object.hasOwn(display, field.name) ? display[field.name] : {};
}

const text = (value: InputProps['value']) => (value === null || value === undefined ? '' : String(value));

/** Stars as a radio group: a click picks one, picking the one already picked clears it where the field may be empty. */
function RatingInput({ value, onChange, id, describedBy, invalid, disabled, required, label, field }: InputProps) {
  const outOf = ruleOf(field).outOf ?? 5;
  const picked = Math.max(0, Math.min(outOf, Math.round(Number(value) || 0)));
  const name = useId();
  const pick = (n: number) => onChange(n === picked && !required ? null : n);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = Math.max(required ? 1 : 0, Math.min(outOf, picked + step));
    onChange(next === 0 ? null : next);
  };
  return (
    <div
      id={id}
      className="rating-input"
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      aria-required={required || undefined}
      onKeyDown={onKeyDown}
    >
      {Array.from({ length: outOf }, (_, index) => {
        const n = index + 1;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            name={name}
            className={n <= picked ? 'rating-input-star is-on' : 'rating-input-star'}
            aria-checked={n === picked}
            aria-label={say('stars', { stars: n, outOf })}
            tabIndex={n === (picked || 1) ? 0 : -1}
            disabled={disabled}
            onClick={() => pick(n)}
          >
            ★
          </button>
        );
      })}
    </div>
  );
}

/** A range with its figure beside it, the figure live as the thumb moves. */
function SliderInput({ value, onChange, id, describedBy, invalid, disabled, required, label, field }: InputProps) {
  const { min = 0, max = 100, step = 1 } = ruleOf(field).slider ?? {};
  const shown = text(value);
  return (
    <span className="slider-input">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown === '' ? min : shown}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        required={required}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output htmlFor={id} className="slider-input-figure num-value">
        {shown === '' ? '—' : shown}
      </output>
    </span>
  );
}

/** The system's color picker, its code beside it as a box of its own for a reader who has one to paste. */
function ColorInput({ value, onChange, id, describedBy, invalid, disabled, required, label }: InputProps) {
  const shown = text(value);
  const valid = /^#[0-9a-f]{6}$/i.test(shown);
  return (
    <span className="color-input">
      <input
        type="color"
        className="color-input-picker"
        value={valid ? shown.toLowerCase() : '#000000'}
        aria-label={say('pickColor', { label })}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        id={id}
        className="color-input-code"
        type="text"
        value={shown}
        placeholder="#1d6a5a"
        spellCheck={false}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        required={required}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value.trim() || null)}
      />
    </span>
  );
}

/** One native picker: a time of day, a month, a year (a number box, since there is no year picker). */
function nativeInput(type: 'time' | 'month' | 'year'): ComponentType<InputProps> {
  function NativeInput({ value, onChange, id, describedBy, invalid, disabled, required, label }: InputProps) {
    const raw = text(value);
    /* A stored time keeps its seconds ("14:30:00") and a month may be a date ("2026-10-01"): the picker takes the part it shows. */
    const shown = type === 'time' ? raw.slice(0, 5) : type === 'month' ? raw.slice(0, 7) : raw;
    return (
      <input
        id={id}
        className={`native-input ${type}-input`}
        type={type === 'year' ? 'number' : type}
        {...(type === 'year' ? { min: 1, max: 9999, step: 1, inputMode: 'numeric' as const } : {})}
        value={shown}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        required={required}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === '' ? null : type === 'year' ? Number(next) : next);
        }}
      />
    );
  }
  return NativeInput;
}

/** Where a JSON text stops parsing, said as the parser says it, or null for a document that reads. */
export function jsonProblem(source: string): string | null {
  if (!source.trim()) return null;
  try {
    JSON.parse(source);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** A stored document as text to edit: a string as it is, an object (a Postgres jsonb) laid out two spaces deep. */
const jsonText = (value: unknown) =>
  value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);

/**
 * A JSON document in a box of its own: monospaced, tab-free, its parse problem
 * said under it while it is typed, and a Format button that lays a document
 * that reads out two spaces deep. The text is the value, so what was typed is
 * what is kept until it reads; the server refuses a document that does not
 * (appValidation.ts), whatever control sent it.
 */
function JsonInput({ value, onChange, id, describedBy, invalid, disabled, required, label }: InputProps) {
  const shown = jsonText(value);
  const [problem, setProblem] = useState(() => jsonProblem(shown));
  const problemId = useId();
  const rows = Math.min(16, Math.max(4, shown.split('\n').length + 1));
  const change = (next: string) => {
    setProblem(jsonProblem(next));
    onChange(next.trim() ? next : null);
  };
  return (
    <span className="json-input">
      <textarea
        id={id}
        className="json-input-text"
        value={shown}
        rows={rows}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={label}
        aria-describedby={[describedBy, problem ? problemId : ''].filter(Boolean).join(' ') || undefined}
        aria-invalid={invalid || Boolean(problem) || undefined}
        required={required}
        disabled={disabled}
        onChange={(event) => change(event.target.value)}
      />
      <span className="json-input-foot">
        <span id={problemId} className="json-input-problem" aria-live="polite">
          {problem ? say('jsonProblem', { problem }) : ''}
        </span>
        <Button
          intent="quiet"
          className="json-input-format"
          disabled={disabled || Boolean(problem) || !shown.trim()}
          onClick={() => change(JSON.stringify(JSON.parse(shown), null, 2))}
        >
          {say('formatJson')}
        </Button>
      </span>
    </span>
  );
}

/** The browser's code reader where it has one (Chromium on Android and macOS, Safari 17+): absent elsewhere. */
type CodeReader = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue?: string }>> };
const codeReader = (): (new () => CodeReader) | undefined =>
  typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia
    ? undefined
    : (window as unknown as { BarcodeDetector?: new () => CodeReader }).BarcodeDetector;

/** The camera, looking for a code five times a second until it reads one; the stream stops when it closes. */
function Camera({ onRead, onFail }: { onRead(code: string): void; onFail(): void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const Reader = codeReader();
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(
      async (opened) => {
        stream = opened;
        if (stopped || !video.current || !Reader) return opened.getTracks().forEach((track) => track.stop());
        video.current.srcObject = opened;
        await video.current.play().catch(() => undefined);
        const reader = new Reader();
        const look = async () => {
          if (stopped || !video.current) return;
          const found = await reader.detect(video.current).catch(() => []);
          const code = found.find((item) => item.rawValue)?.rawValue;
          if (code) onRead(code);
          else timer = setTimeout(look, 200);
        };
        void look();
      },
      () => !stopped && onFail(),
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <video ref={video} className="scan-input-video" muted playsInline aria-label={say('cameraView')} />;
}

/**
 * A code typed, or read by the camera where the browser reads codes: a box
 * that always takes typing, so the form never waits on a camera, and beside
 * it a Scan button only where there is something to scan with. A read code
 * replaces the box's text, which can still be corrected by hand.
 */
function ScanInput({ value, onChange, id, describedBy, invalid, disabled, required, label }: InputProps) {
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState(false);
  const can = Boolean(codeReader());
  return (
    <span className="scan-input">
      <span className="scan-input-row">
        <input
          id={id}
          type="text"
          className="scan-input-text"
          value={text(value)}
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          required={required}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        />
        {can && (
          <Button
            intent="quiet"
            className="scan-input-button"
            aria-pressed={open}
            disabled={disabled}
            onClick={() => {
              setRefused(false);
              setOpen(!open);
            }}
          >
            {say(open ? 'stopScanning' : 'scan')}
          </Button>
        )}
      </span>
      {open && (
        <Camera
          onRead={(code) => {
            onChange(code);
            setOpen(false);
          }}
          onFail={() => {
            setRefused(true);
            setOpen(false);
          }}
        />
      )}
      {refused && (
        <span className="scan-input-note" role="status">
          {say('cameraRefused')}
        </span>
      )}
    </span>
  );
}

/** A canvas's picture as a PNG. */
async function pngOf(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error(say('signatureUnread'));
  return blob;
}

/** A picture's bytes as base64, for the file route. */
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

type Stroke = Array<[number, number]>;
/** The pad's drawing size in CSS pixels; the canvas is this times the screen's density, so a line stays sharp. */
const PAD = { wide: 480, high: 150 };

/**
 * A signature: drawn with a finger, a pen or the mouse (each stroke undone in
 * turn, or all cleared), or a name typed where drawing is not possible, and
 * kept with "Use this signature" as a PNG row of the file resource the column
 * points at; the form holds that row's key. A kept signature is shown as its
 * picture with "Sign again" beside it. Nothing is stored until it is kept.
 */
function SignatureInput(props: InputProps) {
  const rule = ruleOf(props.field).signature;
  const keeps = rule && typeof rule === 'object' ? rule : undefined;
  const keeper: SignatureKeeper | undefined = keeps && {
    keep: async (png) => {
      const reply = (await api('/api/file/upload', {
        table: keeps.table,
        values: {},
        file: { name: 'signature.png', type: 'image/png', data: await base64Of(png) },
      })) as { key?: Record<string, string | number>; errors?: unknown[]; error?: unknown };
      const stored = reply.key?.[keeps.key];
      if (stored === undefined || reply.errors || reply.error) throw new Error(say('signatureUnread'));
      return typeof stored === 'number' ? stored : String(stored);
    },
    picture: (value) => richTextImageAddress(keeps.table, { [keeps.key]: value }),
  };
  return <SignaturePad {...props} keeper={keeper} />;
}

/** Where a signature goes once kept, and the picture of a kept one: a row of a file resource, or a file held for a command. */
interface SignatureKeeper {
  /** Keeps the drawing; answers what the field holds for it. */
  keep(png: Blob): Promise<string | number>;
  /** The kept picture's address; undefined where there is none to show (a held file this page did not send). */
  picture(value: string | number): string | undefined;
}

/** The pad itself, kept by whichever keeper it is handed: without one, nothing can be kept. */
export function SignaturePad({
  value,
  onChange,
  id,
  describedBy,
  invalid,
  disabled,
  label,
  keeper,
}: Omit<InputProps, 'field' | 'required'> & { keeper: SignatureKeeper | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [typed, setTyped] = useState<string | null>(null);
  const [signing, setSigning] = useState(value === null || value === '');
  const [state, setState] = useState<'idle' | 'keeping' | 'failed'>('idle');
  const drawing = useRef<Stroke | null>(null);
  const again = useRef<HTMLButtonElement>(null);
  const kept = useRef(false);
  /* The button that kept the drawing is gone once it is kept: the focus moves to Sign again, inside the field, so a
     form that saves when the focus leaves the field saves when the reader moves on, not before. */
  useEffect(() => {
    if (kept.current && again.current) {
      kept.current = false;
      again.current.focus();
    }
  });
  const empty = typed === null ? strokes.length === 0 : !typed.trim();

  /* The whole drawing is laid again from its strokes on every change: an undo is a stroke left out. */
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const density = window.devicePixelRatio || 1;
    element.width = PAD.wide * density;
    element.height = PAD.high * density;
    context.setTransform(density, 0, 0, density, 0, 0);
    context.clearRect(0, 0, PAD.wide, PAD.high);
    // Ink on paper: the pad is white in every look, so the kept picture reads wherever it is shown.
    context.strokeStyle = context.fillStyle = '#111827';
    context.lineWidth = 2.4;
    context.lineCap = context.lineJoin = 'round';
    if (typed !== null) {
      context.font = 'italic 40px Georgia, "Times New Roman", serif';
      context.textBaseline = 'middle';
      context.fillText(typed, 24, PAD.high / 2, PAD.wide - 48);
      return;
    }
    for (const stroke of [...strokes, ...(drawing.current ? [drawing.current] : [])]) {
      context.beginPath();
      stroke.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
      if (stroke.length === 1) context.lineTo(stroke[0][0] + 0.1, stroke[0][1]);
      context.stroke();
    }
  });

  const at = (event: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect();
    // screen-px: the pointer's ruler, mapped onto the pad's own units by the ratio.
    return [((event.clientX - box.left) / (box.width || 1)) * PAD.wide, ((event.clientY - box.top) / (box.height || 1)) * PAD.high];
  };
  const [, redraw] = useState(0);

  const keep = async () => {
    if (!keeper || !canvas.current) return;
    setState('keeping');
    try {
      onChange(await keeper.keep(await pngOf(canvas.current)));
      kept.current = true;
      setSigning(false);
      setStrokes([]);
      setTyped(null);
      setState('idle');
    } catch {
      setState('failed');
    }
  };

  const picture = value !== null && value !== '' && typeof value !== 'boolean' ? keeper?.picture(value) : undefined;
  if (!signing && value !== null && value !== '' && keeper)
    return (
      <span className="signature-input">
        {picture ? (
          <img className="signature-input-kept" src={picture} alt={say('keptSignature', { label })} />
        ) : (
          <span className="signature-input-kept is-unseen">{say('signatureKept')}</span>
        )}
        <span className="signature-input-tools">
          <Button ref={again} intent="quiet" disabled={disabled} onClick={() => setSigning(true)}>
            {appWord('mistri.form.signAgain', say('signAgain'))}
          </Button>
          <Button intent="quiet" disabled={disabled} onClick={() => onChange(null)}>
            {say('removeSignature')}
          </Button>
        </span>
      </span>
    );
  return (
    <span className="signature-input" aria-describedby={describedBy}>
      {typed === null ? (
        <canvas
          id={id}
          ref={canvas}
          className="signature-input-pad"
          /* Focusable by the pointer, not by Tab: a press on the pad keeps the focus inside the field, so a form that
             closes its editor when the focus leaves keeps it open while a signature is drawn. Keyboards type instead. */
          tabIndex={-1}
          role="img"
          aria-label={say('signHere', { label })}
          aria-invalid={invalid || undefined}
          onPointerDown={(event) => {
            if (disabled) return;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            drawing.current = [at(event)];
            redraw((n) => n + 1);
          }}
          onPointerMove={(event) => {
            if (!drawing.current) return;
            drawing.current.push(at(event));
            redraw((n) => n + 1);
          }}
          onPointerUp={() => {
            // Taken before it is let go: the update runs after this handler has cleared it.
            const done = drawing.current;
            drawing.current = null;
            if (done) setStrokes((all) => [...all, done]);
          }}
          onPointerCancel={() => {
            drawing.current = null;
            redraw((n) => n + 1);
          }}
        />
      ) : (
        <>
          <input
            id={id}
            type="text"
            className="signature-input-name"
            value={typed}
            autoComplete="name"
            placeholder={say('typeYourName')}
            aria-label={say('typedSignature', { label })}
            aria-invalid={invalid || undefined}
            disabled={disabled}
            onChange={(event) => setTyped(event.target.value)}
          />
          <canvas ref={canvas} className="signature-input-pad" aria-hidden="true" />
        </>
      )}
      <span className="signature-input-tools">
        {typed === null && (
          <>
            <Button intent="quiet" disabled={disabled || !strokes.length} onClick={() => setStrokes((all) => all.slice(0, -1))}>
              {say('undoStroke')}
            </Button>
            <Button intent="quiet" disabled={disabled || !strokes.length} onClick={() => setStrokes([])}>
              {say('clearSignature')}
            </Button>
          </>
        )}
        <Button intent="quiet" disabled={disabled} onClick={() => setTyped(typed === null ? '' : null)}>
          {say(typed === null ? 'typeInstead' : 'drawInstead')}
        </Button>
        <Button className="signature-input-keep" disabled={disabled || empty || !keeper || state === 'keeping'} onClick={() => void keep()}>
          {say(state === 'keeping' ? 'keepingSignature' : 'useSignature')}
        </Button>
        {value !== null && value !== '' && (
          <Button intent="quiet" onClick={() => setSigning(false)}>
            {say('keepPrevious')}
          </Button>
        )}
      </span>
      {state === 'failed' && (
        <span className="signature-input-problem" role="alert">
          {say('signatureUnread')}
        </span>
      )}
    </span>
  );
}

const INPUTS: Record<string, ComponentType<InputProps>> = {
  json: JsonInput,
  scan: ScanInput,
  signature: SignatureInput,
  rating: RatingInput,
  slider: SliderInput,
  color: ColorInput,
  time: nativeInput('time'),
  month: nativeInput('month'),
  year: nativeInput('year'),
};

/** The platform's input for a display format, by name; null for a name it has none for, so the plain box stays. */
export function builtInInput(name: string): ComponentType<InputProps> | null {
  return Object.hasOwn(INPUTS, name) ? INPUTS[name] : null;
}

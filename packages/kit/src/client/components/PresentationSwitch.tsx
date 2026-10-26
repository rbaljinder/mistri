/**
 * How the same rows are read on a phone — as records or as the table — as a
 * two-icon segmented control at the row's end, not a second row of tabs
 * under the list's own view tabs (which it matched word for word and
 * underline for underline). The names stay on the buttons for a screen reader.
 */
export function PresentationSwitch({
  layout,
  onChange,
  label,
  records,
  table,
}: {
  layout: string;
  onChange: (mode: string) => void;
  label: string;
  records: string;
  table: string;
}) {
  return (
    <div className="record-presentation" role="group" aria-label={label}>
      {(['records', 'table'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className="presentation-seg"
          aria-pressed={layout === mode}
          aria-label={mode === 'records' ? records : table}
          title={mode === 'records' ? records : table}
          onClick={() => onChange(mode)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
            {mode === 'records' ? (
              <path d="M2 4h12M2 8h12M2 12h12" />
            ) : (
              <>
                <rect x="2" y="3" width="12" height="10" rx="1" />
                <path d="M2 7h12M6.5 3v10" />
              </>
            )}
          </svg>
        </button>
      ))}
    </div>
  );
}

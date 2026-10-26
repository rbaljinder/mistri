/**
 * Pay history: every payroll run's pay period on a month axis, its pay date a
 * tick under it and the run this page is about marked in the accent. On a
 * phone the same runs are a list, newest first, each with its stage.
 *
 * It only draws. The rows are the section's declared read (payHistory in
 * features/payroll.ts), planned and authorized by the server like any list;
 * a run opens as a peek through the platform's own navigation. Colours are
 * tokens, so every look and both modes dress it; nothing moves.
 */
import { Button, Empty, Stack, Value, useFormat, useNavigate, useSectionSize, type SectionProps } from '@mistriwork/mistri/ui';
import type { Rows } from '../mistri-schema.d.ts';
import type { payHistory } from '../features/payroll.ts';
import './PayrollTimeline.css';

type Props = SectionProps<typeof payHistory, Rows, 'pay_run'>;
type Run = Props['rows']['runs'][number];

const DAY = 86_400_000;
/** A date column's value as a day number; dates arrive as 'YYYY-MM-DD' (or a timestamp that starts with one). */
const day = (value: unknown): number => Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`) / DAY;

/** The first of each month from `from` to `to`, as day numbers, for the axis. */
function monthsBetween(from: number, to: number): number[] {
  const start = new Date(from * DAY);
  const months: number[] = [];
  for (
    let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    d.getTime() / DAY <= to;
    d.setUTCMonth(d.getUTCMonth() + 1)
  ) {
    months.push(d.getTime() / DAY);
  }
  return months;
}

function RunList({ runs, current, open }: { runs: readonly Run[]; current: unknown; open: (run: Run) => void }) {
  const format = useFormat();
  return (
    <Stack as="ol" gap="tight" className="c-payroll-timeline-list">
      {runs.map((run) => (
        <li key={String(run.id)} className="c-payroll-timeline-item" aria-current={run.id === current ? 'true' : undefined}>
          <Button intent="quiet" className="c-payroll-timeline-open" onClick={() => open(run)}>
            {run.title}
          </Button>
          <span className="c-payroll-timeline-dates">
            {format.date(run.period_start)} – {format.date(run.period_end)} · paid {format.date(run.pay_date)}
          </span>
          <span className="c-payroll-timeline-stage">
            <Value value={run.status} resource="pay_run" column="status" compact />
          </span>
        </li>
      ))}
    </Stack>
  );
}

export default function PayrollTimeline({ record, rows, props }: Props) {
  const { compact } = useSectionSize();
  const { openRecord } = useNavigate();
  const format = useFormat();
  const current = record?.id;
  /* Newest first as read; the axis runs oldest to newest, over the last `months` months of pay dates. */
  const latest = rows.runs.length ? Math.max(...rows.runs.map((run) => day(run.pay_date))) : 0;
  const since = latest - props.months * 30.44;
  const runs = rows.runs.filter((run) => day(run.pay_date) >= since);
  if (!runs.length) return <Empty title="No payroll runs to place yet." />;
  const open = (run: Run) => openRecord('pay_run', { id: run.id }, { mode: 'drawer', label: String(run.title) });
  if (compact) return <RunList runs={runs} current={current} open={open} />;

  const start = Math.min(...runs.map((run) => day(run.period_start)));
  const end = Math.max(...runs.map((run) => day(run.pay_date)));
  const span = Math.max(end - start, 1);
  const at = (d: number) => `${(((d - start) / span) * 100).toFixed(3)}%`;
  const width = (from: number, to: number) => `${(((to - from + 1) / span) * 100).toFixed(3)}%`;
  const ordered = [...runs].reverse();
  return (
    <div className="c-payroll-timeline">
      <ol className="c-payroll-timeline-rule" aria-label="Payroll runs by pay period">
        {ordered.map((run) => {
          const from = day(run.period_start);
          const to = day(run.period_end);
          const said = `${run.title}: ${format.date(run.period_start)} to ${format.date(run.period_end)}, paid ${format.date(run.pay_date)}`;
          return (
            <li
              key={String(run.id)}
              className="c-payroll-timeline-run"
              data-status={String(run.status)}
              aria-current={run.id === current ? 'true' : undefined}
            >
              <button
                type="button"
                className="c-payroll-timeline-period"
                style={{ left: at(from), width: width(from, to) }}
                title={said}
                aria-label={said}
                onClick={() => open(run)}
              />
              <span className="c-payroll-timeline-paid" style={{ left: at(day(run.pay_date)) }} aria-hidden="true" />
            </li>
          );
        })}
      </ol>
      <div className="c-payroll-timeline-axis" aria-hidden="true">
        {/* A month whose label would not fit before the end is left unsaid rather than cut. */}
        {monthsBetween(start, end)
          .filter((month) => month >= start && (month - start) / span < 0.95)
          .map((month) => (
            <span key={month} className="c-payroll-timeline-month" style={{ left: at(month) }}>
              {new Date(month * DAY).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })}
            </span>
          ))}
      </div>
      <p className="c-payroll-timeline-caption">
        {runs.length} runs · bars are pay periods, ticks are pay dates{current !== undefined ? ' · this run in the accent' : ''}
      </p>
    </div>
  );
}

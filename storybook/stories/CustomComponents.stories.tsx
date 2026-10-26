import type { Meta, StoryObj } from '@storybook/react-vite';
import { FixtureSection, fixtures } from '../../packages/mistri/src/client/components/sdk/fixture.js';
import '../../packages/mistri/src/client/components/sdk/kit.css';
import PayrollTimeline from '../../test/fixtures/apps/payday/widgets/PayrollTimeline.js';
import { payHistory } from '../../test/fixtures/apps/payday/features/payroll.js';

/* An App's own component, drawn by the SDK's fixture host as its tests draw
   it: Payday's pay history, on a desk and as the list a phone gets, so the
   visual matrix sees a custom component in every look, light and dark. */
const meta = { title: 'Custom components', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;

const run = (id: number, title: string, start: string, end: string, paid: string, status: string) => ({
  id,
  title,
  period_start: start,
  period_end: end,
  pay_date: paid,
  status,
});
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September'];
const pad = (n: number) => String(n).padStart(2, '0');
const runs = months
  .flatMap((month, i) => {
    const m = i + 1;
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    const status = m < 8 ? 'paid' : m === 8 ? 'approved' : 'review';
    return [
      run(i * 2 + 1, `${month} 1–15 payroll`, `2026-${pad(m)}-01`, `2026-${pad(m)}-15`, `2026-${pad(m)}-18`, status),
      run(
        i * 2 + 2,
        `${month} 16–${last} payroll`,
        `2026-${pad(m)}-16`,
        `2026-${pad(m)}-${last}`,
        `2026-${pad(m + 1)}-04`,
        m === 9 ? 'draft' : status,
      ),
    ];
  })
  .reverse();
const data = fixtures(
  { pay_run: runs },
  { display: { 'pay_run.status': { tone: { draft: 'neutral', review: 'warn', approved: 'good', paid: 'info' } } } },
);
const record = { id: 17, title: 'September 1–15 payroll' };

function Section({ width }: { width: number }) {
  return (
    <section className="page-section" style={{ maxWidth: width }}>
      <h2 className="page-section-title">Pay history</h2>
      <FixtureSection component={PayrollTimeline} declaration={payHistory} options={{ data, record, width }} />
    </section>
  );
}

export const PayHistory: StoryObj = { render: () => <Section width={720} /> };
export const PayHistoryPhone: StoryObj = { render: () => <Section width={360} /> };

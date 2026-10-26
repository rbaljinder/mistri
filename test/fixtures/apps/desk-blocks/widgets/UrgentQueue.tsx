/**
 * The urgent tickets still open, as the desk's dashboard places them: each a line that opens the ticket, under the
 * window the reader picked. It only draws; the read is the placement's (urgentNow in app.ts), narrowed by the window.
 */
import './UrgentQueue.css';
import { Empty, useNavigate, type SectionProps } from '@mistriwork/mistri/ui';
import type { urgentNow } from '../app.ts';
import type { Rows } from '../mistri-schema.d.ts';

export default function UrgentQueue({ rows, period, section }: SectionProps<typeof urgentNow, Rows>) {
  const navigate = useNavigate();
  const said = period ? `Opened ${period}` : 'Opened any time';
  if (!rows.urgent.length) return <Empty title="Nothing urgent" description={said} />;
  return (
    <div data-region={section.region}>
      <p className="c-urgent-queue-period">{said}</p>
      <ul className="c-urgent-queue-list">
        {rows.urgent.map((ticket) => (
          <li key={ticket.id}>
            <button type="button" onClick={() => navigate.openRecord('ticket', { id: ticket.id }, { label: ticket.name })}>
              {ticket.name}
            </button>
            <span>{ticket.requester}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

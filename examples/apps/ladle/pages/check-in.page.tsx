/**
 * The door on a class night: pick the class, see who is still expected, and check each party in as it arrives.
 *
 * A free-form page — this file is the whole room, at /check-in?class=2. It declares what it reads (the classes and
 * their bookings) and the one command it runs (checkIn, commands.ts); the hooks below read and run only those, and
 * the server holds every request to the reader's grants as it does any list's. Where a platform block says it, the
 * page draws the block (Metric, Rows); the guest list with its Check in buttons is the page's own.
 */
import type { ReactNode } from 'react';
import { Button, Card, definePage, Empty, Grid, Metric, Panel, Row, Rows, Stack } from '@mistriwork/mistri/page';
import { useFormat, useState } from '@mistriwork/mistri/ui';

const page = definePage({
  label: 'Check-in',
  description: 'Tonight’s guests at the door: check each party in as it arrives.',
  icon: 'check-circle',
  nav: { position: 0 },
  reads: ['class_session', 'booking'],
  commands: ['checkIn'],
  params: ['class'],
  component: CheckIn,
});
export default page;

/** The classes still to come, soonest first: what the door chooses between. */
function Classes({ chosen, onChoose }: { chosen: string | undefined; onChoose: (id: string) => void }): ReactNode {
  const format = useFormat();
  const classes = page.useRows('class_session', { query: 'upcoming', show: ['id', 'title', 'starts_at'], sort: 'starts_at', limit: 4 });
  if (classes.isPending) return <p role="status">Reading the schedule…</p>;
  if (!classes.data?.length) return <Empty title="No classes coming up" description="Add one under Classes." />;
  return (
    <Row gap="tight">
      {classes.data.map((lesson) => (
        <Button
          key={String(lesson.id)}
          intent={String(lesson.id) === chosen ? 'primary' : 'secondary'}
          aria-pressed={String(lesson.id) === chosen}
          onClick={() => onChoose(String(lesson.id))}
        >
          {String(lesson.title)} · {format.dateTime(String(lesson.starts_at))}
        </Button>
      ))}
    </Row>
  );
}

/** The parties still expected for one class, each with its Check in. */
function Door({ classId }: { classId: string }): ReactNode {
  const checkIn = page.useCommand('checkIn');
  const [said, setSaid] = useState('');
  const expected = page.useRows('booking', {
    query: `class_session_id = ${Number(classId)} and status = booked`,
    show: ['id', 'guest_name', 'party_size', 'status'],
    sort: 'guest_name',
    limit: 100,
  });
  return (
    <Stack gap="tight">
      {said ? <p role="status">{said}</p> : null}
      {expected.isPending ? (
        <p role="status">Reading the guest list…</p>
      ) : !expected.data?.length ? (
        <Empty title="Everyone is in" description="No party booked for this class is still expected." />
      ) : (
        <Stack as="ul" gap="tight">
          {expected.data.map((booking) => (
            <li key={String(booking.id)}>
              <Row align="center">
                <span>
                  <strong>{String(booking.guest_name)}</strong>
                  {Number(booking.party_size) > 1 ? ` · party of ${String(booking.party_size)}` : ''}
                </span>
                {/* A reader who may not run the command (one granted reads alone) sees the list and no button. */}
                {checkIn.granted && (
                  <Button
                    intent="primary"
                    size="compact"
                    busy={checkIn.pending(booking)}
                    busyLabel="Checking in…"
                    disabled={checkIn.available(booking) === false}
                    aria-label={`Check in ${String(booking.guest_name)}`}
                    onClick={() => {
                      void checkIn.run(booking, {}, { label: String(booking.guest_name) }).then((outcome) => {
                        if (outcome.status === 'applied') setSaid(`${String(booking.guest_name)} is checked in.`);
                      });
                    }}
                  >
                    {checkIn.label}
                  </Button>
                )}
              </Row>
            </li>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function CheckIn(): ReactNode {
  const [chosen, choose] = page.useParam('class');
  const id = chosen !== undefined && /^\d+$/.test(chosen) ? chosen : undefined;
  const ofClass = `class_session_id = ${Number(id)}`;
  return (
    <Stack gap="section">
      <Classes chosen={id} onChoose={(next) => choose(next, { push: true })} />
      {id === undefined ? (
        <Card>
          <Empty title="Choose a class" description="Its guest list opens here, with a Check in for each party." />
        </Card>
      ) : (
        <Grid>
          {/* The platform's blocks, each reading one of the page's declared resources. */}
          <Metric title="Seats booked" from="booking" query={`${ofClass} and status != cancelled`} measure="sum party_size" width="third" />
          <Metric title="Arrived" from="booking" query={`${ofClass} and status = checked_in`} measure="sum party_size" width="third" />
          <Metric title="Still expected" from="booking" query={`${ofClass} and status = booked`} measure="sum party_size" width="third" />
          <Panel title="At the door" width="half">
            <Door classId={id} />
          </Panel>
          <Rows
            title="Arrived"
            from="booking"
            query={`${ofClass} and status = checked_in`}
            show={['guest_name', 'party_size', 'checked_in_at']}
            sort="checked_in_at desc"
            width="half"
          />
        </Grid>
      )}
    </Stack>
  );
}

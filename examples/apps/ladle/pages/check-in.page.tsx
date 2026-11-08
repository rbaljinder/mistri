/**
 * The door on a class night: pick the class, see who is still expected, check each party in. A free-form page at
 * /check-in?class=2: it reads the classes and bookings it declares and runs only checkIn (commands.ts), under the
 * reader's grants. Choose keeps the class in the address; one Scope says "this class's bookings" once for every block in it.
 */
import type { ReactNode } from 'react';
import {
  Card,
  Choose,
  CommandButton,
  definePage,
  Empty,
  Grid,
  List,
  Metric,
  Panel,
  Row,
  Rows,
  Scope,
  Stack,
  useFormat,
} from '@mistriwork/mistri/page';

const page = definePage({
  label: 'Check-in',
  description: 'Tonight’s guests at the door: check each party in as it arrives.',
  icon: 'check-circle',
  nav: { position: 0 },
  reads: ['class_session', 'booking'],
  commands: ['checkIn'],
  params: { class: 'id' },
  component: CheckIn,
});
export default page;

function CheckIn(): ReactNode {
  const format = useFormat();
  const [chosen] = page.useParam('class');
  return (
    <Stack gap="section">
      <Choose
        param="class"
        from="class_session"
        query="upcoming"
        sort="starts_at"
        limit={4}
        label={(lesson) => `${lesson.title} · ${format.dateTime(lesson.starts_at)}`}
        empty={<Empty title="No classes coming up" description="Add one under Classes." />}
      />
      {chosen === undefined ? (
        <Card>
          <Empty title="Choose a class" description="Its guest list opens here, with a Check in for each party." />
        </Card>
      ) : (
        <Scope from="booking" where={{ class_session_id: chosen }}>
          <Grid>
            <Metric title="Seats booked" where={{ status: { not: 'cancelled' } }} measure="sum party_size" width="third" />
            <Metric title="Arrived" where={{ status: 'checked_in' }} measure="sum party_size" width="third" />
            <Metric title="Still expected" where={{ status: 'booked' }} measure="sum party_size" width="third" />
            <Panel title="At the door" width="half">
              <List
                where={{ status: 'booked' }}
                show={['guest_name', 'party_size']}
                sort="guest_name"
                limit={100}
                label="Still expected"
                empty={<Empty title="Everyone is in" description="No party booked for this class is still expected." />}
              >
                {(booking) => (
                  <Row align="center">
                    <span>
                      <strong>{booking.guest_name}</strong>
                      {booking.party_size > 1 ? ` · party of ${booking.party_size}` : ''}
                    </span>
                    <CommandButton command="checkIn" row={booking} size="compact" done={`${booking.guest_name} is checked in.`} />
                  </Row>
                )}
              </List>
            </Panel>
            <Rows
              title="Arrived"
              where={{ status: 'checked_in' }}
              show={['guest_name', 'party_size', 'checked_in_at']}
              sort="checked_in_at desc"
              width="half"
            />
          </Grid>
        </Scope>
      )}
    </Stack>
  );
}

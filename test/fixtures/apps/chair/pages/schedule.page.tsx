/* The schedule, one page for both roles. Every reader gets the visits and the follow-up asks (the loader's, read above
   the desk). The dentist also gets each visit's note; that read is optional, so the desk opens the same page and is
   told `refused` for it, with nothing asked of the server. */
import { definePage, EmptyState, Stack, Text, type PageProps } from '@mistriwork/mistri/page';
import type { ReactNode } from 'react';

const page = definePage({
  label: 'Schedule',
  nav: { position: 1 },
  roles: ['dentist', 'desk'],
  reads: ['visit'],
  optionalReads: ['note'],
  loader: 'followUps',
  component: Schedule,
});
export default page;

function Schedule({ data }: PageProps<'schedule'>): ReactNode {
  const visits = page.useRows('visit', { show: ['patient'], sort: 'id' });
  const notes = page.useRows('note', { show: ['visit_id', 'body'], optional: true });
  if (!visits.data?.length) return <EmptyState title="No visits today" />;
  return (
    <Stack>
      {visits.data.map((visit) => (
        <Stack key={String(visit.id)}>
          <Text>{String(visit.patient)}</Text>
          {data.followUps
            .filter((each) => each.visit === visit.id)
            .map((each) => (
              <Text key={String(each.ask)} muted>
                Follow up: {String(each.ask)}
              </Text>
            ))}
          {notes.refused
            ? null
            : notes.data
                ?.filter((note) => note.visit_id === visit.id)
                .map((note) => <Text key={String(note.id)}>{String(note.body)}</Text>)}
        </Stack>
      ))}
    </Stack>
  );
}

import {
  Timeline,
  TimelineConnector,
  TimelineDescription,
  TimelineItem,
  TimelineMarker,
  TimelineTime,
  TimelineTitle,
} from '@ui-sdk/react/timeline';

export type ActivityEvent = { id: string; title: string; dateTime: string; time: string; description?: string };

export function Activity({ label, events }: { label: string; events: ActivityEvent[] }) {
  return (
    <Timeline aria-label={label} data-kind="activity">
      {events.map((event) => (
        <TimelineItem key={event.id}>
          <TimelineMarker />
          <TimelineConnector />
          <TimelineTitle>{event.title}</TimelineTitle>
          <TimelineTime dateTime={event.dateTime}>{event.time}</TimelineTime>
          {event.description && <TimelineDescription>{event.description}</TimelineDescription>}
        </TimelineItem>
      ))}
    </Timeline>
  );
}

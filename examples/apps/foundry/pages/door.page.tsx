import type { ReactNode } from 'react';
import { msg } from '@mistriwork/mistri/app';
import {
  Beside,
  ButtonLink,
  Cluster,
  definePage,
  Eyebrow,
  Heading,
  MediaCard,
  Row,
  Stack,
  Text,
  useFormat,
  useHref,
  useMessage,
  Value,
} from '@mistriwork/mistri/page';

const page = definePage({
  label: msg('door.label'),
  description: msg('door.description'),
  public: true,
  head: false,
  reads: ['listing', 'listing_photo'],
  component: DoorPage,
});
export default page;

const CATEGORIES = ['Cameras', 'Furniture', 'Audio', 'Lighting'] as const;

function DoorPage(): ReactNode {
  const fmt = useFormat();
  const href = useHref();
  const { data } = page.useRows('listing', {
    query: 'status = live',
    show: ['id', 'title', 'maker', 'category', 'year_made', 'condition', 'city', 'price_cents', 'was_price_cents'],
    sort: 'id asc',
    limit: 6,
  });
  const rows = data ?? [];
  const lead = rows[0];

  const eyebrow = useMessage('door.eyebrow');
  const headline = useMessage('door.headline');
  const leadCopy = useMessage('door.lead');
  const exploreLabel = useMessage('door.explore');
  const sellLabel = useMessage('door.sell');
  const browseByCategory = useMessage('door.browseByCategory');
  const freshEyebrow = useMessage('door.freshEyebrow');
  const freshHeading = useMessage('door.freshHeading');
  const filterAll = useMessage('door.filterAll', { count: rows.length });
  const leadMonthly = useMessage('door.monthlyEstimate', {
    amount: lead ? fmt.money(Math.round(lead.price_cents / 12), { minor: true, round: true }) : '',
  });

  return (
    <Stack gap="section">
      <Beside
        railWidth="32rem"
        gap="section"
        stackBelow="60rem"
        rail={
          lead ? (
            <MediaCard
              href={href.page('item', { id: String(lead.id) })}
              media={lead.cover}
              alt={lead.title}
              aspect="3/2"
              badge={lead.condition}
              eyebrow={`${lead.maker} · ${lead.year_made}`}
              title={lead.title}
              value={<Value resource="listing" column="price_cents" value={lead.price_cents} row={lead} />}
              note={leadMonthly}
              meta={lead.city}
              priority
            />
          ) : null
        }
      >
        <Stack gap="field" justify="center">
          <Eyebrow>{eyebrow}</Eyebrow>
          <Heading level={1}>{headline}</Heading>
          <Text muted>{leadCopy}</Text>
          <Row gap="field">
            <ButtonLink href={href.page('browse')} variant="primary">
              {exploreLabel}
            </ButtonLink>
            <ButtonLink href="/form/consign" variant="secondary">
              {sellLabel}
            </ButtonLink>
          </Row>
          <Row gap="tight" ariaLabel={browseByCategory}>
            {CATEGORIES.map((cat) => (
              <ButtonLink key={cat} href={href.page('browse', { q: `category = "${cat}"` })} variant="secondary" size="sm">
                {cat}
              </ButtonLink>
            ))}
          </Row>
        </Stack>
      </Beside>

      <Stack gap="field">
        <Row justify="between" align="end">
          <Stack gap="tight">
            <Eyebrow>{freshEyebrow}</Eyebrow>
            <Heading level={2} size="xl">
              {freshHeading}
            </Heading>
          </Stack>
          <ButtonLink href={href.page('browse')} variant="ghost" size="sm">
            {filterAll}
          </ButtonLink>
        </Row>

        <Cluster min="19rem" gap="section">
          {rows.map((row) => (
            <MediaCard
              key={row.id}
              href={href.page('item', { id: String(row.id) })}
              media={row.cover}
              alt={row.title}
              aspect="3/2"
              badge={row.category}
              eyebrow={`${row.maker} · ${row.year_made}`}
              title={row.title}
              value={<Value resource="listing" column="price_cents" value={row.price_cents} row={row} />}
              was={
                row.was_price_cents ? (
                  <Value resource="listing" column="was_price_cents" value={row.was_price_cents} row={row} />
                ) : undefined
              }
              meta={row.city}
            />
          ))}
        </Cluster>
      </Stack>
    </Stack>
  );
}

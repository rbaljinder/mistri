import type { ReactNode } from 'react';
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
  useRows,
  Value,
} from '@mistriwork/mistri/page';

const page = definePage({
  label: 'Foundry Market',
  description: 'Curated vintage optics, analog audio, and mid-century design from independent workshops.',
  public: true,
  head: false,
  reads: ['listing', 'listing_photo'],
  component: DoorPage,
});
export default page;

interface ListingRow extends Record<string, unknown> {
  id: number;
  title: string;
  maker: string;
  category: string;
  year_made: number;
  condition: string;
  city: string;
  price_cents: number;
  was_price_cents: number | null;
  cover?: string | null;
}

const CATEGORIES = ['Cameras', 'Furniture', 'Audio', 'Lighting'] as const;

function DoorPage(): ReactNode {
  const fmt = useFormat();
  const href = useHref();
  const { data } = useRows('listing', {
    query: 'status = live',
    show: ['id', 'title', 'maker', 'category', 'year_made', 'condition', 'city', 'price_cents', 'was_price_cents'],
    sort: 'id asc',
    limit: 6,
  });
  const rows = (data ?? []) as unknown as ListingRow[];
  const lead = rows[0];

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
              note={`or ${fmt.money(Math.round(lead.price_cents / 12), { minor: true, round: true })}/mo`}
              meta={lead.city}
              priority
            />
          ) : null
        }
      >
        <Stack gap="field" justify="center">
          <Eyebrow>Verified independent workshops · Pacific Northwest & California</Eyebrow>
          <Heading level={1}>Objects built to outlast every room they enter.</Heading>
          <Text muted>
            Serviced rangefinders, restored Scandinavian seating, and bench-tested hi-fi. Every piece is photographed in studio,
            authenticated by its specialist, and held atomically the moment you claim it.
          </Text>
          <Row gap="field">
            <ButtonLink href={href.page('browse')} variant="primary">
              Explore the collection
            </ButtonLink>
            <ButtonLink href="/form/consign" variant="secondary">
              Sell a piece
            </ButtonLink>
          </Row>
          <Row gap="tight" ariaLabel="Browse by category">
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
            <Eyebrow>Fresh from the bench</Eyebrow>
            <Heading level={2} size="xl">
              Available on Foundry now
            </Heading>
          </Stack>
          <ButtonLink href={href.page('browse')} variant="ghost" size="sm">
            Filter all {rows.length} pieces →
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

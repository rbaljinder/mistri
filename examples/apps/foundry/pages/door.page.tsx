import type { ReactNode } from 'react';
import {
  Badge,
  Beside,
  Card,
  Cluster,
  definePage,
  Heading,
  Row,
  Stack,
  Text,
  useFormat,
  useHref,
  useRows,
  Value,
} from '@mistriwork/mistri/page';
import './door.page.css';

const page = definePage({
  label: 'Foundry Market',
  description: 'Curated vintage optics, analog audio, and mid-century design from independent workshops.',
  public: true,
  head: false,
  reads: ['listing'],
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
    <Stack gap="section" className="c-page-door-wrap">
      <Beside
        railWidth="32rem"
        gap="section"
        stackBelow="60rem"
        rail={
          lead ? (
            <a href={href.page('item', { id: String(lead.id) })} className="c-page-door-link">
              <Card flush interactive>
                <div className="c-page-door-media">
                  {lead.cover ? <img src={lead.cover} alt={lead.title} className="c-page-door-img" /> : null}
                </div>
                <Card.Body>
                  <Row justify="between" align="baseline" gap="field">
                    <Stack gap="tight">
                      <Text size="sm" muted>
                        {lead.maker} · {lead.year_made}
                      </Text>
                      <Heading level={3}>{lead.title}</Heading>
                    </Stack>
                    <Stack gap="tight" align="end">
                      <strong className="c-page-door-price">
                        <Value resource="listing" column="price_cents" value={lead.price_cents} row={lead} />
                      </strong>
                      <Text size="sm" muted>
                        or {fmt.money(Math.round(lead.price_cents / 12), { minor: true, round: true })}/mo
                      </Text>
                    </Stack>
                  </Row>
                </Card.Body>
              </Card>
            </a>
          ) : null
        }
      >
        <Stack gap="field" className="c-page-door-hero">
          <Badge>Verified independent workshops · Pacific Northwest & California</Badge>
          <h1 className="c-page-door-title">Objects built to outlast every room they enter.</h1>
          <Text muted>
            Serviced rangefinders, restored Scandinavian seating, and bench-tested hi-fi. Every piece is photographed in studio,
            authenticated by its specialist, and held atomically the moment you claim it.
          </Text>
          <Row gap="field">
            <a href={href.page('browse')} className="c-page-door-cta">
              Explore the collection
            </a>
            <a href="/form/consign" className="c-page-door-ghost">
              Sell a piece
            </a>
          </Row>
          <Row gap="tight" ariaLabel="Browse by category">
            {CATEGORIES.map((cat) => (
              <a key={cat} href={href.page('browse', { q: `category = "${cat}"` })} className="c-page-door-link">
                <Badge pill>{cat}</Badge>
              </a>
            ))}
          </Row>
        </Stack>
      </Beside>

      <Stack gap="field">
        <Row justify="between" align="baseline">
          <Stack gap="tight">
            <Badge>Fresh from the bench</Badge>
            <Heading level={2}>Available on Foundry now</Heading>
          </Stack>
          <a href={href.page('browse')} className="c-page-door-more">
            Filter all {rows.length} pieces →
          </a>
        </Row>

        <Cluster min="19rem" gap="section">
          {rows.map((row) => (
            <a key={row.id} href={href.page('item', { id: String(row.id) })} className="c-page-door-link">
              <Card flush interactive>
                <div className="c-page-door-media">
                  {row.cover ? <img src={row.cover} alt={row.title} className="c-page-door-img" loading="lazy" /> : null}
                </div>
                <Card.Body>
                  <Stack gap="tight">
                    <Row justify="between" align="center">
                      <Text size="sm" muted>
                        {row.maker} · {row.year_made}
                      </Text>
                      <Badge pill>{row.category}</Badge>
                    </Row>
                    <Heading level={4}>{row.title}</Heading>
                    <Row justify="between" align="baseline">
                      <Row gap="tight" align="baseline">
                        <strong className="c-page-door-price">
                          <Value resource="listing" column="price_cents" value={row.price_cents} row={row} />
                        </strong>
                        {row.was_price_cents ? (
                          <span className="c-page-door-was">
                            <Value resource="listing" column="was_price_cents" value={row.was_price_cents} row={row} />
                          </span>
                        ) : null}
                      </Row>
                      <Text size="sm" muted>
                        {row.city}
                      </Text>
                    </Row>
                  </Stack>
                </Card.Body>
              </Card>
            </a>
          ))}
        </Cluster>
      </Stack>
    </Stack>
  );
}

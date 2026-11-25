import type { ReactNode } from 'react';
import {
  Badge,
  Card,
  Cluster,
  definePage,
  EmptyState,
  Heading,
  ListFilters,
  Loaded,
  Row,
  Stack,
  Text,
  useFormat,
  useHref,
  useRows,
  Value,
} from '@mistriwork/mistri/page';
import './browse.page.css';

const page = definePage({
  label: 'Collection',
  description: 'Filter curated vintage optics, mid-century furniture, audio, and lighting.',
  public: true,
  head: false,
  reads: ['listing'],
  params: { q: 'text' },
  component: BrowsePage,
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

function BrowsePage(): ReactNode {
  const fmt = useFormat();
  const href = useHref();

  return (
    <Stack gap="section" className="c-page-browse-wrap">
      <Stack gap="tight">
        <Badge>Foundry collection</Badge>
        <Heading level={2}>Browse curated pieces</Heading>
      </Stack>

      <ListFilters
        from="listing"
        standing="status = live"
        param="q"
        filters={['category', 'condition', 'city', 'price_cents']}
        sorts={[
          { label: 'Price: Low to High', sort: 'price_cents asc' },
          { label: 'Price: High to Low', sort: 'price_cents desc' },
          { label: 'Year: Oldest First', sort: 'year_made asc' },
        ]}
        sort="price_cents asc"
      >
        {({ query, sort }) => <CollectionGrid query={query} sort={sort} fmt={fmt} href={href} />}
      </ListFilters>
    </Stack>
  );
}

function CollectionGrid({
  query,
  sort,
  fmt,
  href,
}: {
  query: string | undefined;
  sort: string | undefined;
  fmt: ReturnType<typeof useFormat>;
  href: ReturnType<typeof useHref>;
}): ReactNode {
  const result = useRows('listing', {
    query,
    show: ['id', 'title', 'maker', 'category', 'year_made', 'condition', 'city', 'price_cents', 'was_price_cents'],
    sort: sort ?? 'price_cents asc',
    limit: 24,
  });
  const rows = (result.data ?? []) as unknown as ListingRow[];

  return (
    <Stack gap="field">
      <Text size="sm" muted>
        Showing <strong>{rows.length}</strong> available {rows.length === 1 ? 'piece' : 'pieces'}
      </Text>
      <Loaded query={result} empty={<EmptyState title="No pieces match" description="Try clearing a filter or broadening your search." />}>
        {() => (
          <Cluster min="18rem" gap="field">
            {rows.map((row) => (
              <a key={row.id} href={href.page('item', { id: String(row.id) })} className="c-page-browse-link">
                <Card flush interactive>
                  <div className="c-page-browse-media">
                    {row.cover ? <img src={row.cover} alt={row.title} className="c-page-browse-img" loading="lazy" /> : null}
                  </div>
                  <Card.Body>
                    <Stack gap="tight">
                      <Row justify="between" align="center">
                        <Text size="sm" muted>
                          {row.maker} · {row.year_made}
                        </Text>
                        <Badge pill>{row.condition}</Badge>
                      </Row>
                      <Heading level={4}>{row.title}</Heading>
                      <Row justify="between" align="baseline">
                        <Row gap="tight" align="baseline">
                          <strong className="c-page-browse-price">
                            <Value resource="listing" column="price_cents" value={row.price_cents} row={row} />
                          </strong>
                          <Text size="sm" muted>
                            {fmt.money(Math.round(row.price_cents / 12), { minor: true, round: true })}/mo
                          </Text>
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
        )}
      </Loaded>
    </Stack>
  );
}

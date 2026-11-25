import type { ReactNode } from 'react';
import {
  Cluster,
  definePage,
  EmptyState,
  Eyebrow,
  Heading,
  ListFilters,
  Loaded,
  MediaCard,
  Stack,
  Text,
  useFormat,
  useHref,
  useRows,
  Value,
} from '@mistriwork/mistri/page';

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
    <Stack gap="section">
      <Stack gap="tight">
        <Eyebrow>Foundry collection</Eyebrow>
        <Heading level={1} size="2xl">
          Browse curated pieces
        </Heading>
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
              <MediaCard
                key={row.id}
                href={href.page('item', { id: String(row.id) })}
                media={row.cover}
                alt={row.title}
                aspect="3/2"
                badge={row.condition}
                eyebrow={`${row.maker} · ${row.year_made} · ${row.category}`}
                title={row.title}
                value={<Value resource="listing" column="price_cents" value={row.price_cents} row={row} />}
                note={`${fmt.money(Math.round(row.price_cents / 12), { minor: true, round: true })}/mo`}
                meta={row.city}
              />
            ))}
          </Cluster>
        )}
      </Loaded>
    </Stack>
  );
}

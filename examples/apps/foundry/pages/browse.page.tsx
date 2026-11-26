import type { ReactNode } from 'react';
import { msg } from '@mistriwork/mistri/app';
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
  useMessage,
  Value,
} from '@mistriwork/mistri/page';

const page = definePage({
  label: msg('browse.label'),
  description: msg('browse.description'),
  public: true,
  head: false,
  reads: ['listing', 'listing_photo'],
  params: { q: 'text' },
  component: BrowsePage,
});
export default page;

function BrowsePage(): ReactNode {
  const fmt = useFormat();
  const href = useHref();
  const eyebrow = useMessage('browse.eyebrow');
  const heading = useMessage('browse.heading');
  const sortPriceAsc = useMessage('browse.sortPriceAsc');
  const sortPriceDesc = useMessage('browse.sortPriceDesc');
  const sortYearAsc = useMessage('browse.sortYearAsc');

  return (
    <Stack gap="section">
      <Stack gap="tight">
        <Eyebrow>{eyebrow}</Eyebrow>
        <Heading level={1} size="2xl">
          {heading}
        </Heading>
      </Stack>

      <ListFilters
        from="listing"
        standing="status = live"
        param="q"
        filters={['category', 'condition', 'city', 'price_cents']}
        sorts={[
          { label: sortPriceAsc, sort: 'price_cents asc' },
          { label: sortPriceDesc, sort: 'price_cents desc' },
          { label: sortYearAsc, sort: 'year_made asc' },
        ]}
        sort="price_cents asc"
      >
        {({ query, sort }) => <CollectionGrid query={query} sort={sort} fmt={fmt} href={href} />}
      </ListFilters>
    </Stack>
  );
}

function CollectionCard({
  row,
  fmt,
  href,
}: {
  row: {
    readonly id: number;
    readonly title: string;
    readonly maker: string;
    readonly category: string;
    readonly year_made: number;
    readonly condition: string;
    readonly city: string;
    readonly price_cents: number;
    readonly cover?: string | null;
  };
  fmt: ReturnType<typeof useFormat>;
  href: ReturnType<typeof useHref>;
}): ReactNode {
  const monthlyNote = useMessage('browse.monthly', {
    amount: fmt.money(Math.round(row.price_cents / 12), { minor: true, round: true }),
  });
  return (
    <MediaCard
      href={href.page('item', { id: String(row.id) })}
      media={row.cover}
      alt={row.title}
      aspect="3/2"
      badge={row.condition}
      eyebrow={`${row.maker} · ${row.year_made} · ${row.category}`}
      title={row.title}
      value={<Value resource="listing" column="price_cents" value={row.price_cents} row={row} />}
      note={monthlyNote}
      meta={row.city}
    />
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
  const result = page.useRows('listing', {
    query,
    show: ['id', 'title', 'maker', 'category', 'year_made', 'condition', 'city', 'price_cents', 'was_price_cents'],
    sort: sort ?? 'price_cents asc',
    limit: 24,
  });
  const rows = result.data ?? [];
  const showingCount = useMessage('browse.showingCount', { count: rows.length });
  const emptyTitle = useMessage('browse.emptyTitle');
  const emptyDescription = useMessage('browse.emptyDescription');

  return (
    <Stack gap="field">
      <Text size="sm" muted>
        {showingCount}
      </Text>
      <Loaded query={result} empty={<EmptyState title={emptyTitle} description={emptyDescription} />}>
        {() => (
          <Cluster min="18rem" gap="field">
            {rows.map((row) => (
              <CollectionCard key={row.id} row={row} fmt={fmt} href={href} />
            ))}
          </Cluster>
        )}
      </Loaded>
    </Stack>
  );
}

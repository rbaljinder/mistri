import { useState, type ReactNode } from 'react';
import {
  Badge,
  Beside,
  Button,
  Card,
  Cluster,
  CommandButton,
  definePage,
  DescriptionList,
  EmptyState,
  Heading,
  Loaded,
  Photos,
  Row,
  Stack,
  Text,
  TextField,
  useFormat,
  useHref,
  useRecord,
  useRows,
  Value,
} from '@mistriwork/mistri/page';
import './item.page.css';

const page = definePage({
  label: 'Listing',
  description: 'Studio photography, provenance, and instant atomic hold for a single piece.',
  public: true,
  head: false,
  reads: ['listing', 'listing_photo', 'seller'],
  commands: ['reserveListing'],
  params: { id: 'id' },
  component: ItemPage,
});
export default page;

interface ListingDetail extends Record<string, unknown> {
  id: number;
  title: string;
  maker: string;
  category: string;
  year_made: number;
  condition: string;
  city: string;
  price_cents: number;
  was_price_cents: number | null;
  status: string;
  seller_id: number;
  description: string;
  provenance: string;
  cover?: string | null;
}

interface SellerRow extends Record<string, unknown> {
  id: number;
  name: string;
  city: string;
  specialty: string;
  bio: string;
}

function ItemPage(): ReactNode {
  const [rawId] = page.useParam('id');
  const numericId = rawId !== undefined ? Number(String(rawId).split('-')[0]) : undefined;
  const [showHold, setShowHold] = useState(false);
  const [buyerName, setBuyerName] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const fmt = useFormat();
  const href = useHref();

  const itemQuery = useRecord('listing', numericId ? { id: numericId } : undefined, [
    'id',
    'title',
    'maker',
    'category',
    'year_made',
    'condition',
    'city',
    'price_cents',
    'was_price_cents',
    'status',
    'seller_id',
    'description',
    'provenance',
  ]);
  const item = itemQuery.data as unknown as ListingDetail | undefined;

  const sellerQuery = useRecord('seller', item?.seller_id ? { id: item.seller_id } : undefined, ['id', 'name', 'city', 'specialty', 'bio']);
  const seller = sellerQuery.data as unknown as SellerRow | undefined;

  const moreQuery = useRows('listing', {
    query: 'status = live',
    show: ['id', 'title', 'maker', 'price_cents', 'city'],
    sort: 'id asc',
    limit: 4,
    enabled: Boolean(item),
  });
  const more = ((moreQuery.data ?? []) as unknown as ListingDetail[]).filter((row) => row.id !== item?.id).slice(0, 3);

  return (
    <Stack gap="section" className="c-page-item-wrap">
      <Row gap="tight" ariaLabel="Breadcrumb">
        <a href={href.page('door')} className="c-page-item-crumb">
          Home
        </a>
        <Text as="span" size="sm" muted>
          /
        </Text>
        <a href={href.page('browse')} className="c-page-item-crumb">
          Collection
        </a>
        {item ? (
          <>
            <Text as="span" size="sm" muted>
              /
            </Text>
            <a href={href.page('browse', { q: `category = "${item.category}"` })} className="c-page-item-crumb">
              {item.category}
            </a>
          </>
        ) : null}
      </Row>

      <Loaded query={itemQuery} empty={<EmptyState title="Piece not found" description="This listing may have been removed or moved." />}>
        {() =>
          item ? (
            <Stack gap="section">
              <Beside
                railWidth="25rem"
                gap="section"
                stackBelow="56rem"
                rail={
                  <Card>
                    <Card.Body>
                      <Stack gap="field">
                        <Stack gap="tight">
                          <Badge>
                            {item.maker} · {item.year_made}
                          </Badge>
                          <Heading level={2}>{item.title}</Heading>
                        </Stack>

                        <Stack gap="tight">
                          <Row gap="tight" align="baseline">
                            <span className="c-page-item-price">
                              <Value resource="listing" column="price_cents" value={item.price_cents} row={item} />
                            </span>
                            {item.was_price_cents ? (
                              <span className="c-page-item-was">
                                <Value resource="listing" column="was_price_cents" value={item.was_price_cents} row={item} />
                              </span>
                            ) : null}
                          </Row>
                          <Text size="sm" muted>
                            Estimated {fmt.money(Math.round(item.price_cents / 12), { minor: true, round: true })}/mo over 12 months ·
                            Insured courier included
                          </Text>
                        </Stack>

                        {item.status === 'live' ? (
                          showHold ? (
                            <Card variant="subtle">
                              <Card.Body>
                                <Stack gap="field">
                                  <Row justify="between" align="center">
                                    <Heading level={4}>48-hour atomic hold</Heading>
                                    <Button variant="ghost" size="sm" onClick={() => setShowHold(false)}>
                                      Cancel
                                    </Button>
                                  </Row>
                                  <TextField
                                    label="Your full name"
                                    placeholder="Elena Vance"
                                    value={buyerName}
                                    onValueChange={setBuyerName}
                                  />
                                  <TextField
                                    label="Email address"
                                    type="email"
                                    placeholder="elena@studio.org"
                                    value={buyerEmail}
                                    onValueChange={setBuyerEmail}
                                  />
                                  <CommandButton
                                    command="reserveListing"
                                    row={item}
                                    values={{ buyer_name: buyerName, buyer_email: buyerEmail }}
                                    label="Confirm 48h hold"
                                    done="Piece reserved. Check your confirmation reference."
                                  />
                                  <Text size="sm" muted>
                                    Backed by atomic db.listing.claim() — commits only while this piece is still live.
                                  </Text>
                                </Stack>
                              </Card.Body>
                            </Card>
                          ) : (
                            <Button variant="primary" block onClick={() => setShowHold(true)}>
                              Reserve this piece (48h hold)
                            </Button>
                          )
                        ) : (
                          <Badge tone="warning">Currently {item.status} — no longer available for hold</Badge>
                        )}

                        <DescriptionList
                          resource="listing"
                          row={item}
                          fields={['condition', 'category', 'city', 'year_made']}
                          columns={2}
                        />

                        {seller ? (
                          <Card variant="subtle">
                            <Card.Body>
                              <Stack gap="tight">
                                <Text size="sm" muted>
                                  Authenticated workshop
                                </Text>
                                <Heading level={4}>{seller.name}</Heading>
                                <Text size="sm" muted>
                                  {seller.specialty} · {seller.city}
                                </Text>
                                <Text size="sm">{seller.bio}</Text>
                              </Stack>
                            </Card.Body>
                          </Card>
                        ) : null}
                      </Stack>
                    </Card.Body>
                  </Card>
                }
              >
                <Photos from="listing_photo" whose="listing_id" record={item} sort="position asc" aspect="3/2" caption="caption" />
              </Beside>

              <Cluster min="20rem" gap="section">
                <Card title="Curator notes">
                  <Card.Body>
                    <Text>{item.description}</Text>
                  </Card.Body>
                </Card>
                <Card title="Provenance & service">
                  <Card.Body>
                    <Text>{item.provenance}</Text>
                  </Card.Body>
                </Card>
              </Cluster>

              {more.length > 0 ? (
                <Stack gap="field">
                  <Heading level={3}>Also on Foundry</Heading>
                  <Cluster min="16rem" gap="field">
                    {more.map((other) => (
                      <a key={other.id} href={href.page('item', { id: String(other.id) })} className="c-page-item-link">
                        <Card flush interactive>
                          <div className="c-page-item-media">
                            {other.cover ? <img src={other.cover} alt={other.title} className="c-page-item-img" loading="lazy" /> : null}
                          </div>
                          <Card.Body>
                            <Stack gap="tight">
                              <Text size="sm" muted>
                                {other.maker} · {other.city}
                              </Text>
                              <Heading level={4}>{other.title}</Heading>
                              <strong>
                                <Value resource="listing" column="price_cents" value={other.price_cents} row={other} />
                              </strong>
                            </Stack>
                          </Card.Body>
                        </Card>
                      </a>
                    ))}
                  </Cluster>
                </Stack>
              ) : null}
            </Stack>
          ) : null
        }
      </Loaded>
    </Stack>
  );
}

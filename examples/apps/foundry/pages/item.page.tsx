import { useState, type ReactNode } from 'react';
import { msg } from '@mistriwork/mistri/app';
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
  Eyebrow,
  Figure,
  Heading,
  Loaded,
  MediaCard,
  Photos,
  Row,
  Stack,
  Text,
  TextField,
  useFormat,
  useHref,
  useMessage,
  Value,
} from '@mistriwork/mistri/page';

const page = definePage({
  label: msg('item.label'),
  description: msg('item.description'),
  public: true,
  head: false,
  reads: ['listing', 'listing_photo', 'seller'],
  commands: ['reserveListing'],
  params: { id: 'id' },
  component: ItemPage,
});
export default page;

function ItemPage(): ReactNode {
  const [rawId] = page.useParam('id');
  const numericId = rawId !== undefined ? Number(String(rawId).split('-')[0]) : undefined;
  const [showHold, setShowHold] = useState(false);
  const [buyerName, setBuyerName] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const fmt = useFormat();
  const href = useHref();

  const itemQuery = page.useRecord('listing', numericId ? { id: numericId } : undefined, [
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
  const item = itemQuery.data;

  const sellerQuery = page.useRecord('seller', item?.seller_id ? { id: item.seller_id } : undefined, [
    'id',
    'name',
    'city',
    'specialty',
    'bio',
  ]);
  const seller = sellerQuery.data;

  const moreQuery = page.useRows('listing', {
    query: 'status = live',
    show: ['id', 'title', 'maker', 'price_cents', 'city'],
    sort: 'id asc',
    limit: 4,
    enabled: Boolean(item),
  });
  const more = (moreQuery.data ?? []).filter((row) => row.id !== item?.id).slice(0, 3);

  const breadcrumbAria = useMessage('item.breadcrumbAria');
  const breadcrumbHome = useMessage('item.breadcrumbHome');
  const breadcrumbCollection = useMessage('item.breadcrumbCollection');
  const notFoundTitle = useMessage('item.notFoundTitle');
  const notFoundDescription = useMessage('item.notFoundDescription');
  const monthlyNote = useMessage('item.monthlyNote', {
    amount: item ? fmt.money(Math.round(item.price_cents / 12), { minor: true, round: true }) : '',
  });
  const holdTitle = useMessage('item.holdTitle');
  const cancelLabel = useMessage('item.cancel');
  const buyerNameLabel = useMessage('command.buyerName');
  const buyerNamePlaceholder = useMessage('item.buyerNamePlaceholder');
  const buyerEmailLabel = useMessage('command.buyerEmail');
  const buyerEmailPlaceholder = useMessage('item.buyerEmailPlaceholder');
  const confirmHoldLabel = useMessage('item.confirmHold');
  const holdDone = useMessage('item.holdDone');
  const holdGuarantee = useMessage('item.holdGuarantee');
  const reserveCta = useMessage('item.reserveCta');
  const unavailableStatus = useMessage('item.unavailableStatus', { status: item?.status ?? '' });
  const workshopEyebrow = useMessage('item.workshopEyebrow');
  const curatorNotesTitle = useMessage('item.curatorNotes');
  const provenanceTitle = useMessage('item.provenance');
  const alsoOnFoundry = useMessage('item.alsoOnFoundry');

  return (
    <Stack gap="section">
      <Row gap="tight" ariaLabel={breadcrumbAria}>
        <a href={href.page('door')}>{breadcrumbHome}</a>
        <Text as="span" size="sm" muted>
          /
        </Text>
        <a href={href.page('browse')}>{breadcrumbCollection}</a>
        {item ? (
          <>
            <Text as="span" size="sm" muted>
              /
            </Text>
            <a href={href.page('browse', { q: `category = "${item.category}"` })}>{item.category}</a>
          </>
        ) : null}
      </Row>

      <Loaded query={itemQuery} empty={<EmptyState title={notFoundTitle} description={notFoundDescription} />}>
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
                          <Eyebrow>
                            {item.maker} · {item.year_made}
                          </Eyebrow>
                          <Heading level={1} size="xl">
                            {item.title}
                          </Heading>
                        </Stack>

                        <Figure
                          size="xl"
                          value={<Value resource="listing" column="price_cents" value={item.price_cents} row={item} />}
                          was={
                            item.was_price_cents ? (
                              <Value resource="listing" column="was_price_cents" value={item.was_price_cents} row={item} />
                            ) : undefined
                          }
                          note={monthlyNote}
                        />

                        {item.status === 'live' ? (
                          showHold ? (
                            <Card variant="subtle">
                              <Card.Body>
                                <Stack gap="field">
                                  <Row justify="between" align="center">
                                    <Heading level={4}>{holdTitle}</Heading>
                                    <Button variant="ghost" size="sm" onClick={() => setShowHold(false)}>
                                      {cancelLabel}
                                    </Button>
                                  </Row>
                                  <TextField
                                    label={buyerNameLabel}
                                    placeholder={buyerNamePlaceholder}
                                    value={buyerName}
                                    onValueChange={setBuyerName}
                                  />
                                  <TextField
                                    label={buyerEmailLabel}
                                    type="email"
                                    placeholder={buyerEmailPlaceholder}
                                    value={buyerEmail}
                                    onValueChange={setBuyerEmail}
                                  />
                                  <CommandButton
                                    command="reserveListing"
                                    row={item}
                                    values={{ buyer_name: buyerName, buyer_email: buyerEmail }}
                                    label={confirmHoldLabel}
                                    variant="primary"
                                    done={holdDone}
                                  />
                                  <Text size="sm" muted>
                                    {holdGuarantee}
                                  </Text>
                                </Stack>
                              </Card.Body>
                            </Card>
                          ) : (
                            <Button variant="primary" block onClick={() => setShowHold(true)}>
                              {reserveCta}
                            </Button>
                          )
                        ) : (
                          <Badge tone="warning">{unavailableStatus}</Badge>
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
                                <Eyebrow>{workshopEyebrow}</Eyebrow>
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
                <Card title={curatorNotesTitle}>
                  <Card.Body>
                    <Text>{item.description}</Text>
                  </Card.Body>
                </Card>
                <Card title={provenanceTitle}>
                  <Card.Body>
                    <Text>{item.provenance}</Text>
                  </Card.Body>
                </Card>
              </Cluster>

              {more.length > 0 ? (
                <Stack gap="field">
                  <Heading level={2} size="xl">
                    {alsoOnFoundry}
                  </Heading>
                  <Cluster min="16rem" gap="field">
                    {more.map((other) => (
                      <MediaCard
                        key={other.id}
                        href={href.page('item', { id: String(other.id) })}
                        media={other.cover}
                        alt={other.title}
                        aspect="3/2"
                        eyebrow={`${other.maker} · ${other.city}`}
                        title={other.title}
                        value={<Value resource="listing" column="price_cents" value={other.price_cents} row={other} />}
                      />
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

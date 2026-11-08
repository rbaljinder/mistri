/**
 * The catalog as a shop window: every active product as a card led by its first photo, with its price, its SKU and
 * what is on hand, one category's or all of them (`?category=3`). A card opens the product's own page.
 *
 * A free-form page from blocks alone. The photos live in their own table (`product_photo`), so the gallery reads
 * `product` and names where the pictures are (`image: { from, whose, sort }`), as the Catalog list does, rather than a
 * column the product has no use for; a product with no photo keeps a plain card.
 */
import type { ReactNode } from 'react';
import { Choose, definePage, Gallery, Scope, Stack } from '@mistriwork/mistri/page';

const page = definePage({
  label: 'Photo gallery',
  description: 'Active products by their photos.',
  icon: 'image',
  nav: { group: 'inventory', position: 3 },
  /* `stock_movement` because on hand is drawn by the stock sparkline (`display: { on_hand }`), which reads the ledger. */
  reads: ['product', 'category', 'stock_movement'],
  params: { category: 'id' },
  component: ProductGallery,
});
export default page;

function ProductGallery(): ReactNode {
  const [category] = page.useParam('category');
  return (
    <Stack>
      <Choose param="category" name="Category" all="All categories" from="category" sort="name" label="name" />
      <Scope from="product" where={{ status: 'active', ...(category === undefined ? {} : { category_id: category }) }}>
        <Gallery
          image={{ from: 'product_photo', whose: 'product_id', sort: 'position' }}
          primary="name"
          value="list_price"
          facts={['sku', 'on_hand']}
          sort="name"
          limit={60}
          label="Products by photo"
        />
      </Scope>
    </Stack>
  );
}

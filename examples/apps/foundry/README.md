# Foundry Market

A curated vintage marketplace (cameras, mid-century furniture, analog hi-fi, and lighting) demonstrating Mistri's public custom-site capabilities alongside a staff curator desk in one App.

## What this sample demonstrates

- **Editorial `gallery` base theme with zero custom CSS**: `ui.theme: { preset: 'gallery', accent: '#a83c17' }` gives warm linen ground, lifted white tiles, book-serif display headlines, rounded controls, and accent primary CTAs. All three custom pages compose Mistri's own primitives (`MediaCard`, `ButtonLink`, `Eyebrow`, `Figure`, `Heading`, `Beside`, `Cluster`, `Stack`, `Row`, `Card`, `DescriptionList`, `TextField`, `Photos`, `ListFilters`, `Value`, `CommandButton`) with **0 lines of custom CSS** and **0 `mistri check --warnings` warnings**.
- **Public site shell (`ui.site`)**: signed-out visitors get a dedicated site header (brand mark, links, search box, primary CTA) and footer (`signIn: 'footer'`), completely separate from the signed-in curator desk's `nav`.
- **First-paint SSR for custom public pages**: `pages/door.page.tsx`, `pages/browse.page.tsx`, and `pages/item.page.tsx` declare `public: true` and `head: false`, arriving pre-rendered with photographs, formatted prices, and site chrome in the initial HTML response.
- **Cover photos on the row (`resources.listing.photos`)**: declaring `photos: { from: 'listing_photo', whose: 'listing_id', sort: 'position asc', aspect: '3/2' }` hydrates `row.cover` automatically on `useRows('listing')` and built-in card views.
- **Custom detail gallery (`<Photos>`)**: `pages/item.page.tsx` mounts `<Photos from="listing_photo" whose="listing_id" record={item} aspect="3/2" caption="caption" />` for a 3:2 lead frame, thumbnail strip, captions, and click-to-zoom lightbox.
- **Resource-driven formatting & rounding**: `<Value resource="listing" column="price_cents" row={item} />` and `useFormat().column(...)` reuse `resources.listing.display`, while `useFormat().money(..., { minor: true, round: true })` formats clean whole-dollar monthly estimates.
- **Server-backed filters on a custom page (`<ListFilters>`)**: `pages/browse.page.tsx` mounts Mistri's faceted `<ListFilters>` rail beside a custom card grid, synced with the URL and the header search bar.
- **Cards opening a custom page (`open: { page: 'item', param: 'id' }`)**: the built-in `catalog` cards view routes visitors straight to `pages/item.page.tsx` while keeping the record page for staff curators.
- **Atomic single-record claim & unified public machine verb**: `reserveListing` in `commands.ts` is declared once (`public: true, targets: 'one'`) and guards the `live -> reserved` transition atomically with `db.listing.claim()`.

## Run it

Seed a fresh SQLite database outside the app directory and start the server:

```sh
node examples/databases/foundry/seed.mjs /tmp/foundry.db
BETTER_AUTH_SECRET="foundry-dev-secret-at-least-32-bytes-long" \
MISTRI_FORM_KEY="foundry-dev-form-key" \
MISTRI_AUTH_ADMIN_EMAIL="curator@foundry.test" \
MISTRI_AUTH_ADMIN_PASSWORD="foundry-curator-password" \
npx mistri --config /tmp/foundry.db.json --app examples/apps/foundry
```

Open `/` for the public marketplace door, `/browse` for faceted search, `/item?id=1` for the Leica M3 studio gallery & 48-hour atomic hold, `/catalog` for built-in cards routing into `/item`, and `/sign-in` for the curator desk.

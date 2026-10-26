/** The marketplace's two cards, shared by every list that draws them: a car
 * (its lead photo, the price, the monthly figure, the facts in one line and
 * who sells it) and a rate (the program's APR from, what it lends and for
 * how long; its page says who it is for). Each consumer fetches the presentation's own fields. */
import { cards } from '@mistriwork/mistri/app';

/* The title is the model and the make rides on the photo as its chip: the
   schema has no one column that names a car, and a card's title is the row's
   own column, never its recordLabel ("2026 Subaru Ascent Limited"). */
export const vehicleCard = cards('model', {
  value: 'list_price',
  badge: 'make',
  facts: ['year', 'trim', 'mileage', 'est_payment'],
  properties: ['dealer_id.name', 'dealer_id.city'],
  image: { from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position' },
});

/** The same car on its own dealer's page, where saying who sells it and where would say it twice. */
export const lotCard = cards('model', {
  value: 'list_price',
  badge: 'make',
  facts: ['year', 'trim', 'mileage', 'est_payment'],
  image: { from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position' },
});

export const programCard = cards('name', {
  value: 'base_apr',
  badge: 'tier',
  facts: ['max_term', 'max_amount'],
});

export const dealerCard = cards('name', {
  value: 'for_sale',
  badge: 'kind',
  facts: ['city', 'state'],
  properties: ['street', 'phone'],
});

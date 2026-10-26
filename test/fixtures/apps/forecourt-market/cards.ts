import { cards } from '@mistriwork/mistri/app';

/* A car as the catalog, the front page, a dealer's page and Similar cars all
   draw it: its lead photo (the 320-pixel copy), the name, the price large,
   and one quiet line: the miles, the fuel and where it is (the year is in
   the name). Each list fetches the card's own fields, so no list keeps a
   parallel `show`. */
export const vehicleCard = cards('title', {
  value: 'price',
  badge: 'highlight',
  facts: ['mileage', 'fuel', 'dealer_id.city'],
  image: { from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position' },
});

/* A dealer: who, where, and how buyers rate them. */
export const dealerCard = cards('name', {
  value: 'rating',
  facts: ['city', { column: 'reviews', after: 'review' }],
  description: 'about',
});

/* A saved car, drawn as the car it is: every part of the card read through
   the saved row's reference to the vehicle, the photo found by that car. */
export const savedCard = cards('vehicle_id.title', {
  value: 'vehicle_id.price',
  facts: ['vehicle_id.mileage', 'vehicle_id.fuel', 'vehicle_id.year'],
  image: { about: 'vehicle_id', from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position' },
});

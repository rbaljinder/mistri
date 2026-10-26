import { cards } from '@mistriwork/mistri/app';

/* The one car card: the inventory, the front page's picks and similar cars.
   Its title is the model because a card's title must be one text column and
   the car's name ("2024 Ford Explorer ST-Line") is a label template, not a
   column; the year and trim lead the facts so the card still reads as the car. */
export const vehicleCard = cards('model', {
  value: 'list_price',
  badge: 'condition',
  facts: ['year', 'make', 'trim', 'mileage'],
  properties: ['est_payment'],
  image: { from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position' },
});

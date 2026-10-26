/** The vehicle card shared by catalog, landing, dealer and similar lists.
 * Each consumer fetches the presentation's fields; no parallel show list is needed. */
import { cards } from '@mistriwork/mistri/app';

export const vehicleCard = cards('title', {
  value: 'price',
  badge: 'highlight',
  facts: ['year', 'mileage', 'fuel', 'transmission'],
  properties: ['dealer_id.name', 'dealer_id.city'],
  image: { from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position' },
});

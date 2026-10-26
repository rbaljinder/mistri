import { fields, page, related } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';
import { homeCard } from '../views.ts';

/* A building, as a listing: its photos with its facts beside them, then its words and the homes in it to let now. */
export default page(
  'property',
  [
    related('Photos', 'property_photo', 'property_id', { presentation: 'gallery', sort: 'position', limit: 6 }),
    fields(['address', 'city', 'kind', 'year_built', 'homes'], { title: 'The building', region: 'aside' }),
    fields(['description'], { title: 'About the building' }),
    related('To let', 'unit', 'property_id', { query: 'advertised', sort: 'available_on', presentation: homeCard }),
  ],
  { layout: 'showcase', listTabs: false },
) satisfies Page;

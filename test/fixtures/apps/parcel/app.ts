import { defineApp } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { navigation } from './navigation.ts';
import { carrierPage } from './pages/carrier.ts';
import { shipmentPage } from './pages/shipment.ts';
import { resources } from './resources.ts';
import { views } from './views.ts';

/* Parcel reads a carrier network's tracking API, not a database. Its one
   source is an HTTP connection whose description was drafted from the API's
   OpenAPI spec (test/fixtures/apps/parcel/source), so its tables are the API's
   resources and every list asks the API only what that description says it
   can answer. It writes nothing: an HTTP connection is read-only. */
export default defineApp({
  id: 'parcel',
  name: 'Parcel',
  connection: 'parcel',
  resources,
  views,
  pages: { shipment: shipmentPage, carrier: carrierPage },
  home: 'shipments',
  nav: navigation,
  ui: {
    logo: 'package',
    theme: { preset: 'mono' },
    shell: { placement: 'side' },
    // Declared values are dollars, and dates read the American way.
    currency: 'USD',
    locale: 'en-US',
  },
} satisfies App);

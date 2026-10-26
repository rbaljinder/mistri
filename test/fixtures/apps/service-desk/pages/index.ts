import { assetPage } from './asset.ts';
import { catalogPage } from './catalog.ts';
import { changePage } from './change.ts';
import { incidentPage } from './incident.ts';
import { knowledgePage } from './knowledge.ts';
import { orderPage } from './order.ts';
import { problemPage } from './problem.ts';
import { requestPage } from './request.ts';
import { servicePage } from './service.ts';

/* Keyed by page id. */
export const pages = {
  asset: assetPage,
  'catalog-item': catalogPage,
  change: changePage,
  incident: incidentPage,
  knowledge: knowledgePage,
  order: orderPage,
  problem: problemPage,
  request: requestPage,
  service: servicePage,
};

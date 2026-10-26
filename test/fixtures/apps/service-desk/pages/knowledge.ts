import { fields, page } from '@mistriwork/mistri/app';

export const knowledgePage = page('knowledge_article', [
  fields(['name', 'status', 'service_id', 'author_id', 'reviewed_on'], { columns: 3 }),
  fields(['summary', 'body'], {
    columns: 1,
  }),
]);

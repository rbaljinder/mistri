import { fields, page, related } from '@mistriwork/mistri/app';

/* A thing's record page with two related lists and no word about `listTabs`: the page tab beside them joins their strip. */
export default page('thing', [
  fields(['name']),
  related('Parts', 'part', 'thing_id', { show: ['name'] }),
  related('Notes', 'note', 'thing_id', { show: ['body'] }),
]);

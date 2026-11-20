import { fields, page, related } from '@mistriwork/mistri/app';

/* A thing with its parts and notes as one strip of tabs. Anvil has both, Bellows neither. */
export default page(
  'thing',
  [fields(['name']), related('Parts', 'part', 'thing_id', { show: ['name'] }), related('Notes', 'note', 'thing_id', { show: ['body'] })],
  {
    listTabs: true,
  },
);

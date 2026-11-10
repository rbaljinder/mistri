/** A thing's chart, a record tab at /things/1/chart: it joins the strip of the record's related lists. */
import { definePage } from '@mistriwork/mistri/page';

const page = definePage({ label: 'Chart', reads: ['thing'], component: Chart });
export default page;

function Chart() {
  const thing = page.useRecordKey('thing');
  return <p>Chart of thing {String(thing.id)}</p>;
}

/** The same rows on a page that also brings the primitives' sheet (`/primitives`), whose own row rules meet the page
 * kit's on the one element: e2e/page-kit.spec.ts holds the two pages to the same drawing. */
import { ItemList, ItemRow, definePage } from '@mistriwork/mistri/page';
import { FormColumns } from '@mistriwork/mistri/primitives';

const page = definePage({ label: 'Rows with primitives', reads: ['thing'], component: Rows });
export default page;

function Rows() {
  return (
    <div style={{ inlineSize: '18rem' }}>
      <FormColumns columns={1}>
        <ItemList ariaLabel="Jobs">
          <ItemRow
            title="Replace the mechanical seal on the number two feed pump before the weekend shutdown window closes"
            description="Bay 4"
          />
          <ItemRow title="Chosen job" selected />
          <ItemRow title="Plain job" />
        </ItemList>
      </FormColumns>
    </div>
  );
}

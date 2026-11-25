/** Rows from the page kit alone, with no primitives sheet on the page: a long title in a narrow box, and a chosen row
 * (e2e/page-kit.spec.ts measures that the title wraps and the chosen row is dressed). */
import { ItemList, ItemRow, definePage } from '@mistriwork/mistri/page';

const page = definePage({ label: 'Rows', reads: ['thing'], component: Rows });
export default page;

function Rows() {
  return (
    <div style={{ inlineSize: '18rem' }}>
      <ItemList ariaLabel="Jobs">
        <ItemRow
          title="Replace the mechanical seal on the number two feed pump before the weekend shutdown window closes"
          description="Bay 4"
        />
        <ItemRow title="Chosen job" selected />
        <ItemRow title="Plain job" />
      </ItemList>
    </div>
  );
}

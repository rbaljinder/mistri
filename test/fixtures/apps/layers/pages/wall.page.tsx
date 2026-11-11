/** A bare page: its root owns the window, so e2e/page-layers.spec.ts holds its box to the viewport. */
import { definePage } from '@mistriwork/mistri/page';
import './wall.css';

const page = definePage({ label: 'Wall', layout: 'bare', reads: ['thing'], params: { brick: 'text' }, component: Wall });
export default page;

function Wall() {
  const [brick, setBrick] = page.useParam('brick');
  return (
    <div className="c-page-wall">
      The wall
      <button type="button" onClick={() => setBrick('red', { push: true })}>
        {brick ? `Brick ${brick}` : 'Lay a brick'}
      </button>
    </div>
  );
}

/** A bare page: its root owns the window, so e2e/page-layers.spec.ts holds its box to the viewport. */
import { definePage } from '@mistriwork/mistri/page';
import './wall.css';

const page = definePage({ label: 'Wall', layout: 'bare', reads: ['thing'], component: Wall });
export default page;

function Wall() {
  return <div className="c-page-wall">The wall</div>;
}

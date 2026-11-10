/** A page with no head: the first thing it draws is the first thing in the content pane (e2e/page-layers.spec.ts). */
import { definePage } from '@mistriwork/mistri/page';
import './hero.css';

const page = definePage({ label: 'Hero', head: false, reads: ['thing'], component: Hero });
export default page;

function Hero() {
  return <div className="c-page-hero">Its own hero</div>;
}

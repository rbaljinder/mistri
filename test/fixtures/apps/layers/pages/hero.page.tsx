/** A page with no head: the first thing it draws is the first thing in the content pane (e2e/page-layers.spec.ts). */
import { definePage, useNavigate } from '@mistriwork/mistri/page';
import './hero.css';

const page = definePage({ label: 'Hero', head: false, reads: ['thing'], component: Hero });
export default page;

function Hero() {
  const go = useNavigate();
  return (
    <div className="c-page-hero">
      Its own hero
      <button type="button" onClick={() => go.openPage('wall')}>
        Open the wall
      </button>
    </div>
  );
}

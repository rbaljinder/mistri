/**
 * The server render's addressMount (vite.config.ts `ssrAddressMount` puts it
 * in the page's one's place) answers every name the page's exports. A name
 * added to one and not its twin passes every test run from source, where no
 * swap happens, and fails only `npm run build`. (The embed's twins are held
 * the same way in packages/mistri/src/embed/seams/seams.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import * as served from '../../../../kit/src/client/addressMount.js';
import * as rendered from './addressMount.server.js';

describe('the server render’s addressMount', () => {
  it('render on the server with every name the page’s addressMount exports', () => {
    expect(Object.keys(rendered).sort()).toEqual(Object.keys(served).sort());
  });

  it('place nothing in a render: the page keeps a placement once who-am-I answers', () => {
    expect(rendered.arrivedPlacement()).toBeNull();
    expect(rendered.keepPlacement(true)).toBeNull();
    expect(rendered.shownUnplaced('/compass/leads/127')).toBe(rendered.shown('/compass/leads/127'));
  });
});

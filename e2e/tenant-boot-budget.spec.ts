import { test, expect, type Page } from './support/harness.js';
import { startTenantApp, type TenantAppFixture } from './support/tenantServer.js';

/*
 * What a tenant App's first page asks, and in how many rounds (mistri shared/tenantBoot.ts). Past who-am-I, the
 * member's tenants and the lease, the shell used to ask the runtime, then the App, its pages and its schema, then the
 * room's own reads, each round after the last had answered: on a remote database every round is a network's latency
 * and a context's admission. The page is now asked for in one read on the lease, and someone in one tenant is
 * entered with it in the same request as discovery (`/api/tenant/enter`), so a list or a record settles in two
 * rounds — who-am-I, then everything else — whatever the room asks. A change that brings a round back fails here, by
 * name.
 */
test.describe("a tenant App's first page", () => {
  test.setTimeout(60000);
  let app: TenantAppFixture;
  test.afterEach(async () => {
    await app?.stop();
  });

  /** Every API request the page asks until its room has drawn and a second has passed quiet, and the round each is in. */
  async function visit(page: Page, address: string, drawn: string) {
    const asked: Array<{ path: string; started: number; ended: number; wave: number }> = [];
    const open = new Map<object, { path: string; started: number }>();
    let flows: number | undefined;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) open.set(request, { path: url.pathname, started: Date.now() });
      /* The tenant's flows (vite.config.ts `surfaces`), as the built client names them. */
      if (/^\/assets\/tenant-[\w-]+\.js$/.test(url.pathname)) flows ??= Date.now();
    });
    const done = (request: object) => {
      const held = open.get(request);
      if (!held) return;
      open.delete(request);
      /* A request's round: one past the latest round any request had finished in before it was sent. */
      const wave = 1 + Math.max(0, ...asked.filter((other) => other.ended <= held.started).map((other) => other.wave));
      asked.push({ ...held, ended: Date.now(), wave });
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    await page.goto(address);
    await expect(page.locator('#content')).toContainText(drawn);
    let count = -1;
    while (count !== asked.length) {
      count = asked.length;
      await page.waitForTimeout(1000);
    }
    /* The live stream never finishes; it is the page's own, and asks nothing of the room. */
    return { asked: asked.filter((request) => request.path !== '/api/live').sort((a, b) => a.started - b.started), flows };
  }

  test('a list and a record each ask the page with the lease, in two rounds', async ({ page }) => {
    app = await startTenantApp({ writable: true, shell: true });
    const signed = await page.request.post(app.origin + '/api/auth/sign-in/email', {
      headers: { origin: app.origin },
      data: { email: app.accounts.bob.email, password: app.accounts.bob.password },
    });
    expect(signed.status()).toBe(200);
    await page.context().addInitScript(() => localStorage.setItem('mistri.tour', 'done'));

    for (const [address, drawn] of [
      [`/${app.appId}/items`, 'North item'],
      [`/${app.appId}/items/shared-1`, 'North item'],
    ] as const) {
      /* A tab of its own each time: a new tab opens its own lease, as a first visit does. */
      const tab = await page.context().newPage();
      const { asked, flows } = await visit(tab, app.origin + address, drawn);
      await tab.close();
      const paths = asked.map((request) => request.path);
      const said = `${address}:\n${asked.map((request) => `${request.wave} ${request.path}`).join('\n')}`;
      /* The page's reads come in its boot: none of them is asked alone. */
      for (const carried of [
        '/api/runtime',
        '/api/app',
        '/api/pages',
        '/api/schema',
        '/api/run',
        '/api/query',
        '/api/view/run',
        '/api/pages/compose',
        '/api/pages/suggested',
      ])
        expect(paths, said).not.toContain(carried);
      /* Who-am-I, then the member's tenants, the lease and the boot in one; never asked again apart. The bell's
         count the boot carries too, so it is not asked at all. */
      expect(paths, said).toEqual(['/api/whoami', '/api/tenant/enter']);
      expect(Math.max(...asked.map((request) => request.wave)), said).toBe(2);
      /* The tenant's flows are asked beside the entry (clientSurface.ts tenantPreloads), not once who-am-I has said
         the session is a tenant's: that was a round trip between who-am-I and entering. Built pages only — the
         source client under Vite names no chunks. */
      if (process.env.MISTRI_BUILT_CLIENT === '1') {
        const whoami = asked.find((request) => request.path === '/api/whoami')!;
        expect(flows, `${said}\ntenant flows not asked`).toBeDefined();
        expect(flows!, `${said}\ntenant flows asked at ${flows}, who-am-I answered at ${whoami.ended}`).toBeLessThanOrEqual(whoami.started);
      }
    }
  });
});

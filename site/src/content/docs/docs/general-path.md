---
title: The general path
description: Keep an App where it pays and your own code everywhere else — a page, a route and a React app of your own — in one project.
---

Keep an App where it pays and your own code everywhere else — a page, a route and a React app of your own — in one project.

```ts title="examples/apps/ladle/host/server.ts"
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (ours(url)) return void tw.node(req, res);
    if (url === '/schedule.json' || url.startsWith('/schedule.json?')) return schedule(req, res);
    vite.middlewares(req, res, async () => {
```

See it in the sample (`examples/apps/ladle/host/server.ts:62`): one Node server, three owners of its addresses.

Ladle, a cooking school, is all three in one small project, shipped with the
package (`examples/apps/ladle`). The App keeps the lists, records, commands
and access; your code keeps the rest, and the two meet only through public
entry points.

```text
/                 the school's site, its own design      (host/main.tsx)
/schedule.json    the school's JSON route                 (host/schedule.ts)
/staff/…          the App, inside the site's header       (@mistriwork/mistri/react)
/api/tw/…         the App's API, sign-in and files        (@mistriwork/mistri/handler)
```

## When to take it

- A public, branded site the App's look should not draw.
- A screen no declared view can shape: draw it as a free-form page.
- A route that is not a command: a JSON feed, a webhook another service calls.

Otherwise an App alone is less to keep: lists, record pages and forms are
drawn for you.

## The three seams

- **A free-form page inside the App.** `pages/check-in.page.tsx` declares what
  it reads and the one command it runs, and draws the App's `Metric` and
  `Rows` blocks beside its own React ([free-form pages](/docs/custom-components/#free-form-pages)).
- **A route of your own beside the App.** `host/server.ts` hands `/api/tw` to
  `createHandler` from `@mistriwork/mistri/handler` and answers `/schedule.json`
  itself, from the same database with its own driver
  ([mount in your server](/docs/mount-in-your-server/)).
- **The App inside your React app.** `host/main.tsx` is the school's site;
  under `/staff` it renders `<App app="ladle" basePath="/staff" />`
  inside `<Provider endpoint="/api/tw">` from `@mistriwork/mistri/react`
  ([embed in a React app](/docs/embed-in-a-react-app/)).

Staff sign in to the App inside the site. A host that already knows who is
signed in passes that on instead ([sign in from your app](/docs/embed-sign-in/)).

## Run it

```sh
cp -r node_modules/@mistriwork/mistri/examples/apps/ladle ./ladle
LADLE_APP=./ladle node node_modules/@mistriwork/mistri/examples/databases/ladle/seed.mjs ./ladle.db
npm install vite @vitejs/plugin-react react react-dom tsx
npx tsx ladle/host/server.ts ./ladle.db.json 4620
```

`/` is the public schedule and `/staff` the App. Ladle's README has the
source-checkout recipe.

## Related

- [Custom components](/docs/custom-components/): free-form pages, their reads, commands and loaders.
- [Mount in your server](/docs/mount-in-your-server/): the handler under Node, Express, Next or Hono.
- [Embed in a React app](/docs/embed-in-a-react-app/): the App under your router.
- [Sign in from your app](/docs/embed-sign-in/): one sign-in for your app and the App.

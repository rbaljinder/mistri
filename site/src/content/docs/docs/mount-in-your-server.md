---
title: Mount an App in your server
description: Serve an App under a path of your own Node, Express, Next or Hono server, in its process, with no second port.
---

Serve an App under a path of your own Node, Express, Next or Hono server, in
its process, with no second port.

```ts title="examples/apps/ladle/host/server.ts"
  const tw = createHandler({ config: options.config, basePath: MOUNT, publicOrigin: origin, app: resolve(HERE, '..') });
  // …
    if (ours(url)) return void tw.node(req, res);
```

See it in the sample (`examples/apps/ladle/host/server.ts:48`): Ladle hands `/api/tw` to the App in the school's own Node server.

The options: `config` is the file `--config` reads (connections, and `apps`
or `app`); `basePath` is where your server hands requests over;
`publicOrigin` is the origin people's browsers use.

With `basePath: '/crm'`, everything under `/crm` is the App: its pages, its API, its sign-in and its
files. It is served exactly as `npx @mistriwork/mistri --config ./mistri.json
--base-path /crm` would serve it behind a proxy, so cookies carry
`Path=/crm`, links in mail and the App's addresses are said under `/crm`,
and the Host and Origin checks expect `publicOrigin`.

## Node

```ts
import { createServer } from 'node:http';

createServer((req, res) => {
  if (req.url?.startsWith('/crm')) return tw.node(req, res);
  res.end('your own pages');
}).listen(3000);
```

## Express

```ts
app.use('/crm', tw.node); // before express.json() or any other body parser
```

The handler reads its own request bodies, so mount it ahead of a body parser;
a request a parser has already read is refused with a message that says so.
Mounted without a path (`app.use(tw.node)`), it passes anything outside
`basePath` to `next()`.

## Next.js

```ts
// app/crm/[[...path]]/route.ts
import { createHandler, type Handler } from '@mistriwork/mistri/handler';

export const runtime = 'nodejs';
const shared = globalThis as { mistri?: Handler };
// One handler per process: development reloads this module.
const tw = (shared.mistri ??= createHandler({
  config: './mistri.json',
  basePath: '/crm',
  publicOrigin: process.env.PUBLIC_ORIGIN!,
}));
const handle = (request: Request) => tw.fetch(request);
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
```

## Hono

```ts
app.all('/crm/*', (c) => tw.fetch(c.req.raw));
```

## The visitor's address

Pass the visitor's address as `fetch`'s second argument:
`tw.fetch(request, { clientAddress })`. Sign-in's rate limit and lockout,
and a public form's, count by it; without it every visitor is one address
and shares one budget, and the handler warns once. On Hono over Node it is
`getConnInfo(c).remote.address` (`@hono/node-server/conninfo`); behind a
proxy, the address your proxy vouches for. `tw.node` reads it from the
socket.

## Pages on other origins

```ts
createHandler({ ...options, embed: { origins: ['https://shop.example.com'] } });
```

A page on a listed origin may call the App (CORS, answered for that origin
alone) and frame it: `/crm/?embed=frame` lets the listed origins put the App
in an iframe, where every other page is refused one. Cookies never cross
origins: a listed page signs its person in with an
[embed assertion](/docs/embed-sign-in/), and writes only with the token that
gives it.

## Starting and stopping

- `tw.ready` settles once the App, sign-in and pools are loaded. Requests
  that arrive sooner wait for it; past ten seconds they are answered 503
  with `Retry-After`. A startup that fails rejects `ready` and every request
  is answered 503 with the reason.
- `await tw.close()` on shutdown stops the App's jobs, waits for requests in
  flight and closes its pools and sign-in store.
- `app`, `commands`, `policy` and `jobs` name the files the command line's
  `--app`, `--commands`, `--policy` and `--jobs` would. With `jobs`, the
  App's jobs run in your process and stop on `close()`; without it, run them
  in a `mistri --jobs` process of their own. A tenant App is mounted with
  `app` and `policy`, as it is started, and takes its embed origins from the
  config file.
- A `basePath` that says one of the server's own paths (`/api`, `/assets`,
  `/_mistri`, `/healthz`, `/readyz`) is refused; under your API, as
  `/api/tw`, is fine.
- A config that serves no App is refused: the database browser is not
  mountable, because its connection form trusts whoever reaches it.
- Bun and Deno are not supported: the SQLite driver, the pools and the App
  loader are Node's.

## Related

- [Build and deploy](/docs/build-and-deploy/): a build mounts the same way; name it with `app`.
- [Several Apps in one server](/docs/suites/): a config with several Apps behind one handler.
- [The general path](/docs/general-path/): the handler beside a route of your own, and the App in your React app.
- [Embed in a React app](/docs/embed-in-a-react-app/): draw the mounted App inside your own routes.

---
title: Installable PWAs
description: Make one App installable with ui.pwa — its manifest, worker, icons and offline page — and what offline does and does not mean.
---

An App opts into being an installable PWA with one key:

```ts
ui: { pwa: true }
```

**Preview.** It works as documented and may change in any 1.x release.
`mistri check` lists it among the App's Preview features.

## What an opted-in App serves

Nothing is written to disk and nothing joins the first-paint bundle. The
server generates, per App, from its name and its look's grounds:

| Address | What it is |
| --- | --- |
| `/{app}/manifest.webmanifest` | The name, the start URL and scope (the App's home), the look's light ground as `background_color` and `theme_color`, and two PNG icons (`192x192` and `512x512`, `any maskable`). |
| `/{app}/sw.js` | The service worker, with the App's offline page in it. |
| `/{app}/pwa/register.js` | The page's registration, run on load. |
| `/{app}/pwa/icon-192.png`, `/{app}/pwa/icon-512.png` | The painted icons: the look's dark ground as a rounded square on its light ground, with a light disc. |

An opted-in App's pages carry the manifest link and the registration
script in the head. An App that did not opt in serves none of this: its
manifest and worker addresses answer 404, never the shell page, so a
browser never mistakes a page for a manifest.

The icons are painted, not the App's logo: a logo is a wide mark for a
bar, not a square for a home screen, and no square mark is declared. The
mark is geometric so it is recognizably the App's look without pretending
to be its brand.

## What the worker does

- **Navigations are network-first.** A page load goes to the network, and
  only a failed fetch falls back to the offline page. A navigation is
  never cached: a shell page carries its reader's first paint, and a cached
  one could show one reader's page to the next.
- **Same-scope static files are cache-first.** A file fetched once is
  served from the cache next time. (An App mounted under its id keeps its
  hashed client assets outside the worker's scope, where the server's
  year-long immutable cache already covers them.)
- **Nothing else is cached.** No `/api/` request, no POST, no PWA file of
  its own — App data never sits in the worker's cache.
- **Updates retire the old shell.** A new worker takes over at once and
  drops the previous cache, so a theme change — which rewrites the worker
  itself — retires the old icons and offline page with it.

Registration never breaks the page: when the browser has no worker support
or registration fails, the registration script fails silently.

## Mounts

A worker's scope is its script's directory. An App mounted under its id
owns exactly its own addresses. An App mounted at the root owns the whole
base path, so a reader who installed it and then opens a sibling App on
the same origin while offline sees this App's offline page for that
sibling's failed navigation — network-first, so only when the network is
already down, and no App data is involved either way.

## What offline does not mean

Installable plus shell-offline, not offline data. With no connection, the
App opens to its offline page; its lists, records and writes need the
network, as they always did, and no sync queue is kept. The offline page
says exactly that, so nobody mistakes an installed icon for an offline
App.

## See also

- [Status & roadmap](/docs/status/): PWA stays Preview at 1.0.
- [The App DSL: ui](/docs/dsl-ui/): the `ui.pwa` key.

---
title: Embed in a React app
description: Show a mistri App, or one of its lists, records or dashboards, inside your own React app's routes, under your router.
---

Show a mistri App, or one of its lists, records or dashboards, inside your
own React app's routes, under your router.

```tsx title="examples/apps/ladle/host/main.tsx"
        <Provider endpoint="/api/tw" onTitle={(title) => (document.title = `${title} · Ladle Cooking School`)}>
          <App app="ladle" basePath={STAFF} fallback={<p className="site-quiet">Opening the staff desk…</p>} />
        </Provider>
```

See it in the sample (`examples/apps/ladle/host/main.tsx:115`): the school's site draws the staff App under its own header. Both come from `@mistriwork/mistri/react`.

The `endpoint` is the mistri server: the handler
[mounted in your server](/docs/mount-in-your-server/) with
`basePath: '/api/tw'`, or a mistri process your server rewrites `/api/tw`
to. `basePath` is where your app shows the App: `/staff/bookings/12` is booking 12.
Your router owns the address bar, so Back, Forward and your own links move
the App too.

[The general path](/docs/general-path/) puts this beside a route and a
design of your own, in one sample App.

## React Router

```tsx
import { useReactRouterNavigator } from '@mistriwork/mistri/react/react-router';

function Staff() {
  return (
    <Provider endpoint="/api/tw" navigator={useReactRouterNavigator()}>
      <App app="ladle" basePath="/staff" />
    </Provider>
  );
}
// <Route path="/staff/*" element={<Staff />} />
```

## TanStack Router

```tsx
import { useTanStackNavigator } from '@mistriwork/mistri/react/tanstack-router';

const staff = createRoute({ getParentRoute: () => root, path: '/staff/$', component: Staff });
function Staff() {
  return (
    <Provider endpoint="/api/tw" navigator={useTanStackNavigator()}>
      <App app="ladle" basePath="/staff" />
    </Provider>
  );
}
```

## Next.js

```tsx
// app/staff/[[...rest]]/page.tsx
'use client';
import { useNextNavigator } from '@mistriwork/mistri/react/next';

export default function Staff() {
  return (
    <Provider endpoint="/api/tw" navigator={useNextNavigator()}>
      <App app="ladle" basePath="/staff" />
    </Provider>
  );
}
```

## Another router

```tsx
import { routerNavigator } from '@mistriwork/mistri/react';

const navigator = routerNavigator({
  read: () => ({ pathname: router.pathname, search: router.search, state: router.state }),
  push: (href, entry) => router.push(href, entry),
  replace: (href, entry) => router.replace(href, { ...router.state, ...entry }),
});
router.subscribe(() => navigator.hostMoved()); // on every move: the App's own are told apart
```

Pass it as the Provider's `navigator`. `entry` is the App's walk, which rides in the entry's state beside your
router's own; hand it back as it is. With no router, the Provider uses `window.history`
(`browserNavigator()`).

On the server every element renders an empty slot (or its `fallback`); the
App loads in the browser the first time an element is on screen.

## One list, record or dashboard

```tsx
<List app="ladle" view="bookings" tab="expected" onOpenRecord={(booking) => openDrawer(booking.key)} />
<Record app="ladle" resource="booking" id={12} />
<Dashboard app="lintel" view="today" period="last-30-days" />
<Page app="ladle" page="check-in" params={{ class: '2' }} />
```

A surface has no App chrome and keeps its own address, so your address bar
does not change. `Page` draws one of the App's
[free-form pages](/docs/custom-components/#free-form-pages) by its path. `onOpenRecord` hands you the record a list opens; without
it, the record opens in place. A page shows one mistri element at a time.

## Sign-in

With `auth` left out, the App uses mistri's own session cookie. To sign
people in with your app's session instead, mint an assertion on your server
and hand it over:

```tsx
<Provider
  endpoint="/api/tw"
  auth={{ assertion: () => fetch('/my/mistri-assertion').then((r) => r.text()) }}
>
```

On the same origin the exchange sets the session cookie. On another origin
the session is a token kept in memory, and is renewed before it lapses; the
server must list your page's origin (`embed.origins` on the
[handler](/docs/mount-in-your-server/#pages-on-other-origins)).

Before it draws, the Provider asks the server once: the sign-in comes back
with the first page's data in it, so the App starts on one request.

## The assistant

```tsx
<Assistant app="ladle" conversation={id} />
```

The App's assistant as a page of your app, under the same Provider.

## Styles

You import no CSS. mistri's styles are scoped to its own elements, in one
cascade layer named `mistri`, so they never reach your page. Your styles
in cascade layers (a reset, Tailwind's `base`) do not reach the App. Your
unlayered element rules (`button { … }`) still do; put them in a layer.
`theme`, `mode` and `density` on the Provider choose the look. `theme` is a
look's name, or your own made with `defineTheme`:

```tsx
import { defineTheme } from '@mistriwork/mistri/app';

const harbor = defineTheme({ id: 'harbor', label: 'Harbor', extends: 'mono', colors: { light: { accent: '#0b6e4f' } } });
<Provider endpoint="/api/tw" theme={harbor}>
```

## Related

- [Mount in your server](/docs/mount-in-your-server/): the handler the `endpoint` names.
- [The general path](/docs/general-path/): Ladle's site, route and App in one project.
- [Sign in from your app](/docs/embed-sign-in/): the assertion your server mints.
- [Themes and branding](/docs/themes/): `defineTheme` for the Provider's `theme`.

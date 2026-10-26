# Ladle

A cooking school in Chicago: evening and weekend classes, a public schedule on
the school's own website, and a staff desk where the front desk keeps bookings
and checks guests in at the door.

Ladle is the general path: a mistri App where it pays, and the school's own
code everywhere else. It shows the three seams in one small project:

1. **A free-form page.** [`pages/check-in.page.tsx`](pages/check-in.page.tsx)
   is a room drawn whole by the App's own React, beside two ordinary declared
   lists (Classes and Bookings, in [`app.ts`](app.ts)). It declares what it
   reads and the one command it runs (`checkIn`, in
   [`commands.ts`](commands.ts)), draws the platform's `Metric` and `Rows`
   blocks beside its own guest list, and keeps the chosen class in its
   address (`/check-in?class=2`).
2. **A server module of the host's own.** [`host/schedule.ts`](host/schedule.ts)
   answers `GET /schedule.json`, the classes still to come and the seats left,
   from the same database with Node's own SQLite driver. It is not a mistri
   command; it is mounted beside `createHandler` (`@mistriwork/mistri/handler`)
   in the school's one Node `http` server, [`host/server.ts`](host/server.ts).
3. **A host React app with its own design.** [`host/main.tsx`](host/main.tsx)
   and [`host/site.css`](host/site.css) are the school's site: its own header,
   serif and tomato red, plain CSS. Under `/staff` it embeds the App with
   `<Provider>` and `<App>` (`@mistriwork/mistri/react`). The site's
   header and the strip under it are the host's; everything inside the frame
   below is the App, in its own look, its styles scoped to its own elements.

```text
/                 the school's page, its schedule from /schedule.json   (host)
/schedule.json    the school's JSON route                                (host)
/staff/…          the Ladle App inside the school's header              (@mistriwork/mistri/react)
/api/tw/…         the App's API, sign-in and files                       (@mistriwork/mistri/handler)
```

The App's id is `ladle` and its connection `ladle`. Staff sign in to the App
itself, inside the site, with mistri's session cookie under `/api/tw`. A
host that already knows who is at the desk signs them in with an
[embed assertion](../../../site/src/content/docs/docs/embed-sign-in.md)
instead.

## Run it

From the repository root, with Node 24+ and dependencies installed. The seed
makes a new SQLite file, a config naming it `ladle`, and the stores the App
uses; the schedule is counted from today in Chicago (`LADLE_TODAY=YYYY-MM-DD`
pins it).

```sh
DIR=$(mktemp -d /tmp/ladle.XXXXXX)
node examples/databases/ladle/seed.mjs "$DIR/ladle.db"
npx tsx packages/mistri/src/server/index.ts check --config "$DIR/ladle.db.json" --app examples/apps/ladle
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
export MISTRI_AUTH_ADMIN_EMAIL=admin@example.test MISTRI_AUTH_ADMIN_PASSWORD=choose-a-long-password
```

The App on its own, as any App is served:

```sh
npx tsx packages/mistri/src/server/index.ts --config "$DIR/ladle.db.json" --app examples/apps/ladle
```

The school's site, with the App inside it. `@mistriwork/mistri/react` is a built
library, so a checkout builds it once (`npm run build`); an installed package
already holds it.

```sh
npm run build
npx tsx examples/apps/ladle/host/server.ts "$DIR/ladle.db.json" 4620
```

Open `http://127.0.0.1:4620/` for the public schedule, and Staff desk to sign
in with the admin account.

From an installed package, copy the App out of `node_modules` first (Node does
not run TypeScript from there), name the copy for the seed with
`LADLE_APP=./ladle`, and add the host's own dependencies:
`npm install vite @vitejs/plugin-react react react-dom`. A production host
builds its page with its own bundler and serves the files; the server here uses
Vite's middleware, as a React app in development does.

## Check and test

```sh
npx tsc -p examples/apps/ladle/tsconfig.json
node --import tsx --test examples/apps/ladle/tests/schedule.test.ts
```

[`tests/schedule.test.ts`](tests/schedule.test.ts) tests the host's route on its
own, with no mistri server. The repository's browser suite walks the whole
site (`e2e/ladle.spec.ts`): the schedule, the staff desk inside the header, and
a guest checked in on the check-in page.

`authority.lock` records every grant, the page's reads and command included;
`mistri check --write-authority` rewrites it after a change.

# Embed: a Next.js front end with mistri as its back end

A Next.js app that draws everything itself and uses a mistri App as its back end, through
`@mistriwork/mistri/react/headless`. The page lists loan applications with a plain `<ul>` and runs the App's
`assignReviewer` command from a plain `<button>`. Nothing on the page is mistri's but the hooks' answers.

- `app/api/mistri/[[...path]]/route.ts` mounts the App in Next's own server under `/api/mistri` (`createHandler`).
  That path carries the App's API, its sign-in page and its auth routes.
- `mistri/app.ts` is the App: the repository's Command desk fixture
  (`test/fixtures/apps/command-desk`), made headless (`ui: { headless: true }`), so it has no screens of its own.
  Anyone may sign up, and a new account is a manager, who may run the command.
- `mistri/surfaces/applications.surface.ts` is the one surface the page is in. It reads the applications and the
  reviewers and runs `assignReviewer`, and nothing else gets through.
- `app/page.tsx` is the front end: a `Provider` naming that surface, `useRows` and `useCommand`.
- `lib/mistri.ts` makes the handler once, for the route handler and for `app/server/page.tsx`: the same list drawn by a
  server component, at `/server`. It has no browser session, so it calls `mistri.tokenFor({ headers: await headers() },
  { surface: 'applications' })`, which reads the person from the cookie the request carried and returns a bearer for them
  and that surface, for 30 seconds here (300 at most). It reads the rows through the App's API with
  `Authorization: Bearer …`; a read outside the surface, or by someone whose grant is gone, is refused as for the browser.

The example borrows the fixture from this checkout, so run it from a clone of the repository. It is not part of the
repository's install: it has its own `package.json`, and Next.js is a dependency only here.

## Run it

Headless mode ships in `@mistriwork/mistri` 1.0.0-rc.25, and `tokenFor` (the `/server` page) in 1.0.0-rc.26.

```sh
npm ci                      # at the repository root: the seed and the fixture use it
cd examples/embed
npm install
npm run seed                # .data/reviews.db and its connection file, .data/reviews.db.json
echo '{}' > .data/staff.json
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export COMMAND_DESK_STAFF_MAP="$PWD/.data/staff.json"
npm run dev
```

Open http://localhost:3000 and follow **Sign in**. Sign up on the App's sign-in page; it brings you back to
`/`, and the page lists the three applications.

The fixture's command records which staff member assigned a reviewer, so it needs to know which reviewer you are.
Until it does, it refuses. Read your `accountId` from http://localhost:3000/api/mistri/api/whoami and map it to
staff 1, the North desk's manager:

```sh
echo '{"<your accountId>": 1}' > .data/staff.json
```

Restart `npm run dev`, since the map is read when the commands load. **Assign Robin Bell** now assigns reviewer 3 to
the first application, and the list shows it.

Open http://localhost:3000/server for the same list drawn on the server, from a token.

`PUBLIC_ORIGIN` sets the origin the handler expects, if you serve the app anywhere other than
`http://localhost:3000`.

## What to read next

- [Surfaces: a front end of your own](../../docs/apps.md#surfaces-a-front-end-of-your-own), in docs/apps.md, covers
  surfaces, the `X-Mistri-Surface` gate and headless mode.
- `e2e/embed-headless.spec.ts` drives the same App end to end: it signs in, lists, runs the command, and has a
  revoked grant refused.

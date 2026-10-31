<img src="mark.svg" alt="mistri" width="48" height="48" />

# @mistriwork/cloudflare

A [mistri](https://mistriwork.dev) App on Cloudflare Containers: the container class and the Worker handlers that
`mistri deploy init cloudflare` writes a Worker against, so a fix to the glue is a package upgrade rather than a diff
in every project.

```ts
import { MistriContainer, mistriWorker } from '@mistriwork/cloudflare';

export class App extends MistriContainer {
  static override options = { vars: ['MISTRI_PUBLIC_URL'], secrets: ['BETTER_AUTH_SECRET'] };
}
export default mistriWorker({ binding: 'APP', instance: 'app-1', location: 'enam' });
```

`MistriContainer` is always on, waits out mistri's startup checks before it answers 500, hands the Worker's named
vars and secrets to the container, and logs its start and exit. It also upgrades itself: `wrangler deploy` rolls
nothing out under the `durable_object` scheduling policy and a running container keeps its startup image and env, so
the Durable Object records what it started the container with (image, `MISTRI_DEPLOY_ID`, instance type) and, on a
request or the Worker's tick, replaces a healthy container that differs from what its own Worker version wants (never
one still starting, at most once a minute). The platform moves a running Durable Object onto a new Worker version
only after about five minutes, so `mistriWorker` stamps its version on the status probe and the tick, and an object
behind a newer Worker resets itself (at most once per 30 seconds) and starts again on it. `GET /__mistri/status` with `MISTRI_RESTART_TOKEN` in `x-mistri-restart`
reports the Worker version (`version_metadata` binding `CF_VERSION_METADATA`), what is desired and what the container
started with, which `mistri deploy` polls; a `POST` with the token stops the container, the manual fallback. Its `options` are `port`, `instanceType` and `image` (pinned at each start, for an account
whose container applications are created by the Durable Object), `startupTimeoutMs`, `vars`, `secrets`,
`restartTokenEnv`, `sleepAfter` and `alwaysOn`.

`mistriWorker` returns `fetch` (every request to the one named instance, as it is, so WebSockets and streams pass)
and `scheduled` (a once-a-minute `/readyz` that starts the instance if a host restart or a rollout stopped it).

`forwardEmail(message, env, { binding, instance, secretEnv, parse })` signs an inbound message (HMAC-SHA-256 over
`<timestamp>.<body>`) and posts it to the App's `/api/mail/inbound` through the Durable Object. Hand it the parser:
`parse: (raw) => PostalMime.parse(raw, { attachmentEncoding: 'base64' })`; this package carries none. A 2xx or a replayed delivery (409) is done; a 404, 413, 400 or 422 rejects the message with
a reason; anything else (401, 403, 429, 5xx) throws, so a signing or configuration fault is retried and logged rather
than finishing as if the mail were forwarded.

`@cloudflare/containers` is a peer dependency. mistri itself depends on nothing here.
[Source](https://github.com/rbaljinder/mistri/tree/main/packages/cloudflare).

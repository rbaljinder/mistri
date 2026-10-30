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
vars and secrets to the container, stops the container on a `POST` carrying `MISTRI_RESTART_TOKEN` in
`x-mistri-restart` (what `mistri deploy` sends until the new container reports its fingerprint on `/readyz`), and
logs its start and exit. Its `options` are `port`, `instanceType` and `image` (pinned at each start, for an account
whose container applications are created by the Durable Object), `startupTimeoutMs`, `vars`, `secrets`,
`restartTokenEnv`, `sleepAfter` and `alwaysOn`.

`mistriWorker` returns `fetch` (every request to the one named instance, as it is, so WebSockets and streams pass)
and `scheduled` (a once-a-minute `/readyz` that starts the instance if a host restart or a rollout stopped it).

`forwardEmail(message, env, { binding, instance, secretEnv, parse })` signs an inbound message (HMAC-SHA-256 over
`<timestamp>.<body>`) and posts it to the App's `/api/mail/inbound` through the Durable Object. Hand it the parser:
`parse: (raw) => PostalMime.parse(raw, { attachmentEncoding: 'base64' })`; this package carries none.

`@cloudflare/containers` is a peer dependency. mistri itself depends on nothing here.
[Source](https://github.com/rbaljinder/mistri/tree/main/packages/cloudflare).

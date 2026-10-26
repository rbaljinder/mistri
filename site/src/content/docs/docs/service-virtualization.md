---
title: Service virtualization
description: Fake an HTTP provider your App calls, with its own state, repeatable failures and a check that every call was expected.
---

Fake an HTTP provider your App calls, with its own state, repeatable failures
and a check that every call was expected.

```ts title="tests/credit.test.ts"
import { defineService, startService } from '@mistriwork/mistri/testing';

const credit = defineService({
  name: 'credit-check',
  state: { checks: 0 },
  routes: [{ id: 'create', match: { method: 'POST', path: '/checks' },
    reply: ({ state }) => ({ status: 201, body: { id: String(++state.checks), score: 720 } }) }],
  scenarios: { unavailable: [{ id: 'create', match: { method: 'POST', path: '/checks' },
    reply: { status: 503, body: { error: 'Try later' } } }] },
});

await using service = await startService(credit, { seed: 42 });
// Give the App service.url as the provider's base URL, then:
service.scenario('unavailable');                       // the next call fails
service.verify({ method: 'POST', path: '/checks' }, { times: 1 });
```

<!-- no sample: no sample App calls an outside HTTP provider it would fake. -->

<!-- no picture: a virtual service is a test fixture; its result is a passing or failing test. -->

## What you'll see

- A loopback HTTP service on its own port, answering the routes you declared,
  with a journal of every request it received.
- A failing test when the App makes a call no route expects, sends malformed
  JSON, or a handler throws, even if the App's code caught the error.
- The same sequence every run: a logical clock that moves only when the test
  advances it, and seeded `random()`.

## When to use it

- Use a virtual service for any provider the App calls over HTTP: credit
  checks, payments, a partner's webhook receiver.
- Use a [test host](/docs/testing-apps/) beside it to run the App itself, and
  pass `service.url` in through `startTestApp({ environment })`.
- Keep a separate contract test against the real provider: a simulation proves
  how your App handles the protocol, not that the provider still speaks it.

## Options

| Key | Does | Default |
| --- | --- | --- |
| `routes[].match` | `method`, `path` (`/checks/:id`, a final `*`), `query`, `headers`, `body` (`{ exact }`, `{ partial }` or `{ predicate }`) | matches anything |
| `routes[].reply` | `{ status, body, headers, delayMs, fault }`, or a function of `{ params, query, body, rawBody, state, clock, random, signal }` | 200 |
| `routes[].priority` | Breaks a tie between routes that both match; a tie otherwise fails | none |
| `scenarios` | Named route overrides, switched with `service.scenario(name)` and `scenario(null)` | none |
| `startService(def, { seed, now, handlerTimeoutMs })` | Seeded randomness, the clock's start, the request deadline | `seed: 1`, `now: 0`, 5 s |

`service.clock.advance(ms)` moves logical time, `service.journal()` lists the
requests, and `service.reset()` restores the initial state. `fault:
'disconnect'` closes the connection; `fault: 'timeout'` withholds the reply.
The full matching, state and limit rules are in
`docs/service-virtualization.md`.

## Run one on its own

Default-export the definition from a module, then:

```sh
mistri virtual credit-service.ts --port 0 --seed 42 --now 0
mistri virtual credit-service.ts --port 4700 --scenario unavailable
```

It prints its loopback URL, and exits unsuccessfully on SIGINT if it saw an
unexpected request or a handler failed.

## Common mistakes

- Teardown fails with the candidate routes' differences → the App sent a
  request no route matches; read the differences, then fix the App or the
  route.
- Two routes match and the test fails naming both → give one a `priority`;
  declaration order never decides.
- A handler that awaits `clock.sleep(…)` never returns → the test must call
  `service.clock.advance(…)`; logical time does not pass by itself.
- The runner has no `await using` → register `service.close()` in its teardown
  right after `startService`.

## Related

- [Test an App](/docs/testing-apps/): the disposable host the App runs in.
- [Connections and services](/docs/services/#webhooks-kind-webhook): the webhooks a virtual service can receive.
- Lintel's integrations test (`examples/apps/lintel/tests/integrations.test.ts`): a signed payment callback against a virtual service.

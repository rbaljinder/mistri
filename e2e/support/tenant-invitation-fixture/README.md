# Private invitation browser proof

These fixtures use fresh OS-temp databases and native accounts. They never use
sample databases or the ordinary browser suite's shared `e2e/.tmp` fixtures.
Run sequentially with other large gates:

```sh
npx playwright test --config e2e/support/tenant-invitation-fixture/playwright.config.ts
```

Both invitation specs import the account-secret worker fixture and apply its
artifact options in their own suite. Trace, screenshot and video are disabled;
the worker-local `PLAYWRIGHT_NO_COPY_PROMPT` also suppresses Playwright's separate
page snapshot in `error-context.md`. This is an internal Playwright switch, so
verify it when upgrading the browser runner:

```sh
npx playwright test --config e2e/support/tenant-invitation-fixture/artifact-probe.config.ts
```

The probe deliberately exits 1 with `Intentional invitation artifact probe
failure`. Its config deliberately enables diagnostic artifacts; the imported
fixture must override them. Inspect the reported OS-temp output: diagnostic
source/error text may remain, but there must be no `Page snapshot`, no trace,
image or video, and no joined `invitation-artifact-sentinel` input value. The
sentinel is not an actual credential. A green probe run or a different error is
not proof of this boundary. Normal test discovery excludes the `.pw.ts` probe.

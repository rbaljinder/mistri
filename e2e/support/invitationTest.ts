import { test as base } from '@playwright/test';

// Secret-bearing tests need more than trace/screenshot/video: Playwright also
// snapshots input values into error-context.md. Scope its opt-out to this worker
// fixture so unrelated browser tests keep their failure diagnostics. The explicit
// artifact probe verifies this internal switch when Playwright is upgraded.
export const test = base.extend<{}, { invitationArtifacts: void }>({
  invitationArtifacts: [
    async ({ browserName: _browserName }, use) => {
      const previous = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
      try {
        await use();
      } finally {
        if (previous === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previous;
      }
    },
    { scope: 'worker', auto: true },
  ],
});
// Each importing spec calls test.use itself: module caching must not make the
// options apply only to the first suite collected in a process.
export const invitationArtifactOptions = { trace: 'off', screenshot: 'off', video: 'off' } as const;
export { expect, type Page } from '@playwright/test';

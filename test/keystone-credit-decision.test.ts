/**
 * Keystone's credit decision workflow on the workflow driver: a controlled
 * clock, the real engine, and fake commands and provider. The end-to-end run
 * through the real host and the virtual credit service is
 * keystone-public-testing.test.ts; this holds the paths that take days.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { StepRefused } from '../packages/mistri/src/server/workflows.js';
import { createWorkflowDriver } from '../packages/mistri/src/server/testing/workflows.js';
import { creditDecision } from '../test/fixtures/apps/keystone/lender/server/credit-decision.ts';
import { applicationDecided, creditCheckRequested, creditReported } from '../test/fixtures/apps/keystone/lender/server/events.ts';

const HOUR = 3_600_000,
  DAY = 24 * HOUR;

describe('the credit decision', () => {
  const drivers: Awaited<ReturnType<typeof createWorkflowDriver>>[] = [];
  after(async () => {
    for (const driver of drivers) await driver.close();
  });
  const make = async (options: { refuse?: string } = {}) => {
    const driver = await createWorkflowDriver({
      workflow: { creditDecision },
      calls: { 'credit-provider': () => ({ id: 'chk-1' }) },
      commands: {
        approveApplication: () => {
          if (options.refuse === 'approveApplication') throw new StepRefused('auto-approve', 'refused');
          return { ok: true };
        },
        referToUnderwriter: () => ({ ok: true }),
        remindUnderwriter: () => ({ ok: true }),
      },
    });
    drivers.push(driver);
    await driver.emit(creditCheckRequested, { applicationId: 'A-1' });
    return driver;
  };
  const only = async (driver: Awaited<ReturnType<typeof make>>) => (await driver.instances())[0];
  const stepNames = async (driver: Awaited<ReturnType<typeof make>>) =>
    (await driver.steps((await only(driver)).id)).map((step) => step.name);

  test('asks the provider once, and waits for its callback', async () => {
    const driver = await make();
    assert.equal(driver.executed('call:credit-provider'), 1);
    assert.equal((await only(driver)).currentStep, 'credit-result');
  });

  test('a clear score approves without an underwriter', async () => {
    const driver = await make();
    await driver.emit(creditReported, { applicationId: 'A-1', checkId: 'chk-1', score: 760 });
    assert.equal((await only(driver)).state, 'completed');
    assert.equal(driver.executed('approveApplication'), 1);
    assert.equal(driver.executed('referToUnderwriter'), 0);
  });

  test('a callback for another check does not match', async () => {
    const driver = await make();
    await driver.emit(creditReported, { applicationId: 'A-1', checkId: 'someone-elses', score: 800 });
    assert.equal((await only(driver)).state, 'waiting');
    assert.equal(driver.executed('approveApplication'), 0);
  });

  test("a middling score refers, and the underwriter's decision ends it", async () => {
    const driver = await make();
    await driver.emit(creditReported, { applicationId: 'A-1', checkId: 'chk-1', score: 640 });
    assert.equal((await only(driver)).currentStep, 'decision');
    assert.equal(driver.executed('referToUnderwriter'), 1);
    await driver.emit(applicationDecided, { applicationId: 'A-1', outcome: 'approved' });
    assert.equal((await only(driver)).state, 'completed');
    assert.equal(driver.executed('remindUnderwriter'), 0);
  });

  test('a clear score the program cannot lend is referred instead', async () => {
    const driver = await make({ refuse: 'approveApplication' });
    await driver.emit(creditReported, { applicationId: 'A-1', checkId: 'chk-1', score: 790 });
    assert.equal((await only(driver)).currentStep, 'decision');
    assert.equal(driver.executed('referToUnderwriter'), 1);
  });

  test('a referral nobody answers in two days sends one reminder, then waits one more day', async () => {
    const driver = await make();
    await driver.emit(creditReported, { applicationId: 'A-1', checkId: 'chk-1', score: 600 });
    await driver.advance(2 * DAY - HOUR);
    assert.equal(driver.executed('remindUnderwriter'), 0, 'not before two days');
    await driver.advance(2 * HOUR);
    assert.equal(driver.executed('remindUnderwriter'), 1);
    assert.equal((await only(driver)).currentStep, 'decision-late');
    await driver.advance(DAY + HOUR);
    assert.equal((await only(driver)).state, 'completed');
    assert.equal(driver.executed('remindUnderwriter'), 1, 'the reminder is sent once');
    assert.deepEqual(await stepNames(driver), ['request-check', 'credit-result', 'refer', 'decision', 'remind', 'decision-late']);
  });

  test('a late decision after the reminder still ends it', async () => {
    const driver = await make();
    await driver.emit(creditReported, { applicationId: 'A-1', checkId: 'chk-1', score: 600 });
    await driver.advance(3 * DAY - HOUR);
    await driver.emit(applicationDecided, { applicationId: 'A-1', outcome: 'declined' });
    assert.equal((await only(driver)).state, 'completed');
    assert.equal(driver.executed('remindUnderwriter'), 1);
  });

  test('no callback in two days refers the file for want of a score', async () => {
    const driver = await make();
    await driver.advance(2 * DAY + HOUR);
    assert.equal(driver.executed('referToUnderwriter'), 1);
    assert.equal((await only(driver)).state, 'completed');
    assert.deepEqual(await stepNames(driver), ['request-check', 'credit-result', 'no-score']);
  });

  test('the provider failing twice is retried with a back-off, then answers', async () => {
    let failures = 2;
    const driver = await createWorkflowDriver({
      workflow: { creditDecision },
      calls: {
        'credit-provider': () => {
          if (failures-- > 0) throw Object.assign(new Error('down'), { code: 'http_503' });
          return { id: 'chk-1' };
        },
      },
      commands: { approveApplication: () => ({}), referToUnderwriter: () => ({}), remindUnderwriter: () => ({}) },
    });
    drivers.push(driver);
    await driver.emit(creditCheckRequested, { applicationId: 'A-1' });
    // Time moves in steps, as it does: each retry's back-off counts from when it failed.
    for (let minute = 0; minute < 4; minute++) await driver.advance(60_000);
    assert.equal((await only(driver)).currentStep, 'credit-result');
    assert.equal(driver.executed('call:credit-provider'), 3);
  });
});

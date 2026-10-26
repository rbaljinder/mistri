import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { HELP, parseOptions } from './options.mjs';
import { collector, record, summarize, evaluateGates, markdownReport } from './metrics.mjs';
import { assertDiskSpace, createRunDirectory, seedFixture, startOwnedServer, machineInfo, gitInfo } from './fixture.mjs';
import { createAgent, post, workload, verifyFixture } from './http.mjs';
import { browserEvents, createBrowserUser, journey } from './browser.mjs';
import { runArrivals } from './arrivals.mjs';
import { serverLaunch } from './launch.mjs';

async function phase(seconds, users, server, fixture, options, signal) {
  const http = collector(),
    browser = collector(),
    endpoints = {},
    operations = {};
  const events = browserEvents();
  const retiredBrowserUsers = [];
  for (const user of users) user.events = events;
  const started = performance.now(),
    until = started + seconds * 1000;
  const requestAttempt = async (agent, user, iteration) => {
    const item = workload(fixture, user, iteration),
      start = performance.now();
    let failure;
    try {
      if (!server.alive()) throw new Error('Owned server exited');
      item.check(await post(server.origin, item.path, item.body, { timeoutMs: options.requestTimeoutMs, signal, agent }));
    } catch (error) {
      failure = error;
    }
    const elapsed = performance.now() - start;
    record(http, item.operation, user, elapsed, failure);
    record((endpoints[item.path] ??= collector()), item.operation, user, elapsed, failure);
    record((operations[item.operation] ??= collector()), item.operation, user, elapsed, failure);
  };
  let activeBrowsers = users.length;
  const tasks = users.map(async (user, index) => {
    try {
      while (performance.now() < until && !signal.aborted) {
        const start = performance.now();
        let failure;
        try {
          await journey(user, server.origin, fixture, options, signal);
        } catch (error) {
          failure = error;
        }
        record(browser, 'issue-list-detail-back-filter', index, performance.now() - start, failure);
        if (failure) {
          retiredBrowserUsers.push(index);
          break;
        }
        await delay(Math.min(options.thinkMs, Math.max(0, until - performance.now())), undefined, { signal });
      }
    } finally {
      activeBrowsers--;
    }
  });
  let arrivals;
  if (options.arrivalRps)
    tasks.push(
      (async () => {
        const agents = Array.from({ length: options.users }, createAgent);
        try {
          arrivals = await runArrivals({
            rate: options.arrivalRps,
            seconds,
            concurrency: options.users,
            signal,
            run: (user, iteration) => requestAttempt(agents[user], user, iteration),
          });
        } finally {
          for (const agent of agents) agent.destroy();
        }
      })(),
    );
  else
    for (let user = 0; user < options.users; user++)
      tasks.push(
        (async () => {
          const agent = createAgent();
          try {
            let iteration = 0;
            // Keep HTTP traffic active while the final in-flight browser journey
            // drains. Actual elapsed time, including drain, is the rate denominator.
            while ((performance.now() < until || activeBrowsers > 0) && !signal.aborted) {
              await requestAttempt(agent, user, iteration++);
              await delay(options.thinkMs, undefined, { signal });
            }
          } finally {
            agent.destroy();
          }
        })(),
      );
  const results = await Promise.allSettled(tasks);
  const elapsedMs = performance.now() - started;
  const summary = {
    windowSeconds: seconds,
    elapsedMs,
    drainMs: Math.max(0, elapsedMs - seconds * 1000),
    http: summarize(http, elapsedMs),
    browser: summarize(browser, elapsedMs),
    browserEvents: events,
    retiredBrowserUsers,
    ...(arrivals ? { arrivals } : {}),
    endpoints: Object.fromEntries(Object.entries(endpoints).map(([key, metric]) => [key, summarize(metric, elapsedMs)])),
    operations: Object.fromEntries(Object.entries(operations).map(([key, metric]) => [key, summarize(metric, elapsedMs)])),
  };
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected && !signal.aborted) throw rejected.reason;
  return summary;
}

export async function main(argv = process.argv.slice(2), internal = undefined) {
  if (internal !== undefined && (Object.keys(internal).length !== 1 || internal.postgres !== true))
    throw new Error('Unsupported internal load mode');
  const options = parseOptions(argv);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const { directory, freeBytesBefore } = createRunDirectory();
  console.log(`Local-only load artifacts: ${directory}`);
  const started = performance.now();
  const report = {
    schemaVersion: 1,
    runId: new Date().toISOString(),
    mode: options.production ? 'production-dist' : 'source-dev-vite',
    status: 'failed',
    purpose: options.smoke
      ? 'mechanism safety check, not a capacity baseline'
      : `local synthetic ${options.arrivalRps ? 'fixed-arrival' : 'closed-loop'} experiment, not production capacity`,
    options,
    machine: machineInfo(),
    git: gitInfo(),
    freeBytesBefore,
    browserConfiguration: {
      engine: 'chromium',
      headless: true,
      viewport: { width: 1440, height: 924 },
      httpCache: 'disabled by local-only request routing',
      serviceWorkers: 'blocked',
      journeyTiming: 'synthetic elapsed time, not INP',
    },
  };
  const controller = new AbortController();
  let server, browser, browserClosing, caughtSignal, ownedFixture;
  const browserUsers = [];
  const closeBrowser = () => {
    for (const user of browserUsers) user.closing = true;
    if (browser) browserClosing ??= browser.close();
    return browserClosing;
  };
  const interrupt = (signal) => {
    caughtSignal = signal;
    controller.abort(new Error(`Interrupted by ${signal}`));
  };
  const sigint = () => interrupt('SIGINT'),
    sigterm = () => interrupt('SIGTERM');
  const aborted = () => {
    const closing = closeBrowser();
    if (closing) closing.catch(() => {});
  };
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  controller.signal.addEventListener('abort', aborted, { once: true });
  try {
    if (internal?.postgres) serverLaunch(options.production); // Refuse missing built artifacts before provisioning.
    const fixture = internal?.postgres
      ? await (await import('./postgres-fixture.mjs')).seedPostgresFixture(directory, options.rows, controller.signal)
      : await seedFixture(directory, options.rows);
    ownedFixture = fixture;
    if (fixture.evidence) report.database = fixture.evidence;
    controller.signal.throwIfAborted();
    server = await startOwnedServer(directory, fixture, controller.signal, options.production);
    report.server = { origin: server.origin, pid: server.pid, args: server.args, fixtureIdentityVerified: false };
    await verifyFixture(server, fixture, options, controller.signal);
    report.server.fixtureIdentityVerified = true;
    const { chromium } = await import('@playwright/test');
    controller.signal.throwIfAborted();
    // The harness owns signal handling so Playwright cannot exit the process
    // before the owned CLI is stopped and the interruption report is written.
    browser = await chromium.launch({ headless: true, timeout: 30000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    report.browserConfiguration.version = browser.version();
    controller.signal.throwIfAborted();
    for (let i = 0; i < options.browserUsers; i++) browserUsers.push(await createBrowserUser(browser, server.origin, options));
    assertDiskSpace(directory);
    console.log(
      `Owned Thread fixture verified; warming up ${options.users} HTTP + ${options.browserUsers} browser users (${server.mode}).`,
    );
    report.warmup = await phase(options.warmup, browserUsers, server, fixture, options, controller.signal);
    controller.signal.throwIfAborted();
    if (
      !report.warmup.http.completed ||
      !report.warmup.browser.completed ||
      report.warmup.http.errors ||
      report.warmup.browser.errors ||
      report.warmup.browserEvents.errors ||
      report.warmup.arrivals?.droppedBusy ||
      report.warmup.arrivals?.droppedLate
    )
      throw new Error('Warmup failed; inspect report.json before attempting measurement');
    assertDiskSpace(directory);
    console.log(`Measuring ${options.duration}s scheduling window; in-flight journeys may extend elapsed time.`);
    report.measured = await phase(options.duration, browserUsers, server, fixture, options, controller.signal);
    controller.signal.throwIfAborted();
    report.gates = evaluateGates(report.measured, options);
    report.status = report.gates.passed ? 'passed' : 'failed';
  } catch (error) {
    report.failure = String(error.message ?? error).slice(0, 8000);
    report.status = caughtSignal ? 'interrupted' : 'failed';
  } finally {
    try {
      await closeBrowser();
    } catch (error) {
      report.cleanupError = String(error);
      report.status = 'failed';
    }
    let childStopped = false;
    try {
      await server?.stop();
      childStopped = !server || !server.alive();
    } catch (error) {
      report.cleanupError = String(error);
      report.status = 'failed';
    }
    if (ownedFixture?.cleanup && !childStopped) {
      report.cleanupError = 'Owned child still active; database retained for manual recovery';
      report.status = 'failed';
    } else {
      try {
        await ownedFixture?.cleanup?.();
      } catch {
        report.cleanupError = 'Owned database cleanup refused; manual identity review required';
        report.status = 'failed';
      }
    }
    const redact = ownedFixture?.redact ?? ((value) => value);
    report.childLogTail = redact(server?.logs() ?? '');
    if (report.failure) report.failure = redact(report.failure);
    report.totalElapsedMs = performance.now() - started;
    report.finishedAt = new Date().toISOString();
    report.interruptedBy = caughtSignal ?? null;
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    controller.signal.removeEventListener('abort', aborted);
  }
  const json = `${JSON.stringify(report, null, 2)}\n`,
    markdown = markdownReport(report);
  if (Buffer.byteLength(json) > 1024 * 1024 || Buffer.byteLength(markdown) > 64 * 1024) {
    throw new Error(`Report size limit exceeded (JSON 1 MiB / Markdown 64 KiB). Owned resources stopped; artifacts: ${directory}`);
  }
  writeFileSync(join(directory, 'report.json'), json, { flag: 'wx' });
  writeFileSync(join(directory, 'report.md'), markdown, { flag: 'wx' });
  console.log(`${report.status.toUpperCase()}: ${join(directory, 'report.md')}`);
  if (report.failure) console.error(report.failure);
  for (const failure of report.gates?.failures ?? []) console.error(failure);
  return caughtSignal === 'SIGINT' ? 130 : caughtSignal === 'SIGTERM' ? 143 : report.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

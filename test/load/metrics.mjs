export function percentile(values, fraction) {
  if (!values.length) return null;
  if (!(fraction > 0 && fraction <= 1) || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Invalid percentile input');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

export function collector() {
  return { attempts: 0, completed: 0, errors: 0, durations: [], errorSamples: [], byOperation: {}, byUser: {} };
}

export function record(target, operation, user, elapsedMs, error) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Invalid elapsed time');
  target.attempts++;
  target.byOperation[operation] = (target.byOperation[operation] ?? 0) + 1;
  target.byUser[user] = (target.byUser[user] ?? 0) + 1;
  if (error) {
    target.errors++;
    if (target.errorSamples.length < 20)
      target.errorSamples.push({ operation, user, message: String(error.message ?? error).slice(0, 1500) });
  } else {
    target.completed++;
    target.durations.push(elapsedMs);
  }
}

export function summarize(target, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) throw new Error('Invalid measurement duration');
  const { durations, ...counts } = target;
  return {
    ...counts,
    errorRate: target.attempts ? target.errors / target.attempts : 0,
    completedPerSecond: (target.completed * 1000) / elapsedMs,
    latencyMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), p99: percentile(durations, 0.99) },
  };
}

export function evaluateGates(measured, options) {
  const failures = [];
  for (const [name, limit, users] of [
    ['http', options.httpP95Ms, options.users],
    ['browser', options.uiP95Ms, options.browserUsers],
  ]) {
    const metric = measured[name];
    if (!metric.completed) failures.push(`${name}: no successful samples`);
    if (!(name === 'http' && options.arrivalRps) && Object.keys(metric.byUser).length !== users)
      failures.push(`${name}: not every configured user attempted work`);
    if (metric.latencyMs.p95 !== null && metric.latencyMs.p95 > limit)
      failures.push(`${name}: p95 ${metric.latencyMs.p95.toFixed(1)}ms exceeds ${limit}ms`);
    if (metric.errorRate > options.maxErrorRate) failures.push(`${name}: error rate ${metric.errorRate} exceeds ${options.maxErrorRate}`);
  }
  if (measured.browserEvents.errors) failures.push(`browser: ${measured.browserEvents.errors} page/network errors`);
  if (measured.retiredBrowserUsers?.length) failures.push(`browser: failed users retired (${measured.retiredBrowserUsers.join(', ')})`);
  if (options.arrivalRps) {
    const arrivals = measured.arrivals;
    if (
      !arrivals ||
      arrivals.rate !== options.arrivalRps ||
      arrivals.scheduled !== options.arrivalRps * measured.windowSeconds ||
      arrivals.admitted !== measured.http.attempts ||
      arrivals.admitted !== arrivals.scheduled
    ) {
      failures.push('http: fixed-arrival schedule was not fully admitted and accounted for');
    }
    if (arrivals && (arrivals.droppedBusy || arrivals.droppedLate || arrivals.cancelled))
      failures.push('http: offered arrivals were dropped or cancelled');
  }
  return { passed: failures.length === 0, failures };
}

export function markdownReport(report) {
  const lines = [
    '# Thread local load report',
    '',
    `Result: ${report.status}. Mode: ${report.mode}.`,
    '',
    'Local synthetic experiment on the generator machine; not production capacity. Browser journey time is not INP.',
    '',
    `Run: ${report.runId}. Node: ${report.machine.node}. Git: ${report.git.head ?? 'unknown'} (dirty: ${report.git.dirty ?? 'unknown'}).`,
    '',
    `Configured HTTP users: ${report.options.users}; browser users: ${report.options.browserUsers}; issues: ${report.options.rows}.`,
    '',
  ];
  for (const name of ['warmup', 'measured']) {
    const phase = report[name];
    if (!phase) continue;
    lines.push(
      `${name}: ${(phase.elapsedMs / 1000).toFixed(3)}s actual elapsed; ${phase.windowSeconds}s scheduling window.`,
      '',
      '| Workload | Attempts | Completed | Errors | Completed/s | p50 ms | p95 ms | p99 ms |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const key of ['http', 'browser']) {
      const m = phase[key],
        fmt = (value) => (value === null ? 'n/a' : value.toFixed(2));
      lines.push(
        `| ${key} | ${m.attempts} | ${m.completed} | ${m.errors} | ${fmt(m.completedPerSecond)} | ${fmt(m.latencyMs.p50)} | ${fmt(m.latencyMs.p95)} | ${fmt(m.latencyMs.p99)} |`,
      );
    }
    lines.push('', `Browser requests: ${phase.browserEvents.requests}; page/network errors: ${phase.browserEvents.errors}.`, '');
    if (phase.arrivals) {
      const a = phase.arrivals;
      lines.push(
        `HTTP offered: ${a.rate}/s; scheduled: ${a.scheduled}; admitted: ${a.admitted}; dropped busy: ${a.droppedBusy}; dropped late: ${a.droppedLate}; cancelled: ${a.cancelled}; peak in-flight: ${a.peakInFlight}; maximum scheduler lag: ${a.maximumLagMs.toFixed(2)}ms.`,
        '',
      );
    }
    if (phase.endpoints) {
      lines.push(
        '| Endpoint | Completed | Errors | Completed/s | p50 ms | p95 ms | p99 ms |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      );
      for (const [path, m] of Object.entries(phase.endpoints)) {
        const fmt = (value) => (value === null ? 'n/a' : value.toFixed(2));
        lines.push(
          `| ${path} | ${m.completed} | ${m.errors} | ${fmt(m.completedPerSecond)} | ${fmt(m.latencyMs.p50)} | ${fmt(m.latencyMs.p95)} | ${fmt(m.latencyMs.p99)} |`,
        );
      }
      lines.push('');
    }
  }
  for (const failure of report.gates?.failures ?? []) lines.push(`- ${failure}`);
  if (report.failure) lines.push('', `Failure: ${report.failure}`);
  lines.push(
    '',
    'Latencies include successful attempts only; errors are counted separately. Throughput uses actual phase elapsed time including in-flight drain. Configured users are concurrency settings, not achieved RPS.',
    '',
    'See report.json for environment, per-user counts, browser network counts, error samples, and bounded child logs.',
    '',
  );
  return lines.join('\n');
}

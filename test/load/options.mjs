export const HELP = `Usage: node test/load/run.mjs [options]

Always starts an owned loopback server with a fresh Thread database.
No URL, host, port, config, database, or external target can be supplied.

  --smoke                 5s measurement, 1 HTTP user, 100 issues, 1s warmup
  --production            Use existing dist server/client; never builds or installs
  --users N               HTTP users, 1..32 (default 4)
  --arrival-rps N         Fixed HTTP arrivals/second, 1..100; users becomes in-flight cap
  --browser-users N       Chromium users, 1..4 (default 1)
  --duration N            Measured scheduling window in seconds, 1..300 (default 15)
  --warmup N              Separate warmup seconds, 1..60 (default 3)
  --rows N                Total fixture issues, 24..10000 (default 500)
  --think-ms N            Delay after each request/journey, 10..5000 (default 100)
  --request-timeout-ms N  HTTP deadline, 100..30000 (default 5000)
  --ui-timeout-ms N       Whole journey deadline, 500..30000 (default 10000)
  --http-p95-ms N         HTTP successful-request p95 gate, 1..60000 (default 1000)
  --ui-p95-ms N           Successful-journey p95 gate, 1..120000 (default 5000)
  --max-error-rate N      Maximum failed-attempt fraction per workload, 0..1 (default 0)
  --help                  Show this help

Flags take separate values; unknown/duplicate flags and positional arguments fail.
Artifacts are retained in a new OS temporary directory (path printed at startup).
Source-mode timings include Vite; these do not establish production capacity.
Browser journey timing is synthetic elapsed time, not INP.
`;

const numeric = {
  '--arrival-rps': ['arrivalRps', 1, 100],
  '--users': ['users', 1, 32],
  '--browser-users': ['browserUsers', 1, 4],
  '--duration': ['duration', 1, 300],
  '--warmup': ['warmup', 1, 60],
  '--rows': ['rows', 24, 10000],
  '--think-ms': ['thinkMs', 10, 5000],
  '--request-timeout-ms': ['requestTimeoutMs', 100, 30000],
  '--ui-timeout-ms': ['uiTimeoutMs', 500, 30000],
  '--http-p95-ms': ['httpP95Ms', 1, 60000],
  '--ui-p95-ms': ['uiP95Ms', 1, 120000],
  '--max-error-rate': ['maxErrorRate', 0, 1],
};

export function parseOptions(argv) {
  const options = {
    users: 4,
    browserUsers: 1,
    duration: 15,
    warmup: 3,
    rows: 500,
    thinkMs: 100,
    requestTimeoutMs: 5000,
    uiTimeoutMs: 10000,
    httpP95Ms: 1000,
    uiP95Ms: 5000,
    maxErrorRate: 0,
    smoke: false,
    production: false,
    help: false,
  };
  if (argv.includes('--smoke')) Object.assign(options, { users: 1, duration: 5, rows: 100, warmup: 1 });
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (['--smoke', '--help', '--production'].includes(flag)) {
      options[flag.slice(2)] = true;
      continue;
    }
    const spec = numeric[flag];
    if (!spec) throw new Error(`Unsupported option: ${flag}. Custom targets are forbidden. Use --help.`);
    const value = argv[++i];
    const [key, min, max] = spec;
    const number = Number(value);
    if (
      !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value ?? '') ||
      !Number.isFinite(number) ||
      number < min ||
      number > max ||
      (key !== 'maxErrorRate' && !Number.isInteger(number))
    ) {
      throw new Error(`${flag} requires ${key === 'maxErrorRate' ? 'a number' : 'an integer'} in ${min}..${max}`);
    }
    options[key] = number;
  }
  return options;
}

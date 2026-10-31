/**
 * The server child's lifetime, and the policy for links that leave the window.
 *
 * Kept apart from main.js, which cannot be loaded without Electron: everything
 * here takes its collaborators (spawn, fetch, the error dialog) as arguments,
 * so test/desktop-lifecycle.test.ts runs the real code against doubles.
 */

/**
 * Schemes a link may hand to the operating system. Anything else — file:,
 * javascript:, an application's custom scheme — would let a link inside the
 * window launch whatever the OS has registered for it.
 */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** Whether `url` may be passed to `shell.openExternal`. Malformed is refused. */
function isAllowedExternal(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return EXTERNAL_SCHEMES.has(parsed.protocol);
}

/**
 * Own the server child.
 *
 * Every child gets a record, and retirement is a property of that record: an
 * intentional stop (switching databases, quitting, a failed startup) marks the
 * child it stops, so its exit is expected, and a later child is never touched
 * by an earlier one's callbacks.
 *
 * `onUnexpectedExit(log, code)` is called only when the *current* child dies
 * after it was ready, and not while the app is quitting.
 */
function createServerLifecycle({
  spawn,
  fetch,
  freePort,
  entry,
  root,
  spawnOptions,
  onUnexpectedExit,
  isQuitting = () => false,
  write = () => {},
  deadlineMs = 30_000,
  pollMs = 150,
  firstPollMs = 100,
  graceMs = 3000,
}) {
  let current = null;
  let port = 0;

  /** Retire a record: its exit is now expected. */
  function retire(record) {
    if (record.retired) return;
    record.retired = true;
    const child = record.child;
    if (current === record) current = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const hard = setTimeout(() => child.kill('SIGKILL'), graceMs);
    // Unref so a server that exits promptly does not hold the event loop open
    // for the full grace period on the way out.
    if (typeof hard.unref === 'function') hard.unref();
    child.once('exit', () => clearTimeout(hard));
  }

  function start(target) {
    const found = entry();
    if (!found) {
      return Promise.reject(
        new Error(
          `No server found under ${root}. In a checkout, run "npm install" at the repo root; ` +
            'for a packaged build, run "npm run dist" from desktop/.',
        ),
      );
    }

    return freePort().then((chosen) => {
      port = chosen;
      const args = [...found.args, '--port', String(chosen), '--host', '127.0.0.1'];
      if (target) args.push('--db', target);

      const record = { child: null, retired: false, cancel: null };
      /** Kept so a startup failure can be reported in the server's own words. */
      let log = '';
      const note = (chunk) => {
        log = `${log}${chunk}`.slice(-4000);
        write(`[server] ${chunk}`);
      };

      return new Promise((ok, fail) => {
        let settled = false;
        const timers = new Set();
        const abort = new AbortController();
        const finish = (outcome, value) => {
          if (settled) return;
          settled = true;
          for (const t of timers) clearTimeout(t);
          timers.clear();
          abort.abort();
          outcome(value);
        };
        /* A failed startup leaves nothing running: the child is stopped here,
           so a retry starts from a clean slate. */
        const failStartup = (message) => {
          retire(record);
          finish(fail, new Error(message));
        };
        record.cancel = () => failStartup('The server was stopped before it was ready.');

        let child;
        try {
          child = spawn(process.execPath, args, spawnOptions);
        } catch (err) {
          failStartup(`Could not start the server: ${err.message}`);
          return;
        }
        record.child = child;
        current = record;

        child.stdout?.on('data', note);
        child.stderr?.on('data', note);
        child.on('error', (err) => {
          failStartup(log.trim() || `Could not start the server: ${err.message}`);
        });
        child.on('exit', (code) => {
          if (record.retired) return;
          if (!settled) {
            failStartup(log.trim() || `The server exited with code ${code} before it was ready.`);
            return;
          }
          // Died later, with a window already open. Nothing works from here,
          // so say so rather than leaving a page that 404s every request.
          if (current === record) current = null;
          if (!isQuitting()) onUnexpectedExit(log, code);
        });

        /* One absolute deadline, not a check between attempts: a server that
           accepts the connection and never answers would otherwise keep a
           pending fetch, and the window, waiting past it. */
        const deadline = setTimeout(
          () => failStartup(log.trim() || `The server did not answer within ${Math.round(deadlineMs / 1000)} seconds.`),
          deadlineMs,
        );
        timers.add(deadline);

        const poll = () => {
          if (settled) return;
          fetch(`http://127.0.0.1:${chosen}/api/connections`, { signal: abort.signal })
            .then((res) => {
              if (!res.ok) throw new Error(String(res.status));
              finish(ok, chosen);
            })
            .catch(() => {
              if (settled) return;
              const next = setTimeout(poll, pollMs);
              timers.add(next);
            });
        };
        timers.add(setTimeout(poll, firstPollMs));
      });
    });
  }

  /**
   * Stop the server, and mean it.
   *
   * SIGTERM first, because the server handles it and closes its database
   * connections on the way out. SIGKILL after a grace period, because "the app
   * closed but a process is still holding the database" is a worse outcome than
   * an unclean shutdown. Synchronous by design: `will-quit` does not wait for a
   * promise.
   */
  function stop() {
    const record = current;
    if (!record) return;
    if (record.cancel) record.cancel();
    else retire(record);
  }

  return {
    start,
    stop,
    get port() {
      return port;
    },
  };
}

module.exports = { createServerLifecycle, isAllowedExternal };

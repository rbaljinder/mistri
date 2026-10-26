/** Own a browser fixture child from spawn through startup failure and teardown. */
export async function readyBrowserChild(child, name, { startupMs = 30000, stopMs = 3000 } = {}) {
  let log = '',
    closed = false,
    stopping;
  const capture = (chunk) => {
    log = (log + String(chunk)).slice(-64 * 1024);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const closing = new Promise((resolve) =>
    child.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  const stop = () =>
    (stopping ??= (async () => {
      if (closed) return;
      child.kill('SIGTERM');
      const force = setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, stopMs);
      try {
        await closing;
      } finally {
        clearTimeout(force);
      }
    })());
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', ready);
        child.off('error', failed);
        child.off('close', exited);
      };
      const failed = (error) => {
        cleanup();
        reject(error);
      };
      const exited = () => failed(new Error(`${name} exited during startup: ${log}`));
      const ready = () => {
        if (log.includes('Listening on ')) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => failed(new Error(`${name} did not start: ${log}`)), startupMs);
      child.stdout.on('data', ready);
      child.once('error', failed);
      child.once('close', exited);
      ready();
    });
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

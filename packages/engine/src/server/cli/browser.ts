/**
 * Opening the served page in the reader's browser, best effort: a machine
 * with no opener keeps serving, and the URL is already on screen.
 */
export async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    /* A headless box — a container, a server, an SSH session — has no
       `xdg-open`, and `spawn` reports that as an `error` event, not a throw.
       With no handler Node re-raises it as an uncaught exception and takes the
       whole process down — so `--open`, and `--demo` which implies it, crashed
       exactly where it was most useful: the container serving the demo. A
       missing opener is not fatal. The server is already listening and the URL
       is already printed; opening it is a convenience, not a requirement. */
    child.once('error', () => {});
    child.unref();
  } catch {
    /* Some platforms throw synchronously instead. Same non-answer: the server
       stays up, the URL is on screen, the reader opens it themselves. */
  }
}

/**
 * The command that opens `url` on `platform`. Windows has no `start` executable — it is a `cmd.exe` builtin, so
 * spawning it by name fails with ENOENT, which the caller swallows: `--open` and `--demo` did nothing there. The
 * URL handler `start` itself ends in is a real program, and with no shell between, an `&` in a URL is not a command
 * separator.
 */
export function openerFor(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * Opening the served page in the reader's browser, best effort: a machine
 * with no opener keeps serving, and the URL is already on screen.
 */
export async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { cmd, args } = openerFor(process.platform, url);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
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

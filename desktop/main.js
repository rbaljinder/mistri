/**
 * tablewalk in a window.
 *
 * The shell and nothing more. There is no second implementation of anything
 * here: the same server runs, serving the same client, and this process opens
 * a window pointed at it. That is the whole reason Electron was chosen over
 * Tauri for this codebase — see docs/deploy.md — because the one hard requirement
 * is a real Node 24 runtime for `node:sqlite`, and Electron 43 *is* Node
 * 24.18. Tauri would have meant shipping a separate ~110 MB node binary per
 * platform to get the same thing.
 *
 * Three things this file has to get right, all of them about process
 * lifetime rather than about windows:
 *
 *   - The server is a child process, not an import. Importing it would put a
 *     database driver, a request loop and `process.exit()` inside the process
 *     that owns the UI; a bad connection string would take the window with it.
 *   - The child is Electron's own binary re-entered as Node
 *     (ELECTRON_RUN_AS_NODE), so there is exactly one runtime in the bundle
 *     and it is the one that was tested.
 *   - The child dies with the app. A server left holding a Postgres pool and a
 *     listening socket after its window closed is the classic Electron leak,
 *     and it is worse here because the thing it leaks is access to a database.
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, dirname, resolve } = require('node:path');
const { homedir } = require('node:os');
const { createServerLifecycle, isAllowedExternal } = require('./lifecycle.js');

/**
 * Where the server and node_modules live.
 *
 * In development that is the repo root, one level up. In a packaged app it is
 * `resources/server`, staged by scripts/stage.mjs — deliberately *not*
 * `resources/app`, which is where electron-builder puts the asar and is not
 * ours to occupy.
 */
const ROOT = app.isPackaged ? join(process.resourcesPath, 'server') : resolve(__dirname, '..');

/** Where the window's choice of database is remembered between launches. */
const STATE = join(app.getPath('userData'), 'state.json');

let window = null;
/** Set on the way out, so the child's exit is not reported as a crash. */
let quitting = false;

/* ---------- picking how to run the server ---------- */

/**
 * The server entry point, and the arguments Node needs to run it.
 *
 * Built output is preferred and is the only thing that exists in a packaged
 * app. The fallback to TypeScript through tsx is what makes `npm run dev`
 * work against a fresh checkout with no build step — Node's resolver walks up
 * from the repo root and finds tsx in the root project's node_modules, so the
 * desktop package does not depend on it.
 */
function serverEntry() {
  /* Packaged, the server is installed as a project would install it
     (scripts/stage.mjs); in a checkout it is the workspace's tablewalk package,
     whose imports of the others answer from their dist/ only under the
     checkout's condition (scripts/pack-manifest.mjs). */
  if (app.isPackaged) return { args: [join(ROOT, 'node_modules', 'tablewalk', 'dist', 'server', 'index.js')], mode: 'dist' };
  const built = join(ROOT, 'packages', 'tablewalk', 'dist', 'server', 'index.js');
  if (existsSync(built)) return { args: ['--conditions=mistri-built', built], mode: 'dist' };

  const source = join(ROOT, 'packages', 'tablewalk', 'src', 'server', 'index.ts');
  if (existsSync(source) && existsSync(join(ROOT, 'node_modules', 'tsx'))) {
    return { args: ['--import', 'tsx', source], mode: 'tsx' };
  }
  return null;
}

/** A port the OS says is free, asked for at launch rather than assumed. */
function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    /* Loopback, matching what the server will bind. A port free on 0.0.0.0 is
       not necessarily free on 127.0.0.1. */
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

/* ---------- remembering the last database ---------- */

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`);
  } catch {
    /* A preference that cannot be saved is not worth an error dialog. */
  }
}

async function chooseDatabase() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Open a database',
    properties: ['openFile'],
    filters: [
      { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return canceled ? undefined : filePaths[0];
}

/* ---------- the server ---------- */

/**
 * Start the server and resolve once it is answering.
 *
 * Polling `/api/connections` rather than waiting a fixed time, because the
 * delay is however long it takes to open a database and introspect it — fast
 * for a SQLite file, and not fast for a Postgres over a VPN. A timeout is
 * still needed, and it is generous for that reason.
 *
 * Startup failure is a normal outcome, not an exception: a config error or an
 * unreachable database makes the server print a diagnosis and exit 1. That
 * text is the best explanation anyone will get, so it is captured and shown
 * rather than replaced with "could not start". The lifetime rules themselves
 * (deadline, retirement of an old child) live in lifecycle.js, where they are
 * tested without Electron.
 */
const server = createServerLifecycle({
  spawn,
  fetch: (url, init) => fetch(url, init),
  freePort,
  entry: serverEntry,
  root: ROOT,
  spawnOptions: {
    cwd: ROOT,
    env: {
      ...process.env,
      /* Re-enter our own binary as plain Node. This is what gives the server
         Node 24 and `node:sqlite` without a second runtime in the bundle. */
      ELECTRON_RUN_AS_NODE: '1',
      /* Not inherited: the desktop app's window is the browser, and a second
         one opening in Safari is a bug rather than a feature. */
      TABLEWALK_OPEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
  isQuitting: () => quitting,
  write: (text) => process.stdout.write(text),
  onUnexpectedExit: (log, code) => {
    dialog.showErrorBox('tablewalk server stopped', log || `Exited with code ${code}.`);
    app.quit();
  },
});

function startServer(target) {
  return server.start(target);
}

const stopServer = () => server.stop();

/* ---------- the window ---------- */

/** The one door to the OS's link handlers; lifecycle.js says what may pass. */
function openExternal(url) {
  if (isAllowedExternal(url)) void shell.openExternal(url);
}

function createWindow(port) {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    title: 'tablewalk',
    backgroundColor: '#111111',
    /* The page is served by our own server on a port we chose, so there is no
       remote content — but nothing here needs Node in the renderer either, and
       leaving it off means a bug in the client cannot reach the filesystem. */
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false,
  });

  // Shown on ready-to-show rather than immediately, so the first thing anyone
  // sees is the app and not an empty white rectangle.
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    window = null;
  });

  /* Loopback by name, so the Host header is `127.0.0.1:<port>` and the
     cross-origin guard's loopback branch passes. This is why the desktop app
     needs no --allowed-host: it is the one deployment that really is local. */
  window.loadURL(`http://127.0.0.1:${port}/`);

  /* A link to somewhere else is a link to a browser. An Electron window that
     navigates away from its own app is a window with no way back. */
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${server.port}/`)) {
      event.preventDefault();
      openExternal(url);
    }
  });

  return window;
}

/**
 * Reopen against a different database.
 *
 * The server takes its target at startup, so changing it means restarting the
 * server. Doing that rather than adding a runtime endpoint keeps the desktop
 * app from being the one client that can do something the CLI cannot.
 */
async function openDatabase() {
  const file = await chooseDatabase();
  if (!file) return;
  writeState({ lastDatabase: file });
  stopServer();
  try {
    const port = await startServer(file);
    if (window) window.loadURL(`http://127.0.0.1:${port}/`);
    else createWindow(port);
  } catch (err) {
    dialog.showErrorBox('Could not open that database', err.message);
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Database…', accelerator: 'CmdOrCtrl+O', click: () => void openDatabase() },
        { type: 'separator' },
        {
          label: 'Open in Browser',
          click: () => {
            if (server.port) void shell.openExternal(`http://127.0.0.1:${server.port}/`);
          },
        },
        { type: 'separator' },
        // On macOS Quit lives in the app menu; elsewhere this is the only one.
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- lifecycle ---------- */

/* One instance. A second one would pick a second port, start a second server
   and open a second window onto the same database — three surprises for one
   double-click. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    buildMenu();

    /* What to browse, in order: an argument, then whatever was open last, then
       a config file the server can find on its own, and only then ask. Asking
       first would put a file picker in front of someone whose tablewalk.json
       already says exactly what they want. */
    const fromArgv = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
    const remembered = readState().lastDatabase;
    const target = fromArgv || (remembered && existsSync(remembered) ? remembered : undefined);
    /* No forced file picker on a fresh launch any more. It asked for a SQLite
       file and nothing else, and quit the whole app if you cancelled — a dead
       end for someone who just installed it and has a Postgres URL, or wanted
       the demo. With no target the server serves its own onboarding page: the
       "Follow the data" welcome, a connection form that takes a URL or its
       parts, and the same read-only-by-default promise the browser build
       makes. "Open Database…" stays on the File menu for when a file is what
       you have. */

    try {
      const port = await startServer(target);
      if (target) writeState({ lastDatabase: target });
      createWindow(port);
    } catch (err) {
      dialog.showErrorBox('tablewalk could not start', err.message);
      app.quit();
    }

    app.on('activate', () => {
      // macOS: clicking the dock icon with no windows open should give one
      // back, and the server is still running, so this is just a window.
      if (BrowserWindow.getAllWindows().length === 0 && server.port) createWindow(server.port);
    });
  });

  /* Closing the window quits, on every platform including macOS. tablewalk is a
     single-window tool holding an open database, and the Mac convention of
     staying resident would leave that connection open with nothing on screen
     to say so. */
  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    quitting = true;
  });

  /* The one that must not be missed. `will-quit` fires for every route out —
     menu quit, last window closed, Cmd-Q, SIGINT from the terminal that
     launched it — so the child is killed once, here, rather than in four
     places that each handle three of the four cases. */
  app.on('will-quit', stopServer);
  process.on('exit', stopServer);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      quitting = true;
      stopServer();
      app.quit();
    });
  }
}

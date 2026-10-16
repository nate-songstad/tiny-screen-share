// Screenpeek for Mac: the screenpeek.me site in a window, plus what a browser
// can't do — a screen picker that knows which display you chose, and the laser
// drawn right on that display, above every app, hidden from the capture itself.
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, protocol, screen, session, shell, systemPreferences } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (file) => fileURLToPath(new URL(file, import.meta.url));
// The app's own pages, served from a private scheme (file:// can't load JS modules).
const local = (page) => `screenpeek://app/${page}`;
const pages = new Set(['overlay.html', 'overlay.js', 'vendor/laser.js', 'picker.html', 'picker.js', 'setup.html', 'setup.js', 'offline.html', 'offline.js', 'pages.css']);
protocol.registerSchemesAsPrivileged([{ scheme: 'screenpeek', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const target = new URL(process.env.SCREENPEEK_URL || 'https://screenpeek.me/');
// Tests: capture the app's own page instead of the real screen, so no OS prompt appears.
const fakeCapture = process.env.SCREENPEEK_FAKE_CAPTURE === '1';
if (process.env.SCREENPEEK_USER_DATA) app.setPath('userData', process.env.SCREENPEEK_USER_DATA);

let main = null, setup = null, picker = null;
// Set once the app is quitting, so closing windows doesn't open new ones.
let quitting = false;
let lastSource = null;

// ---- Settings -------------------------------------------------------------

const settingsFile = () => join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(readFileSync(settingsFile(), 'utf8')) || {}; } catch { return {}; }
}
function saveSettings(change) {
  try { writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...change })); } catch { /* Ask again next time. */ }
}

// ---- Trust ----------------------------------------------------------------

function trusted(url) {
  try { return new URL(url).origin === target.origin; } catch { return false; }
}
function openExternal(url) {
  try {
    if (['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)) shell.openExternal(url);
  } catch { /* Not a URL: ignore. */ }
}
// Messages from the site count only from our main window, showing our site.
const fromSite = (event) => Boolean(main) && event.sender === main.webContents && trusted(event.senderFrame?.url);
const fromWindow = (event, win) => Boolean(win) && !win.isDestroyed() && event.sender === win.webContents;

function screenAccess() {
  if (process.env.SCREENPEEK_FAKE_SCREEN_ACCESS) return process.env.SCREENPEEK_FAKE_SCREEN_ACCESS;
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
}
function openScreenSettings() {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
}
// Asking for sources once puts Screenpeek in the Screen Recording list (and shows
// macOS's own prompt the first time), so there's a switch to turn on.
async function registerForScreenAccess() {
  if (fakeCapture || process.platform !== 'darwin') return;
  try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch { /* Shown in Settings regardless. */ }
}
function relaunch() {
  app.relaunch();
  app.exit(0);
}

// ---- Main window ----------------------------------------------------------

function createMain() {
  main = new BrowserWindow({
    width: 1180, height: 820, minWidth: 380, minHeight: 560, show: false,
    title: 'Screenpeek', backgroundColor: '#f5f6f4',
    webPreferences: {
      preload: here('./preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      // Sharing keeps working smoothly while Screenpeek sits behind other apps.
      backgroundThrottling: false
    }
  });
  const contents = main.webContents;
  // No popups: links open in the browser.
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (trusted(url) || url.startsWith(local(''))) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  // A page that reloads or navigates has lost its state: take the laser off the screen.
  contents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) {
      overlay.set(null);
      lastSource = null;
    }
  });
  contents.on('render-process-gone', () => overlay.set(null));
  contents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    // -3 is an aborted load (e.g. a newer navigation), not a failure.
    if (!isMainFrame || code === -3 || !trusted(url)) return;
    contents.loadURL(local('offline.html'));
  });
  main.once('ready-to-show', () => main.show());
  main.on('closed', () => {
    main = null;
    overlay.destroy();
    if (picker && !picker.isDestroyed()) picker.destroy();
  });
  main.loadURL(target.href);
}

ipcMain.on('screenpeek:retry', (event) => {
  if (main && event.sender === main.webContents) main.loadURL(target.href);
});

// ---- Screen picker --------------------------------------------------------

const toData = (image) => (image && !image.isEmpty() ? image.toDataURL() : null);

async function listSources() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay().id;
  const label = (display, index) => display.label || (display.id === primary ? 'Main screen' : `Screen ${index + 1}`);
  if (fakeCapture) {
    return [
      ...displays.map((display, index) => ({ id: `screen:${display.id}:0`, kind: 'screen', name: label(display, index), displayId: String(display.id), primary: display.id === primary, thumbnail: null, icon: null })),
      { id: 'window:4242:0', kind: 'window', name: 'Notes — Test window', displayId: null, primary: false, thumbnail: null, icon: null }
    ];
  }
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 400, height: 250 }, fetchWindowIcons: true });
  return sources.filter((source) => source.name).map((source) => {
    const isScreen = source.id.startsWith('screen:');
    const index = displays.findIndex((display) => String(display.id) === source.display_id);
    return {
      id: source.id, kind: isScreen ? 'screen' : 'window',
      name: isScreen ? label(displays[index] || {}, Math.max(0, index)) : source.name,
      displayId: isScreen ? source.display_id || null : null,
      primary: isScreen && source.display_id === String(primary),
      thumbnail: toData(source.thumbnail), icon: toData(source.appIcon)
    };
  });
}

let pickerJob = null;
// Opens the picker as a sheet on the main window. Resolves with the chosen
// source, or null when cancelled or when permission is still needed.
function choose() {
  if (pickerJob) return Promise.resolve(null);
  pickerJob = new Promise((resolve) => {
    const access = screenAccess();
    const state = { mode: access === 'granted' ? 'pick' : 'permission', access, sources: [] };
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      pickerJob = null;
      const win = picker;
      picker = null;
      if (win && !win.isDestroyed()) win.destroy();
      resolve(value);
    };
    picker = new BrowserWindow({
      parent: main, modal: true, show: false, width: 780, height: 600, resizable: false, minimizable: false, maximizable: false,
      title: 'Choose what to share', backgroundColor: '#ffffff',
      webPreferences: { preload: here('./picker-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
    picker.state = state;
    picker.finish = finish;
    picker.on('closed', () => finish(null));
    picker.once('ready-to-show', () => picker?.show());
    picker.loadURL(local('picker.html'));
    if (state.mode === 'permission') registerForScreenAccess();
  });
  return pickerJob;
}

ipcMain.handle('picker:state', async (event) => {
  if (!fromWindow(event, picker)) return null;
  const { state } = picker;
  if (state.mode === 'pick') {
    try { state.sources = await listSources(); } catch { state.sources = []; }
  }
  return { mode: state.mode, access: state.access, sources: state.sources.map(({ id, kind, name, primary, thumbnail, icon }) => ({ id, kind, name, primary, thumbnail, icon })) };
});
ipcMain.on('picker:choose', (event, id) => {
  if (!fromWindow(event, picker)) return;
  const source = typeof id === 'string' ? picker.state.sources.find((item) => item.id === id) : null;
  picker.finish(source || null);
});
ipcMain.on('picker:settings', (event) => {
  if (fromWindow(event, picker) || fromWindow(event, setup)) openScreenSettings();
});
ipcMain.on('picker:setup', (event) => {
  if (!fromWindow(event, picker)) return;
  picker.finish(null);
  openSetup('screen');
});

function handleDisplayMedia(request, callback) {
  // Only our site, in our window, may ask to capture.
  const frame = request.frame, top = main?.webContents.mainFrame;
  const sameFrame = Boolean(frame && top) && frame.processId === top.processId && frame.routingId === top.routingId;
  if (!main || !sameFrame || !trusted(request.securityOrigin)) {
    callback(null);
    return;
  }
  choose().then((source) => {
    if (!source || !main) {
      callback(null);
      return;
    }
    lastSource = { kind: source.kind, displayId: source.displayId, name: source.name };
    callback({ video: fakeCapture ? request.frame : { id: source.id, name: source.name } });
  }, () => callback(null));
}

ipcMain.handle('screenpeek:last-source', (event) => (fromSite(event) ? lastSource : null));

// ---- On-screen laser ------------------------------------------------------

function cleanPoint(point) {
  if (!point || typeof point !== 'object') return null;
  if (point.hide === true) return { hide: true };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const clamp = (value) => Math.min(1, Math.max(0, value));
  return { x: clamp(point.x), y: clamp(point.y), down: point.down === true };
}
function cleanLook(look) {
  return {
    style: typeof look?.style === 'string' ? look.style.slice(0, 24) : 'red',
    label: typeof look?.label === 'string' ? look.label.slice(0, 80) : ''
  };
}

// One click-through, capture-proof window covering the shared display.
const overlay = {
  win: null,
  displayId: null,
  set(value) {
    const displayId = value && (typeof value.displayId === 'string' || typeof value.displayId === 'number') ? String(value.displayId) : null;
    this.displayId = displayId;
    const display = displayId && screen.getAllDisplays().find((item) => String(item.id) === displayId);
    if (!display) {
      if (this.win && !this.win.isDestroyed()) {
        this.send({ type: 'reset' });
        this.win.hide();
      }
      return;
    }
    const win = this.window();
    win.setBounds(display.bounds);
    this.send({ type: 'reset' });
    win.showInactive();
    // Some window levels reset when shown; set them again.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  },
  window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, enableLargerThanScreen: true, type: 'panel', title: 'Screenpeek laser overlay',
      webPreferences: { preload: here('./overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
    });
    // Clicks go straight through to whatever is underneath.
    win.setIgnoreMouseEvents(true);
    // Hidden from screen capture, so viewers never get a second copy of their lasers.
    win.setContentProtection(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadURL(local('overlay.html'));
    win.on('closed', () => { if (this.win === win) this.win = null; });
    this.win = win;
    return win;
  },
  send(message) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('overlay:event', message);
  },
  visible() { return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible()); },
  destroy() {
    this.displayId = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  },
  // The display changed size, moved, or went away.
  refresh() { if (this.displayId) this.set({ displayId: this.displayId }); }
};

ipcMain.on('screenpeek:overlay', (event, value) => {
  if (fromSite(event)) overlay.set(value && typeof value === 'object' ? value : null);
});
ipcMain.on('screenpeek:laser', (event, message) => {
  if (!fromSite(event) || !overlay.visible() || !message || typeof message !== 'object') return;
  const id = typeof message.id === 'string' && message.id.length <= 64 ? message.id : null;
  if (message.type === 'apply' && id) {
    const point = cleanPoint(message.point);
    if (point) overlay.send({ type: 'apply', id, point, look: cleanLook(message.look) });
  } else if (message.type === 'clear') overlay.send({ type: 'clear', id });
});

// ---- Setup ----------------------------------------------------------------

// Tests can pretend to run from Downloads; otherwise only a real installed copy is checked.
function outsideApplications() {
  if (process.env.SCREENPEEK_FAKE_OUTSIDE_APPLICATIONS === '1') return true;
  return app.isPackaged && process.platform === 'darwin' && !app.isInApplicationsFolder();
}

function setupSteps(start) {
  const steps = ['welcome'];
  if (outsideApplications()) steps.push('move');
  steps.push('screen', 'done');
  return { steps, start: steps.includes(start) ? start : steps[0] };
}

function openSetup(start = 'welcome') {
  if (setup && !setup.isDestroyed()) {
    setup.focus();
    return;
  }
  setup = new BrowserWindow({
    width: 620, height: 560, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, show: false,
    title: 'Set up Screenpeek', backgroundColor: '#f5f6f4',
    webPreferences: { preload: here('./setup-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  setup.flow = setupSteps(start);
  setup.once('ready-to-show', () => setup?.show());
  setup.on('closed', () => {
    setup = null;
    saveSettings({ setupDone: true });
    if (!main && !quitting) createMain();
  });
  setup.loadURL(local('setup.html'));
}

ipcMain.handle('setup:state', (event) => {
  if (!fromWindow(event, setup)) return null;
  return { ...setup.flow, access: screenAccess(), version: app.getVersion() };
});
ipcMain.handle('setup:access', (event) => (fromWindow(event, setup) ? screenAccess() : null));
ipcMain.on('setup:register', (event) => {
  if (fromWindow(event, setup)) registerForScreenAccess().then(openScreenSettings);
});
ipcMain.handle('setup:move', async (event) => {
  if (!fromWindow(event, setup)) return false;
  saveSettings({ setupDone: true });
  try {
    // Moves the app and relaunches it from Applications.
    return app.moveToApplicationsFolder({
      conflictHandler: (type) => type === 'exists' && dialog.showMessageBoxSync(setup, {
        type: 'question', buttons: ['Replace', 'Cancel'], defaultId: 0, cancelId: 1,
        message: 'There’s already a Screenpeek in Applications. Replace it with this one?'
      }) === 0
    });
  } catch {
    return false;
  }
});
ipcMain.on('setup:relaunch', (event) => {
  if (!fromWindow(event, setup) && !fromWindow(event, picker)) return;
  saveSettings({ setupDone: true });
  relaunch();
});
ipcMain.on('setup:finish', (event) => {
  if (fromWindow(event, setup)) setup.close();
});

// Later launches from outside Applications: offer the move once per launch.
function offerMove() {
  if (!outsideApplications()) return;
  const choice = dialog.showMessageBoxSync({
    type: 'question', buttons: ['Move to Applications', 'Not Now'], defaultId: 0, cancelId: 1,
    message: 'Move Screenpeek to your Applications folder?',
    detail: 'Screen recording permission only sticks when Screenpeek runs from Applications.'
  });
  if (choice !== 0) return;
  try { app.moveToApplicationsFolder(); } catch {
    dialog.showMessageBoxSync({ type: 'info', message: 'Drag Screenpeek into Applications in Finder, then open it from there.' });
  }
}

// ---- Menu -----------------------------------------------------------------

function buildMenu() {
  const template = [
    { role: 'appMenu', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Set Up Screen Sharing…', click: () => openSetup('screen') },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ] },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Start ----------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = setup || main;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: 'Screenpeek', applicationVersion: app.getVersion(), copyright: 'Just your screen.' });
    const icon = here('../build/icon.png');
    if (process.platform === 'darwin' && !app.isPackaged && existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon));
    buildMenu();
    protocol.handle('screenpeek', (request) => {
      const url = new URL(request.url);
      const page = url.pathname.replace(/^\//, '');
      if (url.host !== 'app' || !pages.has(page)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(here(`./${page}`)).toString());
    });
    const site = session.defaultSession;
    site.setDisplayMediaRequestHandler(handleDisplayMedia);
    // Only what Screenpeek uses, and only for its own site.
    const allowed = new Set(['clipboard-sanitized-write', 'fullscreen', 'display-capture']);
    // Screen capture asks for "media" with no devices; a microphone or camera would list them.
    const screenOnly = (permission, details) => permission === 'media' && !(details?.mediaTypes || []).length;
    site.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback((allowed.has(permission) || screenOnly(permission, details)) && trusted(details.requestingUrl || contents.getURL()));
    });
    site.setPermissionCheckHandler((contents, permission, origin) => allowed.has(permission) && trusted(origin));
    screen.on('display-metrics-changed', () => overlay.refresh());
    screen.on('display-removed', () => overlay.refresh());
    screen.on('display-added', () => overlay.refresh());
    if (!readSettings().setupDone) openSetup();
    else {
      offerMove();
      createMain();
    }
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('activate', () => {
    if (!main && !setup && !quitting) createMain();
  });
  // A single-window utility: closing it quits, so no hidden overlay is left behind.
  // (Checked a moment later: finishing setup closes one window just before opening the next.)
  app.on('window-all-closed', () => setTimeout(() => {
    if (!BrowserWindow.getAllWindows().some((win) => win !== overlay.win)) app.quit();
  }, 100));
  // Never navigate any window we don't control.
  app.on('web-contents-created', (event, contents) => {
    contents.on('will-attach-webview', (attachEvent) => attachEvent.preventDefault());
  });
}

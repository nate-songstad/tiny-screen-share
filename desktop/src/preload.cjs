// The only things screenpeek.me can ask of the Mac app. Every call is checked again in the main process.
const { contextBridge, ipcRenderer } = require('electron');

// Set before any page script runs:
// - Electron freezes the page on Document Picture-in-Picture, so the site never
//   sees it here and uses its in-window preview instead.
// - Screenpeek never uses the camera or microphone. Refusing here means no page
//   can even raise macOS's permission prompt for them.
contextBridge.executeInMainWorld({
  func: () => {
    Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: false });
    const refuse = () => Promise.reject(new DOMException('Screenpeek never uses your camera or microphone.', 'NotAllowedError'));
    // (Absent on pages that aren't a secure context, such as Chromium's own error page.)
    if (typeof MediaDevices !== 'undefined') Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: refuse, configurable: false, writable: false });
    for (const name of ['getUserMedia', 'webkitGetUserMedia']) {
      if (name in Navigator.prototype) {
        Object.defineProperty(Navigator.prototype, name, {
          value: (constraints, success, failure) => { failure?.(new DOMException('Screenpeek never uses your camera or microphone.', 'NotAllowedError')); },
          configurable: false, writable: false
        });
      }
    }
  }
});

contextBridge.exposeInMainWorld('screenpeekDesktop', Object.freeze({
  apiVersion: 1,
  // What the last screen-picker choice was: { kind: 'screen' | 'window', displayId, name }.
  lastSource: () => ipcRenderer.invoke('screenpeek:last-source'),
  // Show the on-screen laser over a display ({ displayId }), or hide it (null).
  overlay: (value) => ipcRenderer.send('screenpeek:overlay', value ?? null),
  // A pointer change to draw on screen.
  laser: (message) => ipcRenderer.send('screenpeek:laser', message),
  retry: () => ipcRenderer.send('screenpeek:retry')
}));

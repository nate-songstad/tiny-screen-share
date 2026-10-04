import { expect } from '@playwright/test';

// Only the OS picker is replaced. Video tracks, WebRTC, WebSockets, decoding,
// navigation and UI events all run in real Chromium browser contexts.
export async function installCapture(page) {
  await page.addInitScript(() => {
    window.captureTest = { streams: [], mode: 'success', sockets: [], channels: [] };
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.captureTest.sockets.push(this); }
    };
    // Record laser data channels so tests can send raw or unauthorized messages.
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) {
        super(...args);
        this.addEventListener('datachannel', ({ channel }) => window.captureTest.channels.push(channel));
      }
      createDataChannel(...args) {
        const channel = super.createDataChannel(...args);
        window.captureTest.channels.push(channel);
        return channel;
      }
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const controls = window.captureTest;
      if (controls.mode === 'cancel') {
        controls.mode = 'success';
        throw new DOMException('Picker cancelled', 'NotAllowedError');
      }
      if (controls.mode === 'wait') {
        controls.mode = 'success';
        await new Promise((resolve) => { controls.release = resolve; });
      }
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 540;
      const ctx = canvas.getContext('2d');
      let frame = 0;
      const paint = () => {
        ctx.fillStyle = '#e8eede'; ctx.fillRect(0, 0, 960, 540);
        ctx.fillStyle = '#254c3b'; ctx.font = '36px sans-serif';
        ctx.fillText('A shared point of view.', 70, 150);
        ctx.font = '20px sans-serif'; ctx.fillText('Screenpeek • live screen test', 70, 200);
        ctx.fillStyle = '#9cb88b'; ctx.fillRect(70, 260, 820, 160);
        ctx.fillStyle = '#f3f6ed'; ctx.fillRect(90 + (frame++ % 180), 285, 120, 110);
      };
      paint();
      const timer = setInterval(paint, 50);
      const stream = canvas.captureStream(20);
      // Keep the source alive until all tracks have been stopped by the app.
      const monitor = setInterval(() => {
        if (stream.getTracks().every((track) => track.readyState === 'ended')) {
          clearInterval(timer); clearInterval(monitor);
        }
      }, 100);
      controls.streams.push(stream);
      return stream;
    };
  });
}

export async function newPage(browser, errors, options = {}) {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3217', viewport: { width: 1280, height: 900 }, ...options });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await installCapture(page);
  return page;
}

export async function startPair(browser, errors = [], viewerOptions = {}) {
  const host = await newPage(browser, errors);
  const viewer = await newPage(browser, errors, viewerOptions);
  await host.goto('/');
  await host.getByRole('button', { name: 'Share my screen' }).click();
  await expect(host.locator('#roomCode')).toHaveText(/^\d{6}$/);
  const code = await host.locator('#roomCode').textContent();
  await viewer.goto('/?room=' + code);
  await live(host, viewer);
  return { host, viewer, code };
}

export async function live(host, viewer) {
  await expect(host.locator('#sessionStatus')).toHaveText('Viewer connected');
  await expect(viewer.locator('#sessionStatus')).toHaveText('Live');
  await expect.poll(() => viewer.locator('#remoteVideo').evaluate((video) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(2);
  await expect(viewer.locator('#stageOverlay')).toBeHidden();
  await expect(viewer.locator('body')).toHaveClass('is-viewer');
  await expect(host.locator('body')).not.toHaveClass('is-viewer');
}

export async function flip(host, viewer) {
  await host.locator('#flipBtn').click();
  await expect(viewer.locator('#flipPrompt')).toBeVisible();
  await viewer.getByRole('button', { name: 'Accept & share' }).click();
  await live(viewer, host);
}

export async function tracksStopped(page) {
  await expect.poll(() => page.evaluate(() => window.captureTest.streams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')))).toBe(true);
}

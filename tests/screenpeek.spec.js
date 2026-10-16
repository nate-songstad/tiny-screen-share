import { test, expect } from '@playwright/test';
import { newPage, startPair, live, flip, tracksStopped } from './helpers.js';

test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });

test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
});

test('live video, pause privacy, resume, repeated flips, and end from new sharer', async ({ browser }) => {
  const errors = [];
  const { host, viewer, code } = await startPair(browser, errors);
  await host.locator('#pauseBtn').click();
  await expect(viewer.locator('#stageTitle')).toHaveText('Sharing paused');
  await expect(viewer.locator('#remoteVideo')).toBeHidden();
  expect(await host.evaluate(() => window.captureTest.streams.at(-1).getVideoTracks()[0].enabled)).toBe(false);
  await expect.poll(() => viewer.locator('#remoteVideo').evaluate((video) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).every((value) => value < 8);
  })).toBe(true);
  await host.getByRole('button', { name: 'Resume', exact: true }).click();
  await live(host, viewer);
  for (let i = 0; i < 3; i++) {
    await flip(host, viewer);
    await tracksStopped(host);
    await expect(viewer.locator('#roomCode')).toHaveText(code);
    await flip(viewer, host);
    await tracksStopped(viewer);
  }
  await flip(host, viewer);
  await viewer.getByRole('button', { name: 'End screenpeek' }).click();
  await expect(host.locator('#home')).toBeVisible();
  await expect(viewer.locator('#home')).toBeVisible();
  await tracksStopped(viewer);
  expect(new URL(host.url()).search).toBe('');
  expect(errors).toEqual([]);
});

test('decline and cancelled picker leave original media running; stale acceptance stops capture', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await host.locator('#flipBtn').click();
  await viewer.getByRole('button', { name: 'Not now' }).click();
  await expect(host.locator('#flipBtn')).toBeEnabled();
  await live(host, viewer);
  await host.locator('#flipBtn').click();
  await viewer.evaluate(() => { window.captureTest.mode = 'cancel'; });
  await viewer.locator('#acceptFlipBtn').click();
  await expect(viewer.locator('#message')).toContainText('cancelled');
  await expect(host.locator('#flipBtn')).toBeEnabled();
  await live(host, viewer);
  await host.locator('#flipBtn').click();
  await viewer.evaluate(() => { window.captureTest.mode = 'wait'; });
  await viewer.locator('#acceptFlipBtn').click();
  await host.getByRole('button', { name: 'Cancel request' }).click();
  await expect(viewer.locator('#flipPrompt')).toBeHidden();
  await viewer.evaluate(() => window.captureTest.release());
  await expect.poll(() => viewer.evaluate(() => window.captureTest.streams.length)).toBe(1);
  await tracksStopped(viewer);
  await live(host, viewer);
  expect(errors).toEqual([]);
});

test('viewer refresh reconnects automatically, including after flipping roles', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await viewer.reload();
  await live(host, viewer);
  await flip(host, viewer);
  await host.reload();
  await live(viewer, host);
  expect(errors).toEqual([]);
});

test('sharer refresh restores same room and explicit resume; picker cancellation can retry', async ({ browser }) => {
  const errors = [];
  const { host, viewer, code } = await startPair(browser, errors);
  await host.reload();
  await expect(host.getByRole('button', { name: 'Resume sharing' })).toBeVisible();
  await expect(host.locator('#roomCode')).toHaveText(code);
  await expect(viewer.locator('#stageTitle')).toHaveText('Waiting for their screen');
  await host.evaluate(() => { window.captureTest.mode = 'cancel'; });
  await host.locator('#resumeBtn').click();
  await expect(host.locator('#resumeBtn')).toBeEnabled();
  await host.locator('#resumeBtn').click();
  await live(host, viewer);
  await flip(host, viewer);
  await viewer.reload();
  await expect(viewer.locator('#roomCode')).toHaveText(code);
  await viewer.locator('#resumeBtn').click();
  await live(viewer, host);
  expect(errors).toEqual([]);
});

test('socket interruption recovers live stream, paused state, and membership', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await host.locator('#pauseBtn').click();
  await expect(viewer.locator('#stageTitle')).toHaveText('Sharing paused');
  await host.evaluate(() => window.captureTest.sockets.at(-1).close());
  await expect(host.locator('#sessionStatus')).toHaveText('Reconnecting…');
  await expect(host.locator('#sessionStatus')).toHaveText('Paused');
  expect(await host.evaluate(() => window.captureTest.streams.at(-1).getVideoTracks()[0].enabled)).toBe(false);
  await host.locator('#pauseBtn').click();
  await live(host, viewer);
  await viewer.evaluate(() => window.captureTest.sockets.at(-1).close());
  await live(host, viewer);
  expect(errors).toEqual([]);
});

test('end during screen picker prevents later capture from starting a ghost share', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await host.locator('#flipBtn').click();
  await viewer.evaluate(() => { window.captureTest.mode = 'wait'; });
  await viewer.locator('#acceptFlipBtn').click();
  await host.locator('#leaveBtn').click();
  await expect(viewer.locator('#home')).toBeVisible();
  await viewer.evaluate(() => window.captureTest.release());
  await expect.poll(() => viewer.evaluate(() => window.captureTest.streams.length)).toBe(1);
  await tracksStopped(viewer);
  expect(errors).toEqual([]);
});

test('viewer can leave and someone new can join; sharer departure expires cleanly', async ({ browser }) => {
  const errors = [];
  const { host, viewer, code } = await startPair(browser, errors);
  const third = await newPage(browser, errors);
  await viewer.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(host.locator('#sessionStatus')).toHaveText('Waiting for viewer');
  await expect(host.locator('#flipBtn')).toBeDisabled();
  await third.goto('/?room=' + code);
  await live(host, third);
  await host.close();
  await expect(third.locator('#stageTitle')).toHaveText('The sharer is reconnecting');
  await expect(third.locator('#home')).toBeVisible();
  await expect(third.locator('#message')).toContainText('sharer left');
  expect(errors).toEqual([]);
});

test('flip request expires; native stop ends room; invalid links and start cancellation recover', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await host.locator('#flipBtn').click();
  await expect(viewer.locator('#flipPrompt')).toBeVisible();
  await expect(viewer.locator('#flipPrompt')).toBeHidden();
  await expect(host.locator('#flipBtn')).toBeEnabled();
  await host.evaluate(() => {
    const track = window.captureTest.streams.at(-1).getVideoTracks()[0];
    track.stop(); track.dispatchEvent(new Event('ended'));
  });
  await expect(viewer.locator('#home')).toBeVisible();
  await viewer.goto('/?room=999999');
  await expect(viewer.locator('#message')).toContainText('ended or the code is incorrect');
  await viewer.evaluate(() => { window.captureTest.mode = 'cancel'; });
  await viewer.locator('#startBtn').click();
  await expect(viewer.locator('#startBtn')).toBeEnabled();
  await expect(viewer.locator('#message')).toContainText('cancelled');
  expect(errors).toEqual([]);
});

test('desktop and mobile layouts, keyboard focus, clipboard fallback, and screenshot review', async ({ browser }, testInfo) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await host.screenshot({ path: testInfo.outputPath('sharing-desktop.png'), fullPage: true });
  await viewer.screenshot({ path: testInfo.outputPath('viewer-desktop.png'), fullPage: true });
  await host.locator('#flipBtn').click();
  await viewer.screenshot({ path: testInfo.outputPath('flip-desktop.png'), fullPage: true });
  await host.setViewportSize({ width: 375, height: 812 });
  await viewer.setViewportSize({ width: 375, height: 812 });
  for (const width of [320, 375, 768, 1440]) {
    for (const page of [host, viewer]) {
      await page.setViewportSize({ width, height: 812 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('#leaveBtn')).toBeVisible();
    }
    const layout = await viewer.evaluate(() => {
      const session = document.querySelector('#session').getBoundingClientRect();
      const stage = document.querySelector('.screen-stage').getBoundingClientRect();
      const video = document.querySelector('#remoteVideo');
      const leave = document.querySelector('#leaveBtn').getBoundingClientRect();
      return { x: session.x, y: session.y, width: session.width, height: session.height,
        stageWidth: stage.width, stageHeight: stage.height, leaveBottom: leave.bottom,
        videoWidth: video.getBoundingClientRect().width, videoHeight: video.getBoundingClientRect().height,
        videoFit: getComputedStyle(video).objectFit,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        scrollHeight: document.documentElement.scrollHeight };
    });
    expect(layout.x).toBe(0);
    expect(layout.y).toBe(0);
    expect(layout.width).toBe(layout.viewportWidth);
    expect(layout.height).toBe(layout.viewportHeight);
    expect(layout.stageWidth).toBe(layout.viewportWidth);
    expect(layout.stageHeight).toBe(layout.viewportHeight);
    expect(layout.videoWidth).toBe(layout.viewportWidth);
    expect(layout.videoHeight).toBe(layout.viewportHeight);
    expect(layout.videoFit).toBe('contain');
    expect(layout.leaveBottom).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.scrollHeight).toBe(layout.viewportHeight);
  }
  await host.setViewportSize({ width: 375, height: 812 });
  await viewer.setViewportSize({ width: 375, height: 812 });
  await host.screenshot({ path: testInfo.outputPath('sharing-mobile.png'), fullPage: true });
  await viewer.screenshot({ path: testInfo.outputPath('flip-mobile.png'), fullPage: true });
  await host.locator('#cancelFlipBtn').click();
  await host.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Denied'); }; });
  await host.locator('#copyBtn').click();
  await expect(host.locator('#shareLink')).toBeFocused();
  await expect(host.locator('#message')).toContainText('Copy the selected link');
  await host.locator('#leaveBtn').click();
  await expect(viewer.locator('body')).not.toHaveClass('is-viewer');
  await host.screenshot({ path: testInfo.outputPath('home-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('pause survives a declined flip; accepting while paused gives the new sharer live video', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await host.locator('#pauseBtn').click();
  await host.locator('#flipBtn').click();
  await viewer.locator('#declineFlipBtn').click();
  await expect(host.locator('#sessionStatus')).toHaveText('Paused');
  await expect(viewer.locator('#stageTitle')).toHaveText('Sharing paused');
  await flip(host, viewer);
  await expect(viewer.locator('#pauseBtn')).toHaveText('Pause');
  await tracksStopped(host);
  expect(errors).toEqual([]);
});

test('refresh during a flip clears the pending request for both people', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await host.locator('#flipBtn').click();
  await expect(viewer.locator('#flipPrompt')).toBeVisible();
  await viewer.reload();
  await live(host, viewer);
  await expect(host.locator('#flipPrompt')).toBeHidden();
  await host.locator('#flipBtn').click();
  await expect(viewer.locator('#flipPrompt')).toBeVisible();
  await host.reload();
  await expect(viewer.locator('#flipPrompt')).toBeHidden();
  await host.locator('#resumeBtn').click();
  await live(host, viewer);
  expect(errors).toEqual([]);
});

test('join by keyboard, copy link, permission errors and an unavailable service recover cleanly', async ({ browser }) => {
  const errors = [];
  const host = await newPage(browser, errors);
  const viewer = await newPage(browser, errors);
  await host.goto('/');
  await host.evaluate(() => {
    window.successfulCapture = navigator.mediaDevices.getDisplayMedia;
    navigator.mediaDevices.getDisplayMedia = async () => { throw new DOMException('Denied by OS', 'NotReadableError'); };
  });
  await host.locator('#startBtn').click();
  await expect(host.locator('#message')).toContainText('screen-recording permission');
  await expect(host.locator('#startBtn')).toBeEnabled();
  await host.evaluate(() => { navigator.mediaDevices.getDisplayMedia = window.successfulCapture; });
  await host.locator('#startBtn').click();
  await expect(host.locator('#roomCode')).toHaveText(/^\d{6}$/);
  const code = await host.locator('#roomCode').textContent();
  await host.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await host.locator('#copyBtn').click();
  await expect(host.locator('#copyBtn')).toHaveText('Copied!');
  expect(await host.evaluate(() => navigator.clipboard.readText())).toContain('?room=' + code);
  await viewer.goto('/');
  await viewer.getByLabel('Six-digit share code').fill(code);
  await viewer.getByLabel('Six-digit share code').press('Enter');
  await live(host, viewer);
  await host.locator('#leaveBtn').click();
  // An unreachable service is retried quietly for a while before giving up.
  await host.routeWebSocket('**/*', (ws) => ws.close());
  await host.reload();
  await host.locator('#startBtn').click();
  await expect(host.locator('#startBtn')).toHaveText('Connecting…');
  await host.waitForTimeout(3000);
  await expect(host.locator('#message')).toBeHidden();
  await expect(host.locator('#message')).toContainText('Could not reach', { timeout: 30000 });
  await tracksStopped(host);
  await expect(host.locator('#startBtn')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a flaky connection to the service still starts and joins a screenpeek', async ({ browser }) => {
  test.setTimeout(60000);
  const errors = [];
  const host = await newPage(browser, errors);
  const viewer = await newPage(browser, errors);
  // The first two attempts fail, as they might on a poor network.
  for (const page of [host, viewer]) {
    let refused = 0;
    await page.routeWebSocket('**/*', (route) => {
      if (refused++ < 2) route.close();
      else route.connectToServer();
    });
  }
  await host.goto('/');
  await host.locator('#startBtn').click();
  await expect(host.locator('#roomCode')).toHaveText(/^\d{6}$/);
  await viewer.goto('/?room=' + await host.locator('#roomCode').textContent());
  await expect(viewer.locator('#message')).toContainText('Still trying');
  await live(host, viewer);
  await expect(viewer.locator('#message')).toBeHidden();
  expect(errors).toEqual([]);
});

test.describe('browser capture API', () => {
  test('native getDisplayMedia with Chromium test source sends video and flips', async ({ browser }) => {
    // Exercise the real getDisplayMedia implementation with Chromium's synthetic
    // display device. No capture API replacement in this test.
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3217' });
    const host = await context.newPage();
    const viewer = await context.newPage();
    const errors = [];
    for (const page of [host, viewer]) page.on('pageerror', (error) => errors.push(error.message));
    await host.goto('/');
    await host.locator('#startBtn').click();
    await expect(host.locator('#roomCode')).toHaveText(/^\d{6}$/);
    await viewer.goto('/?room=' + await host.locator('#roomCode').textContent());
    await live(host, viewer);
    await flip(host, viewer);
    await viewer.locator('#pauseBtn').click();
    await expect(host.locator('#stageTitle')).toHaveText('Sharing paused');
    await viewer.locator('#leaveBtn').click();
    await expect(host.locator('#home')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test('failed video retries on its own, then times out visibly, and Retry connection restores real video', async ({ browser }) => {
  test.setTimeout(90000);
  const errors = [];
  const host = await newPage(browser, errors);
  const viewer = await newPage(browser, errors);
  let allowSignals = false;
  await viewer.routeWebSocket('**/*', (route) => {
    const server = route.connectToServer();
    server.onMessage((message) => {
      if (allowSignals || JSON.parse(String(message)).type !== 'signal') route.send(message);
    });
  });
  await host.goto('/');
  await host.locator('#startBtn').click();
  await expect(host.locator('#roomCode')).toHaveText(/^\d{6}$/);
  await viewer.goto('/?room=' + await host.locator('#roomCode').textContent());
  // While it retries automatically, it says so rather than showing an error.
  await expect(viewer.locator('#sessionStatus')).toHaveText('Reconnecting video…', { timeout: 15000 });
  await expect(viewer.locator('#stageTitle')).toHaveText('Reconnecting the video');
  await expect(viewer.locator('#retryBtn')).toBeHidden();
  // Once retries run out, it asks the viewer.
  await expect(viewer.locator('#stageTitle')).toHaveText('Let’s try that again', { timeout: 40000 });
  await expect(viewer.locator('#retryBtn')).toBeVisible();
  const attempts = await viewer.evaluate(() => window.captureTest.peers.length);
  expect(attempts).toBe(4);
  // The sharer keeps its own preview throughout.
  await expect(host.locator('#localVideo')).toBeVisible();
  allowSignals = true;
  await viewer.locator('#retryBtn').click();
  await live(host, viewer);
  expect(errors).toEqual([]);
});

test('video that fails briefly recovers by itself, without pressing Retry', async ({ browser }) => {
  const errors = [];
  const host = await newPage(browser, errors);
  const viewer = await newPage(browser, errors);
  let allowSignals = false;
  await viewer.routeWebSocket('**/*', (route) => {
    const server = route.connectToServer();
    server.onMessage((message) => {
      if (allowSignals || JSON.parse(String(message)).type !== 'signal') route.send(message);
    });
  });
  await host.goto('/');
  await host.locator('#startBtn').click();
  await expect(host.locator('#roomCode')).toHaveText(/^\d{6}$/);
  await viewer.goto('/?room=' + await host.locator('#roomCode').textContent());
  await expect(viewer.locator('#sessionStatus')).toHaveText('Reconnecting video…', { timeout: 15000 });
  allowSignals = true;
  await live(host, viewer);
  await expect(viewer.locator('#retryBtn')).toBeHidden();
  expect(errors).toEqual([]);
});

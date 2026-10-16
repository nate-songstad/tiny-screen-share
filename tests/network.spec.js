import { test, expect } from '@playwright/test';
import { newPage, startPair, live, tracksStopped } from './helpers.js';

test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });
test.setTimeout(90000);

test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
});

const frames = (page) => page.locator('#remoteVideo').evaluate((video) => video.getVideoPlaybackQuality().totalVideoFrames);
const peers = (page) => page.evaluate(() => window.captureTest.peers.length);
async function flowing(viewer) {
  const start = await frames(viewer);
  await expect.poll(() => frames(viewer)).toBeGreaterThan(start + 3);
}
// Cuts this page off from the server: the open socket closes and new ones are refused.
async function cutOff(page) {
  await page.evaluate(() => {
    window.captureTest.offline = true;
    window.captureTest.sockets.at(-1).close();
  });
}
// The browser itself logs each refused connection while "offline"; those are expected.
const unexpected = (errors) => errors.filter((error) => !error.includes('ws://127.0.0.1:9/'));
const restore = (page) => page.evaluate(() => { window.captureTest.offline = false; });
// The sharer's outgoing video settings for each viewer.
const senders = (host) => host.evaluate(() => window.captureTest.peers
  .filter((pc) => pc.connectionState !== 'closed')
  .map((pc) => pc.getSenders().find((sender) => sender.track?.kind === 'video')?.getParameters().encodings[0])
  .filter(Boolean)
  .map(({ active, maxBitrate, maxFramerate }) => ({ active, maxBitrate, maxFramerate })));

test('a viewer losing the server keeps watching, and comes back without restarting the video', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  const before = [await peers(host), await peers(viewer)];
  await cutOff(viewer);
  await expect(viewer.locator('#sessionStatus')).toHaveText('Reconnecting…');
  // The video carries on, browser to browser.
  await expect(viewer.locator('#stageOverlay')).toBeHidden();
  await expect(viewer.locator('#remoteVideo')).toBeVisible();
  await flowing(viewer);
  await expect(host.locator('#sessionStatus')).toHaveText('Viewer connected');
  await viewer.waitForTimeout(2500);
  await expect(viewer.locator('#sessionStatus')).toHaveText('Reconnecting…');
  await flowing(viewer);
  await restore(viewer);
  await live(host, viewer);
  expect([await peers(host), await peers(viewer)]).toEqual(before);
  await flowing(viewer);
  expect(unexpected(errors)).toEqual([]);
});

test('a sharer losing the server keeps everyone watching, and comes back without restarting the video', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  const before = [await peers(host), await peers(viewer)];
  await cutOff(host);
  await expect(host.locator('#sessionStatus')).toHaveText('Reconnecting…');
  await expect(host.locator('#localVideo')).toBeVisible();
  await expect(viewer.locator('#sessionStatus')).toHaveText('Sharer reconnecting');
  await expect(viewer.locator('#stageOverlay')).toBeHidden();
  await flowing(viewer);
  await host.waitForTimeout(2500);
  await expect(viewer.locator('#sessionStatus')).toHaveText('Sharer reconnecting');
  await flowing(viewer);
  await restore(host);
  await live(host, viewer);
  expect([await peers(host), await peers(viewer)]).toEqual(before);
  // Pause still works straight after.
  await host.locator('#pauseBtn').click();
  await expect(viewer.locator('#stageTitle')).toHaveText('Sharing paused');
  await host.getByRole('button', { name: 'Resume', exact: true }).click();
  await live(host, viewer);
  expect(unexpected(errors)).toEqual([]);
});

test('a socket that stays down past the grace period ends cleanly; a refresh still starts a fresh connection', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  // Viewer refresh: a new page has no video connection to keep, so it gets a new one.
  const before = await peers(host);
  await viewer.reload();
  await live(host, viewer);
  expect(await peers(host)).toBe(before + 1);
  // The sharer is gone for good: the viewer sees it, then the room ends.
  await cutOff(host);
  await expect(viewer.locator('#sessionStatus')).toHaveText('Sharer reconnecting');
  await expect(viewer.locator('#home')).toBeVisible({ timeout: 15000 });
  await expect(viewer.locator('#message')).toContainText('sharer left');
  // The sharer keeps trying for its whole reconnect window, then explains.
  await expect(host.locator('#home')).toBeVisible({ timeout: 30000 });
  await expect(host.locator('#message')).toContainText('Connection lost');
  await tracksStopped(host);
  expect(unexpected(errors)).toEqual([]);
});

test('a dropped network path is repaired in place, without a new connection', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  const before = [await peers(host), await peers(viewer)];
  const ufrag = () => viewer.evaluate(() => /a=ice-ufrag:(\S+)/.exec(window.captureTest.peers.at(-1).remoteDescription.sdp)[1]);
  const original = await ufrag();
  // Loopback never really drops, so the sharer's browser is told the path went
  // down; the restart offer and answer that follow are real.
  await host.evaluate(() => {
    const pc = window.captureTest.peers.at(-1);
    Object.defineProperty(pc, 'connectionState', { configurable: true, get: () => 'disconnected' });
    pc.dispatchEvent(new Event('connectionstatechange'));
  });
  await expect.poll(ufrag).not.toBe(original);
  await host.evaluate(() => {
    const pc = window.captureTest.peers.at(-1);
    delete pc.connectionState;
    pc.dispatchEvent(new Event('connectionstatechange'));
  });
  await live(host, viewer);
  await flowing(viewer);
  expect([await peers(host), await peers(viewer)]).toEqual(before);
  expect(unexpected(errors)).toEqual([]);
});

test('lighter on the sharer: capped capture, H.264 first, a shared budget, and nothing sent to people who look away', async ({ browser }) => {
  const errors = [];
  const { host, viewer, code } = await startPair(browser, errors);
  const constraints = await host.evaluate(() => window.captureTest.constraints);
  expect(constraints.audio).toBe(false);
  expect(constraints.video.width.max).toBe(1920);
  expect(constraints.video.height.max).toBe(1080);
  expect(await host.evaluate(() => window.captureTest.streams.at(-1).getVideoTracks()[0].contentHint)).toBe('detail');
  // The video arrives as H.264 when both browsers can use it.
  await expect.poll(() => viewer.evaluate(async () => {
    const stats = await window.captureTest.peers.at(-1).getStats();
    const inbound = [...stats.values()].find((item) => item.type === 'inbound-rtp' && item.kind === 'video');
    return inbound && stats.get(inbound.codecId)?.mimeType;
  })).toBe('video/H264');
  await expect.poll(() => senders(host)).toEqual([{ active: true, maxBitrate: 2500000, maxFramerate: 20 }]);

  // More viewers: each gets a little less, so the total stays bounded.
  const others = [];
  for (let i = 0; i < 4; i++) {
    const page = await newPage(browser, errors);
    await page.goto('/?room=' + code);
    others.push(page);
  }
  await expect(host.locator('#sessionStatus')).toHaveText('5 viewers connected', { timeout: 30000 });
  await expect.poll(() => senders(host)).toEqual(Array(5).fill({ active: true, maxBitrate: 1200000, maxFramerate: 12 }));
  await live(host, viewer).catch(() => {});
  await expect(viewer.locator('#sessionStatus')).toHaveText('Live');
  await flowing(viewer);

  // The viewer switches tabs: the sharer stops sending to them, and the rest get a bit more.
  const hide = (page, hidden) => page.evaluate((hidden) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await hide(viewer, true);
  await expect.poll(async () => (await senders(host)).filter((item) => !item.active).length).toBe(1);
  await expect.poll(async () => (await senders(host)).filter((item) => item.active).every((item) => item.maxFramerate === 15)).toBe(true);
  // Nothing new arrives while away.
  await viewer.waitForTimeout(500);
  const paused = await frames(viewer);
  await viewer.waitForTimeout(1500);
  expect(await frames(viewer)).toBeLessThanOrEqual(paused + 2);
  // Back again: video resumes straight away.
  await hide(viewer, false);
  await flowing(viewer);
  await expect.poll(async () => (await senders(host)).every((item) => item.active)).toBe(true);

  // Popped out into picture-in-picture, a hidden tab is still watching.
  await viewer.evaluate(() => {
    const video = document.querySelector('#remoteVideo');
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => video });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    video.dispatchEvent(new Event('enterpictureinpicture'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await viewer.waitForTimeout(500);
  expect((await senders(host)).every((item) => item.active)).toBe(true);
  await flowing(viewer);

  // Whoever takes the floor is never "away" from their own screen.
  await hide(others[0], true);
  await expect.poll(async () => (await senders(host)).filter((item) => !item.active).length).toBe(1);
  await host.locator('#flipBtn').click();
  await hide(others[0], false);
  await others[0].locator('#acceptFlipBtn').click();
  await expect(others[0].locator('#sessionStatus')).toHaveText('5 viewers connected', { timeout: 30000 });
  await expect.poll(() => senders(others[0])).toEqual(Array(5).fill({ active: true, maxBitrate: 1200000, maxFramerate: 12 }));
  expect(unexpected(errors)).toEqual([]);
});

test('a still laser pointer stops redrawing; moving or resizing draws it again', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await host.locator('#laserBtn').click();
  await viewer.locator('#laserBtn').click();
  await expect(viewer.locator('#laserCanvas')).toHaveClass(/pointing/);
  const box = await viewer.locator('#laserCanvas').boundingBox();
  await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await viewer.evaluate(() => {
    window.frameCount = 0;
    const native = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => { window.frameCount++; return native(callback); };
  });
  await viewer.waitForTimeout(1000);
  // A solid orb that isn't moving needs no new frames.
  expect(await viewer.evaluate(() => window.frameCount)).toBeLessThan(5);
  const lit = () => viewer.evaluate(() => {
    const canvas = document.querySelector('#laserCanvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 200) return true;
    return false;
  });
  expect(await lit()).toBe(true);
  // Resizing repaints it at the new size.
  await viewer.setViewportSize({ width: 900, height: 600 });
  await expect.poll(() => viewer.evaluate(() => document.querySelector('#laserCanvas').width)).toBe(900);
  await expect.poll(lit).toBe(true);
  // Animated lasers keep animating.
  await viewer.locator('#peopleBtn').click();
  await viewer.locator('.style-option[data-style="rainbow"]').click();
  await viewer.keyboard.press('Escape');
  const box2 = await viewer.locator('#laserCanvas').boundingBox();
  await viewer.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2, { steps: 3 });
  await viewer.evaluate(() => { window.frameCount = 0; });
  await viewer.waitForTimeout(1000);
  expect(await viewer.evaluate(() => window.frameCount)).toBeGreaterThan(20);
  expect(unexpected(errors)).toEqual([]);
});

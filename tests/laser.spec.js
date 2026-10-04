import { test, expect } from '@playwright/test';
import { newPage, startPair, live, flip } from './helpers.js';

test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });

// Pixels are read straight from the laser canvases (the floating window, the
// sharer's preview and the viewer's own overlay), so these tests check what
// people would actually see, end to end over the real WebRTC data channel.

test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
});

// Strongest laser-red alpha (0–255) within a few pixels of a normalized video point.
async function laserAt(page, where, x, y) {
  return page.evaluate(async ({ where, x, y }) => {
    const { contentRect } = await import('/laser.js');
    let canvas, video;
    if (where === 'pip') {
      const doc = window.documentPictureInPicture?.window?.document;
      if (!doc) return -1;
      canvas = doc.querySelector('canvas');
      video = doc.querySelector('video');
    } else {
      canvas = document.querySelector('#laserCanvas');
      video = document.querySelector(document.body.classList.contains('is-viewer') ? '#remoteVideo' : '#localVideo');
    }
    const rect = contentRect(video, canvas.width, canvas.height);
    if (!rect) return -1;
    const ratio = canvas.width / Math.max(1, canvas.clientWidth);
    const radius = Math.ceil(5 * ratio);
    const cx = Math.round(rect.x + x * rect.width), cy = Math.round(rect.y + y * rect.height);
    const left = Math.max(0, cx - radius), top = Math.max(0, cy - radius);
    const data = canvas.getContext('2d').getImageData(left, top, radius * 2 + 1, radius * 2 + 1).data;
    let best = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 150 && data[i + 1] < 140 && data[i + 2] < 140) best = Math.max(best, data[i + 3]);
    }
    return best;
  }, { where, x, y });
}

async function anyLaser(page, where) {
  return page.evaluate((where) => {
    const doc = where === 'pip' ? window.documentPictureInPicture?.window?.document : document;
    const canvas = doc?.querySelector(where === 'pip' ? 'canvas' : '#laserCanvas');
    if (!canvas?.width || !canvas.height) return false;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  }, where);
}

// Viewport coordinates of a normalized point on the viewer's video.
async function screenPoint(viewer, x, y) {
  return viewer.evaluate(async ({ x, y }) => {
    const { contentRect } = await import('/laser.js');
    const box = document.querySelector('#laserCanvas').getBoundingClientRect();
    const rect = contentRect(document.querySelector('#remoteVideo'), box.width, box.height);
    return { x: box.left + rect.x + x * rect.width, y: box.top + rect.y + y * rect.height };
  }, { x, y });
}

async function moveTo(viewer, x, y, steps = 1) {
  const target = await screenPoint(viewer, x, y);
  await viewer.mouse.move(target.x, target.y, { steps });
}

const pipOpen = (page) => page.evaluate(() => Boolean(window.documentPictureInPicture?.window));

async function laserOn(host, viewer) {
  await host.locator('#laserBtn').click();
  await expect(host.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'true');
  await expect(host.locator('#laserLabel')).toHaveText('Laser on');
  await expect(viewer.locator('#laserBtn')).toBeVisible();
  await expect(viewer.locator('#message')).toContainText('turned on the laser pointer');
}

async function startPointing(viewer) {
  await viewer.locator('#laserBtn').click();
  await expect(viewer.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('#laserCanvas')).toHaveClass(/pointing/);
  await expect.poll(() => viewer.evaluate(() => window.captureTest.channels.at(-1)?.readyState)).toBe('open');
}

async function expectLaserOff(host, viewer) {
  await expect.poll(() => pipOpen(host)).toBe(false);
  await expect(host.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'false');
  await expect(host.locator('#laserLabel')).toHaveText('Laser pointer');
  await expect(viewer.locator('#laserBtn')).toBeHidden();
  await expect(viewer.locator('#laserCanvas')).not.toHaveClass(/pointing/);
  await expect.poll(() => anyLaser(host, 'stage')).toBe(false);
  await expect.poll(() => anyLaser(viewer, 'stage')).toBe(false);
}

async function sendRaw(viewer, payload) {
  await viewer.evaluate((payload) => window.captureTest.channels.at(-1).send(payload), payload);
}

test('one click opts in: floating window opens, viewer is invited, and the orb follows the pointer', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await expect(host.locator('#laserBtn')).toBeVisible();
  await expect(host.locator('#laserBtn')).toBeEnabled();
  await expect(viewer.locator('#laserBtn')).toBeHidden();
  expect(await pipOpen(host)).toBe(false);

  await laserOn(host, viewer);
  await expect.poll(() => pipOpen(host)).toBe(true);
  // The floating window shows the live screen, not an empty frame.
  await expect.poll(() => host.evaluate(() => {
    const video = documentPictureInPicture.window.document.querySelector('video');
    return video.readyState >= 2 && video.videoWidth > 0 && !video.paused;
  })).toBe(true);
  expect(await host.evaluate(() => documentPictureInPicture.window.document.body.textContent)).toContain('Laser pointer on');
  await expect(host.locator('#sessionHint')).toContainText('floating window');

  // Allowed is not the same as pointing: the viewer still chooses.
  await expect(viewer.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'false');
  await expect(viewer.locator('#laserCanvas')).not.toHaveClass(/pointing/);
  await moveTo(viewer, 0.25, 0.3);
  await viewer.waitForTimeout(250);
  expect(await anyLaser(host, 'pip')).toBe(false);

  await startPointing(viewer);
  expect(await viewer.locator('#laserCanvas').evaluate((canvas) => getComputedStyle(canvas).cursor)).toBe('none');
  await moveTo(viewer, 0.25, 0.3, 3);
  await expect.poll(() => laserAt(host, 'pip', 0.25, 0.3)).toBeGreaterThan(200);
  await expect.poll(() => laserAt(host, 'stage', 0.25, 0.3)).toBeGreaterThan(200);
  await expect.poll(() => laserAt(viewer, 'stage', 0.25, 0.3)).toBeGreaterThan(200);
  expect(await laserAt(host, 'pip', 0.75, 0.7)).toBe(0);

  // The orb tracks the pointer to the opposite corner.
  await moveTo(viewer, 0.8, 0.75, 4);
  await expect.poll(() => laserAt(host, 'pip', 0.8, 0.75)).toBeGreaterThan(200);
  await expect.poll(() => laserAt(host, 'pip', 0.25, 0.3)).toBe(0);

  // Moving into the letterbox, or off the video, hides the orb for both people.
  const box = await viewer.locator('#laserCanvas').boundingBox();
  await viewer.mouse.move(box.x + box.width / 2, box.y + 20);
  await expect.poll(() => anyLaser(host, 'pip')).toBe(false);
  await expect.poll(() => anyLaser(viewer, 'stage')).toBe(false);
  await moveTo(viewer, 0.5, 0.5);
  await expect.poll(() => laserAt(host, 'pip', 0.5, 0.5)).toBeGreaterThan(200);
  await viewer.locator('#leaveBtn').hover();
  await expect.poll(() => anyLaser(host, 'pip')).toBe(false);
  expect(errors).toEqual([]);
});

test('click and drag leaves a trail that fades smoothly and quickly, with a pulse on press', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await laserOn(host, viewer);
  await startPointing(viewer);
  await moveTo(viewer, 0.2, 0.5);
  await expect.poll(() => laserAt(host, 'pip', 0.2, 0.5)).toBeGreaterThan(200);
  expect(await host.evaluate(() => documentPictureInPicture.window.document.querySelector('.frame').classList.contains('flash'))).toBe(false);

  // Watch, frame by frame, a spot beyond the orb's glow for the expanding press ring.
  await host.evaluate(async () => {
    const { contentRect } = await import('/laser.js');
    const win = documentPictureInPicture.window;
    const canvas = win.document.querySelector('canvas'), video = win.document.querySelector('video');
    const ratio = canvas.width / canvas.clientWidth;
    window.ringSamples = [];
    const start = performance.now();
    const sample = () => {
      const rect = contentRect(video, canvas.width, canvas.height);
      const x = Math.round(rect.x + 0.2 * rect.width - 28 * ratio), y = Math.round(rect.y + 0.5 * rect.height);
      const data = canvas.getContext('2d').getImageData(x - 3, y - 3, 7, 7).data;
      let best = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] > 150 && data[i + 1] < 140) best = Math.max(best, data[i + 3]);
      window.ringSamples.push(best);
      if (performance.now() - start < 1500) win.requestAnimationFrame(sample);
    };
    sample();
  });
  await viewer.mouse.down();
  await expect.poll(() => host.evaluate(() => documentPictureInPicture.window.document.querySelector('.frame').classList.contains('flash'))).toBe(true);
  await expect.poll(() => host.evaluate(() => window.ringSamples.length > 0 && window.ringSamples.at(-1) === 0 && window.ringSamples.some((alpha) => alpha > 0))).toBe(true);
  expect(await host.evaluate(() => window.ringSamples[0])).toBe(0);
  await moveTo(viewer, 0.8, 0.5, 10);
  await viewer.mouse.up();
  const watch = (page) => page.evaluate(async () => {
    const { contentRect } = await import('/laser.js');
    const win = window.documentPictureInPicture?.window || window;
    const doc = win.document;
    const canvas = doc.querySelector(win === window ? '#laserCanvas' : 'canvas');
    const video = doc.querySelector(win === window ? '#remoteVideo' : 'video');
    const alpha = () => {
      const rect = contentRect(video, canvas.width, canvas.height);
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      const data = canvas.getContext('2d').getImageData(x - 4, y - 4, 9, 9).data;
      let best = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] > 150 && data[i + 1] < 140) best = Math.max(best, data[i + 3]);
      return best;
    };
    const start = performance.now();
    const samples = [];
    while (performance.now() - start < 1300) {
      samples.push([performance.now() - start, alpha()]);
      await new Promise((resolve) => win.requestAnimationFrame(resolve));
    }
    return samples;
  });
  const [sharerSamples, viewerSamples] = await Promise.all([watch(host), watch(viewer)]);
  for (const samples of [sharerSamples, viewerSamples]) {
    expect(samples[0][1]).toBeGreaterThan(0);
    const gone = samples.find(([, alpha]) => alpha === 0);
    expect(gone, 'trail should vanish').toBeTruthy();
    expect(gone[0]).toBeLessThan(900);
    expect(samples.filter(([time]) => time > gone[0]).every(([, alpha]) => alpha === 0)).toBe(true);
    // Smooth, not a blink: several distinct fading steps, never brightening.
    const fading = samples.filter(([time]) => time < gone[0]).map(([, alpha]) => alpha);
    expect(new Set(fading).size).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < fading.length; i++) expect(fading[i]).toBeLessThanOrEqual(fading[i - 1] + 2);
  }
  // The orb stays where the drag ended.
  expect(await laserAt(host, 'pip', 0.8, 0.5)).toBeGreaterThan(200);

  // A second stroke does not join up with the first.
  await viewer.mouse.down();
  await moveTo(viewer, 0.8, 0.2, 6);
  await viewer.mouse.up();
  expect(await laserAt(host, 'pip', 0.5, 0.5)).toBe(0);
  await expect.poll(() => laserAt(host, 'pip', 0.8, 0.35)).toBeGreaterThan(0);

  // Dragging past the edge keeps the line on the edge instead of losing it.
  await viewer.mouse.down();
  const box = await viewer.locator('#laserCanvas').boundingBox();
  await viewer.mouse.move(box.x + box.width - 2, box.y + 10, { steps: 5 });
  await expect.poll(() => laserAt(host, 'pip', 1, 0)).toBeGreaterThan(0);
  await viewer.mouse.up();
  await expect.poll(() => anyLaser(host, 'pip')).toBe(false);
  expect(errors).toEqual([]);
});

test('the sharer can turn it off from the button, the floating window, or by closing it, and must opt in again', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  const ways = [
    ['toolbar button', () => host.locator('#laserBtn').click()],
    ['Turn off in the floating window', () => host.evaluate(() => documentPictureInPicture.window.document.querySelector('button').click())],
    ['closing the floating window', () => host.evaluate(() => documentPictureInPicture.window.close())]
  ];
  for (const [, turnOff] of ways) {
    await laserOn(host, viewer);
    await expect.poll(() => pipOpen(host)).toBe(true);
    await startPointing(viewer);
    await moveTo(viewer, 0.4, 0.4, 2);
    await expect.poll(() => laserAt(host, 'pip', 0.4, 0.4)).toBeGreaterThan(200);
    // Turn off mid-drag: nothing is left behind on either side.
    await viewer.mouse.down();
    await moveTo(viewer, 0.5, 0.5, 3);
    await turnOff();
    await expectLaserOff(host, viewer);
    await expect(viewer.locator('#message')).toContainText('turned off the laser pointer');
    await moveTo(viewer, 0.6, 0.6, 3);
    await viewer.mouse.up();
    await expect.poll(() => anyLaser(viewer, 'stage')).toBe(false);
    // Stray messages after it's off are ignored by the sharer.
    await sendRaw(viewer, JSON.stringify({ x: 0.3, y: 0.3, d: 0 }));
    await host.waitForTimeout(150);
    expect(await anyLaser(host, 'stage')).toBe(false);
  }
  // Turning it back on asks the viewer to choose again rather than pointing at once.
  await laserOn(host, viewer);
  await expect(viewer.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'false');
  await expect(viewer.locator('#laserCanvas')).not.toHaveClass(/pointing/);
  expect(errors).toEqual([]);
});

test('sharer ignores pointer data it has not allowed, and malformed data', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await expect.poll(() => viewer.evaluate(() => window.captureTest.channels.at(-1)?.readyState)).toBe('open');
  await sendRaw(viewer, JSON.stringify({ x: 0.5, y: 0.5, d: 1 }));
  await host.waitForTimeout(200);
  expect(await anyLaser(host, 'stage')).toBe(false);

  // A viewer cannot grant itself permission through the server.
  await viewer.evaluate(() => window.captureTest.sockets.at(-1).send(JSON.stringify({ type: 'laser', on: true, id: 1 })));
  await viewer.waitForTimeout(200);
  await expect(viewer.locator('#laserBtn')).toBeHidden();
  await expect(host.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'false');

  await laserOn(host, viewer);
  for (const junk of ['', '{', 'null', '[]', '42', '"x"', '{"x":"0.5","y":0.5}', '{"x":0.5}', '{"x":null,"y":null}', '{"h":2}', 'x'.repeat(5000)]) {
    await sendRaw(viewer, junk);
  }
  await host.waitForTimeout(200);
  expect(await anyLaser(host, 'stage')).toBe(false);
  expect(await anyLaser(host, 'pip')).toBe(false);
  // Out-of-range values are pinned to the edge of the screen, never off it.
  await sendRaw(viewer, JSON.stringify({ x: 7, y: -3, d: 0 }));
  await expect.poll(() => laserAt(host, 'pip', 1, 0)).toBeGreaterThan(100);
  await sendRaw(viewer, '{"h":1}');
  await expect.poll(() => anyLaser(host, 'pip')).toBe(false);
  expect(errors).toEqual([]);
});

test('pause suspends pointing for both people; resume restores it without opting in again', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await laserOn(host, viewer);
  await startPointing(viewer);
  await moveTo(viewer, 0.5, 0.5, 2);
  await expect.poll(() => laserAt(host, 'pip', 0.5, 0.5)).toBeGreaterThan(200);

  await host.locator('#pauseBtn').click();
  await expect(viewer.locator('#stageTitle')).toHaveText('Sharing paused');
  await expect(viewer.locator('#laserBtn')).toBeDisabled();
  await expect(viewer.locator('#laserCanvas')).not.toHaveClass(/pointing/);
  await expect.poll(() => anyLaser(host, 'pip')).toBe(false);
  await expect.poll(() => host.evaluate(() => documentPictureInPicture.window.document.querySelector('.paused').hidden)).toBe(false);
  await sendRaw(viewer, JSON.stringify({ x: 0.3, y: 0.3, d: 0 }));
  await host.waitForTimeout(200);
  expect(await anyLaser(host, 'pip')).toBe(false);
  expect(await pipOpen(host)).toBe(true);
  await expect(host.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'true');

  await host.getByRole('button', { name: 'Resume', exact: true }).click();
  await live(host, viewer);
  await expect.poll(() => host.evaluate(() => documentPictureInPicture.window.document.querySelector('.paused').hidden)).toBe(true);
  await expect(viewer.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('#laserCanvas')).toHaveClass(/pointing/);
  await moveTo(viewer, 0.3, 0.6, 3);
  await expect.poll(() => laserAt(host, 'pip', 0.3, 0.6)).toBeGreaterThan(200);
  expect(errors).toEqual([]);
});

test('flipping turns the laser off and closes the floating window; the new sharer can opt in', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await laserOn(host, viewer);
  await startPointing(viewer);
  await flip(host, viewer);
  await expect.poll(() => pipOpen(host)).toBe(false);
  // Roles swapped: the old viewer now owns the switch, which starts off.
  await expect(viewer.locator('#laserBtn')).toBeVisible();
  await expect(viewer.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'false');
  await expect(viewer.locator('#laserLabel')).toHaveText('Laser pointer');
  await expect(host.locator('#laserBtn')).toBeHidden();
  await expect(host.locator('#laserCanvas')).not.toHaveClass(/pointing/);

  await laserOn(viewer, host);
  await expect.poll(() => pipOpen(viewer)).toBe(true);
  await startPointing(host);
  await moveTo(host, 0.6, 0.4, 3);
  await expect.poll(() => laserAt(viewer, 'pip', 0.6, 0.4)).toBeGreaterThan(200);
  await flip(viewer, host);
  await expect.poll(() => pipOpen(viewer)).toBe(false);
  await expect(viewer.locator('#laserBtn')).toBeHidden();
  expect(errors).toEqual([]);
});

test('viewer refresh and sharer reconnect keep the laser; sharer refresh turns it off', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await laserOn(host, viewer);
  await viewer.reload();
  await live(host, viewer);
  await expect(viewer.locator('#laserBtn')).toBeVisible();
  await expect(viewer.locator('#message')).toContainText('turned on the laser pointer');
  await startPointing(viewer);
  await moveTo(viewer, 0.5, 0.5, 2);
  await expect.poll(() => laserAt(host, 'pip', 0.5, 0.5)).toBeGreaterThan(200);

  // A dropped socket is not a refresh: the floating window stays and so does the laser.
  await host.evaluate(() => window.captureTest.sockets.at(-1).close());
  await expect(host.locator('#sessionStatus')).toHaveText('Reconnecting…');
  await live(host, viewer);
  expect(await pipOpen(host)).toBe(true);
  await expect(host.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => viewer.evaluate(() => window.captureTest.channels.at(-1)?.readyState)).toBe('open');
  await moveTo(viewer, 0.3, 0.3, 3);
  await expect.poll(() => laserAt(host, 'pip', 0.3, 0.3)).toBeGreaterThan(200);

  // A refresh closes the floating window, so the laser turns off with it.
  await host.reload();
  await expect(viewer.locator('#laserBtn')).toBeHidden();
  await expect(viewer.locator('#laserCanvas')).not.toHaveClass(/pointing/);
  await host.locator('#resumeBtn').click();
  await live(host, viewer);
  await expect(host.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'false');
  await expect(viewer.locator('#laserBtn')).toBeHidden();
  await laserOn(host, viewer);
  expect(errors).toEqual([]);
});

test('a new viewer is invited when the laser is already on; ending the room closes the window', async ({ browser }) => {
  const errors = [];
  const { host, viewer, code } = await startPair(browser, errors);
  await laserOn(host, viewer);
  await viewer.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(host.locator('#sessionStatus')).toHaveText('Waiting for viewer');
  expect(await pipOpen(host)).toBe(true);
  const next = await newPage(browser, errors);
  await next.goto('/?room=' + code);
  await live(host, next);
  await expect(next.locator('#laserBtn')).toBeVisible();
  await expect(next.locator('#message')).toContainText('turned on the laser pointer');
  await startPointing(next);
  await moveTo(next, 0.7, 0.3, 3);
  await expect.poll(() => laserAt(host, 'pip', 0.7, 0.3)).toBeGreaterThan(200);
  await host.locator('#leaveBtn').click();
  await expect.poll(() => pipOpen(host)).toBe(false);
  await expect(next.locator('#home')).toBeVisible();
  expect(errors).toEqual([]);
});

test('without a floating window the laser still works in the sharer preview', async ({ browser }) => {
  const errors = [];
  const host = await newPage(browser, errors);
  await host.addInitScript(() => { delete window.documentPictureInPicture; });
  const viewer = await newPage(browser, errors);
  await host.goto('/');
  await host.locator('#startBtn').click();
  await expect(host.locator('#roomCode')).toHaveText(/^\d{6}$/);
  await viewer.goto('/?room=' + await host.locator('#roomCode').textContent());
  await live(host, viewer);
  await host.locator('#laserBtn').click();
  await expect(host.locator('#message')).toContainText('can’t float a window');
  await expect(host.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'true');
  await startPointing(viewer);
  await moveTo(viewer, 0.35, 0.65, 3);
  await expect.poll(() => laserAt(host, 'stage', 0.35, 0.65)).toBeGreaterThan(200);
  await host.locator('#laserBtn').click();
  await expect(viewer.locator('#laserBtn')).toBeHidden();
  await expect.poll(() => anyLaser(host, 'stage')).toBe(false);
  expect(errors).toEqual([]);
});

test('a refused floating window still leaves the laser on in the preview', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await host.evaluate(() => {
    documentPictureInPicture.requestWindow = () => Promise.reject(new DOMException('No activation', 'NotAllowedError'));
  });
  await laserOn(host, viewer);
  await expect(host.locator('#message')).toContainText('couldn’t open');
  await startPointing(viewer);
  await moveTo(viewer, 0.5, 0.5, 2);
  await expect.poll(() => laserAt(host, 'stage', 0.5, 0.5)).toBeGreaterThan(200);
  expect(errors).toEqual([]);
});

test('Escape stops pointing; the viewer controls fit small screens', async ({ browser }, testInfo) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors);
  await laserOn(host, viewer);
  await startPointing(viewer);
  await moveTo(viewer, 0.5, 0.5, 2);
  await expect.poll(() => laserAt(host, 'pip', 0.5, 0.5)).toBeGreaterThan(200);
  await viewer.keyboard.press('Escape');
  await expect(viewer.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'false');
  await expect(viewer.locator('#laserCanvas')).not.toHaveClass(/pointing/);
  await expect.poll(() => anyLaser(host, 'pip')).toBe(false);
  // Without pointing, clicks reach the page normally again.
  expect(await viewer.locator('#laserCanvas').evaluate((canvas) => getComputedStyle(canvas).pointerEvents)).toBe('none');

  await startPointing(viewer);
  await moveTo(viewer, 0.5, 0.5, 2);
  await viewer.screenshot({ path: testInfo.outputPath('laser-viewer-desktop.png') });
  await host.screenshot({ path: testInfo.outputPath('laser-sharer-desktop.png'), fullPage: true });
  for (const width of [320, 375, 768]) {
    for (const page of [host, viewer]) {
      await page.setViewportSize({ width, height: 700 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('#laserBtn')).toBeVisible();
    }
    const overlap = await viewer.evaluate(() => {
      const [badge, laser, leave] = ['#statusBadge', '#laserBtn', '#leaveBtn'].map((id) => document.querySelector(id).getBoundingClientRect());
      const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return { badgeLaser: hits(badge, laser), laserLeave: hits(laser, leave), right: leave.right, width: innerWidth };
    });
    expect(overlap.badgeLaser).toBe(false);
    expect(overlap.laserLeave).toBe(false);
    expect(overlap.right).toBeLessThanOrEqual(overlap.width);
  }
  await viewer.screenshot({ path: testInfo.outputPath('laser-viewer-320.png') });
  // Resizing the viewer keeps pointing aligned with the shared screen.
  await moveTo(viewer, 0.25, 0.25, 3);
  await expect.poll(() => laserAt(host, 'pip', 0.25, 0.25)).toBeGreaterThan(200);
  expect(errors).toEqual([]);
});

test('touch: pressing shows the orb and draws, lifting hides the orb', async ({ browser }) => {
  const errors = [];
  const { host, viewer } = await startPair(browser, errors, { hasTouch: true });
  await laserOn(host, viewer);
  await startPointing(viewer);
  const cdp = await viewer.context().newCDPSession(viewer);
  const touch = async (type, x, y) => {
    const at = await screenPoint(viewer, x, y);
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: at.x, y: at.y }] });
  };
  await touch('touchStart', 0.3, 0.5);
  await expect.poll(() => laserAt(host, 'pip', 0.3, 0.5)).toBeGreaterThan(200);
  for (let i = 1; i <= 8; i++) await touch('touchMove', 0.3 + i * 0.05, 0.5);
  await expect.poll(() => laserAt(host, 'pip', 0.7, 0.5)).toBeGreaterThan(200);
  expect(await laserAt(host, 'pip', 0.5, 0.5)).toBeGreaterThan(0);
  await touch('touchEnd');
  await expect.poll(() => anyLaser(host, 'pip')).toBe(false);
  await expect.poll(() => anyLaser(viewer, 'stage')).toBe(false);
  expect(errors).toEqual([]);
});

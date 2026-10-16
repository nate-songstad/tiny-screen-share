import { test, expect } from '@playwright/test';
import { newPage, live, tracksStopped } from './helpers.js';

test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });
// Several real browser sessions, each decoding its own video.
test.setTimeout(150000);

test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts()) await context.close();
});

const frames = (page) => page.locator('#remoteVideo').evaluate((video) => video.getVideoPlaybackQuality().totalVideoFrames);

// A viewer is watching when its own video is live and still receiving new frames.
async function watching(viewer) {
  await expect(viewer.locator('#sessionStatus')).toHaveText('Live');
  await expect(viewer.locator('#stageOverlay')).toBeHidden();
  const start = await frames(viewer);
  await expect.poll(() => frames(viewer)).toBeGreaterThan(start + 2);
}

function connectedText(count) { return count === 1 ? 'Viewer connected' : `${count} viewers connected`; }

async function startGroup(browser, errors, count) {
  const host = await newPage(browser, errors);
  await host.goto('/');
  await host.locator('#startBtn').click();
  await expect(host.locator('#roomCode')).toHaveText(/^\d{6}$/);
  const code = await host.locator('#roomCode').textContent();
  const viewers = [];
  for (let i = 1; i < count; i++) {
    const viewer = await newPage(browser, errors);
    await viewer.goto('/?room=' + code);
    viewers.push(viewer);
  }
  await expect(host.locator('#sessionStatus')).toHaveText(connectedText(count - 1), { timeout: 30000 });
  for (const viewer of viewers) await watching(viewer);
  return { host, viewers, code };
}

const peers = (page) => page.evaluate(() => window.captureTest.peers.length);

async function names(page) {
  await page.locator('#peopleBtn').click();
  await expect(page.locator('#peoplePanel')).toBeVisible();
  const list = await page.locator('#peopleList .person').evaluateAll((items) => items.map((item) => ({
    name: item.querySelector('.person-name').textContent,
    tags: [...item.querySelectorAll('.person-tag')].map((tag) => tag.textContent),
    swatch: item.querySelector('.person-dot').style.getPropertyValue('--swatch')
  })));
  await page.keyboard.press('Escape');
  await expect(page.locator('#peoplePanel')).toBeHidden();
  return list;
}

async function setName(page, name) {
  if (!await page.locator('#peoplePanel').isVisible()) await page.locator('#peopleBtn').click();
  await page.locator('#nameInput').fill(name);
  await page.locator('#nameInput').press('Enter');
}

async function pickStyle(page, id) {
  if (!await page.locator('#peoplePanel').isVisible()) await page.locator('#peopleBtn').click();
  await page.locator(`.style-option[data-style="${id}"]`).click();
  await expect(page.locator(`.style-option[data-style="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
}

// The strongest strongly coloured pixel near a normalized point on a laser canvas.
async function colorAt(page, where, x, y) {
  return page.evaluate(async ({ where, x, y }) => {
    const { contentRect } = await import('/laser.js');
    const doc = where === 'pip' ? window.documentPictureInPicture?.window?.document : document;
    if (!doc) return null;
    const canvas = doc.querySelector(where === 'pip' ? 'canvas' : '#laserCanvas');
    const video = where === 'pip' ? doc.querySelector('video')
      : document.querySelector(document.body.classList.contains('is-viewer') ? '#remoteVideo' : '#localVideo');
    const rect = contentRect(video, canvas.width, canvas.height);
    if (!rect) return null;
    const ratio = canvas.width / Math.max(1, canvas.clientWidth);
    const radius = Math.ceil(4 * ratio);
    const cx = Math.round(rect.x + x * rect.width), cy = Math.round(rect.y + y * rect.height);
    const data = canvas.getContext('2d').getImageData(cx - radius, cy - radius, radius * 2 + 1, radius * 2 + 1).data;
    let best = null;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60 && a > (best?.[3] || 200)) best = [r, g, b, a];
    }
    return best;
  }, { where, x, y });
}
function hueOf([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueGap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

async function moveTo(viewer, x, y, steps = 3) {
  const target = await viewer.evaluate(async ({ x, y }) => {
    const { contentRect } = await import('/laser.js');
    const box = document.querySelector('#laserCanvas').getBoundingClientRect();
    const rect = contentRect(document.querySelector('#remoteVideo'), box.width, box.height);
    return { x: box.left + rect.x + x * rect.width, y: box.top + rect.y + y * rect.height };
  }, { x, y });
  await viewer.mouse.move(target.x, target.y, { steps });
}

async function startPointing(viewer) {
  await expect(viewer.locator('#laserBtn')).toBeEnabled();
  await viewer.locator('#laserBtn').click();
  await expect(viewer.locator('#laserCanvas')).toHaveClass(/pointing/);
  await expect.poll(() => viewer.evaluate(() => window.captureTest.channels.at(-1)?.readyState)).toBe('open');
}

test('seven people watch at once; the eighth is turned away; joining, leaving and refreshing never interrupt the others', async ({ browser }) => {
  const errors = [];
  const { host, viewers, code } = await startGroup(browser, errors, 7);
  await expect(host.locator('#peopleCount')).toHaveText('7');
  await expect(host.locator('#sessionHint')).toContainText('full');
  for (const viewer of viewers) await expect(viewer.locator('#peopleCount')).toHaveText('7');
  const [first, second, third] = viewers;
  const firstPeers = await peers(first);

  const eighth = await newPage(browser, errors);
  await eighth.goto('/?room=' + code);
  await expect(eighth.locator('#message')).toContainText('full');
  await expect(eighth.locator('#home')).toBeVisible();

  // Someone leaves: the room makes space, nobody else reconnects.
  await viewers[5].getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(host.locator('#sessionStatus')).toHaveText('5 viewers connected');
  await expect(first.locator('#peopleCount')).toHaveText('6');
  await eighth.goto('/?room=' + code);
  await watching(eighth);
  await expect(host.locator('#sessionStatus')).toHaveText('6 viewers connected');

  // Someone refreshes: only they reconnect.
  await second.reload();
  await watching(second);
  await expect(host.locator('#sessionStatus')).toHaveText('6 viewers connected');
  // Someone's connection drops: the host shows them as reconnecting, then they're back.
  await third.evaluate(() => window.captureTest.sockets.at(-1).close());
  await watching(third);
  expect(await peers(first)).toBe(firstPeers);
  await watching(first);

  // Pause hides the screen from everyone at once.
  await host.locator('#pauseBtn').click();
  for (const viewer of [first, second, eighth]) await expect(viewer.locator('#stageTitle')).toHaveText('Sharing paused');
  await host.getByRole('button', { name: 'Resume', exact: true }).click();
  for (const viewer of [first, second, eighth]) await watching(viewer);

  // Ending from the sharer ends the room for everyone and frees the code.
  await host.locator('#leaveBtn').click();
  for (const viewer of [...viewers.slice(0, 5), eighth]) await expect(viewer.locator('#home')).toBeVisible();
  await tracksStopped(host);
  expect(errors).toEqual([]);
});

test('names are optional, added after joining, shown to everyone as plain text, and Anonymous otherwise', async ({ browser }) => {
  const errors = [];
  const { host, viewers } = await startGroup(browser, errors, 3);
  const [ada, quiet] = viewers;
  // Joining never asked for a name.
  const before = await names(host);
  expect(before.map((person) => person.name)).toEqual(['Anonymous', 'Anonymous', 'Anonymous']);
  expect(before[0].tags).toEqual(['you', 'sharing']);
  // Everyone's laser colour sits next to their name, all different.
  expect(new Set(before.map((person) => person.swatch)).size).toBe(3);

  // Opening the panel without a name goes straight to the name field.
  await ada.locator('#peopleBtn').click();
  await expect(ada.locator('#nameInput')).toBeFocused();
  await setName(ada, '<img src=x onerror=pwned=1>Ada');
  await expect.poll(async () => (await names(host)).map((person) => person.name)).toEqual(['Anonymous', '<img src=x onerror=pwned=1>Ada', 'Anonymous']);
  expect(await host.evaluate(() => Boolean(window.pwned) || document.querySelectorAll('#peopleList img').length)).toBe(0);
  await setName(ada, 'Ada');
  await expect.poll(async () => (await names(quiet)).map((person) => person.name)).toEqual(['Anonymous', 'Ada', 'Anonymous']);
  expect((await names(quiet))[2].tags).toEqual(['you']);

  // A name survives a refresh and can be removed again.
  await ada.reload();
  await watching(ada);
  expect((await names(host))[1].name).toBe('Ada');
  await ada.locator('#peopleBtn').click();
  await expect(ada.locator('#nameInput')).toHaveValue('Ada');
  await setName(ada, '   ');
  await expect.poll(async () => (await names(host))[1].name).toBe('Anonymous');
  await setName(ada, 'Ada');

  // The panel closes on outside clicks and Escape, and returns focus to its button.
  await host.locator('#peopleBtn').click();
  await host.locator('.screen-stage').click({ position: { x: 20, y: 20 } });
  await expect(host.locator('#peoplePanel')).toBeHidden();
  await host.locator('#peopleBtn').click();
  await host.locator('#nameInput').press('Escape');
  await expect(host.locator('#peoplePanel')).toBeHidden();
  await expect(host.locator('#peopleBtn')).toBeFocused();
  await expect(host.locator('#peopleBtn')).toHaveAttribute('aria-expanded', 'false');

  // Names show up where they matter: the flip prompt and the flip notice.
  await setName(host, 'Sam');
  await host.keyboard.press('Escape');
  await host.locator('#flipBtn').click();
  await expect(quiet.locator('#flipDescription')).toContainText('Sam is offering the floor');
  await ada.locator('#acceptFlipBtn').click();
  await expect(quiet.locator('#message')).toContainText('Ada is sharing now');
  await expect(ada.locator('#message')).toContainText('You’re now sharing');
  await expect(host.locator('#message')).toContainText('Ada is sharing now');
  await watching(quiet);
  await watching(host);
  expect(errors).toEqual([]);
});

test('the floor goes to whoever accepts first; a pass is just for you; others’ pickers are stopped', async ({ browser }) => {
  const errors = [];
  const { host, viewers } = await startGroup(browser, errors, 4);
  const [a, b, c] = viewers;
  await host.locator('#flipBtn').click();
  await expect(host.locator('#flipTitle')).toHaveText('Offering the floor to everyone');
  for (const viewer of viewers) await expect(viewer.locator('#flipPrompt')).toBeVisible();

  // Passing hides it only for that person.
  await c.locator('#declineFlipBtn').click();
  await expect(c.locator('#flipPrompt')).toBeHidden();
  await expect(a.locator('#flipPrompt')).toBeVisible();
  await expect(host.locator('#flipPrompt')).toBeVisible();

  // Two people reach for the floor; b chooses a screen first and wins.
  for (const viewer of [a, b]) await viewer.evaluate(() => { window.captureTest.mode = 'wait'; });
  await a.locator('#acceptFlipBtn').click();
  await b.locator('#acceptFlipBtn').click();
  await b.evaluate(() => window.captureTest.release());
  await expect(b.locator('#flipPrompt')).toBeHidden();
  await expect(b.locator('body')).not.toHaveClass('is-viewer');
  await expect(b.locator('#sessionStatus')).toHaveText('3 viewers connected', { timeout: 30000 });
  // a's picker finishes late: that capture is stopped straight away.
  await a.evaluate(() => window.captureTest.release());
  await expect.poll(() => a.evaluate(() => window.captureTest.streams.length)).toBe(1);
  await tracksStopped(a);
  await tracksStopped(host);
  for (const viewer of [host, a, c]) await watching(viewer);
  await expect(a.locator('#flipPrompt')).toBeHidden();

  // Everyone passing ends the request; the sharer can try again.
  await b.locator('#flipBtn').click();
  for (const viewer of [host, a, c]) await viewer.locator('#declineFlipBtn').click();
  await expect(b.locator('#message')).toContainText('Everyone passed');
  await expect(b.locator('#flipPrompt')).toBeHidden();
  await expect(b.locator('#flipBtn')).toBeEnabled();

  // A person leaving during a request doesn't cancel it for the rest.
  await b.locator('#flipBtn').click();
  await c.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(host.locator('#flipPrompt')).toBeVisible();
  await host.locator('#acceptFlipBtn').click();
  await expect(host.locator('#sessionStatus')).toHaveText('2 viewers connected', { timeout: 30000 });
  for (const viewer of [a, b]) await watching(viewer);
  expect(errors).toEqual([]);
});

test('every pointer has its own laser, everyone sees everyone’s, fun lasers are first come first served', async ({ browser }, testInfo) => {
  const errors = [];
  const { host, viewers } = await startGroup(browser, errors, 4);
  const [a, b, c] = viewers;
  await setName(a, 'Ada');
  await a.keyboard.press('Escape');

  // Each person's picker shows which lasers are taken, and by whom.
  await b.locator('#peopleBtn').click();
  await expect(b.locator('.style-option[data-style="blue"]')).toBeDisabled();
  await expect(b.locator('.style-option[data-style="blue"]')).toHaveAttribute('title', /taken by Ada/);
  await expect(b.locator('.style-option[data-style="amber"]')).toHaveAttribute('aria-pressed', 'true');
  await b.keyboard.press('Escape');
  await pickStyle(a, 'rainbow');
  // The moment it's taken, nobody else can choose it.
  await b.locator('#peopleBtn').click();
  await expect(b.locator('.style-option[data-style="rainbow"]')).toBeDisabled();
  await expect(b.locator('.style-option[data-style="blue"]')).toBeEnabled();
  await b.keyboard.press('Escape');
  // A request for a taken laser that slips through is refused by the server.
  await b.evaluate(() => window.captureTest.sockets.at(-1).send(JSON.stringify({ type: 'style', style: 'rainbow' })));
  await expect(b.locator('#message')).toContainText('already has that laser');
  await pickStyle(b, 'galaxy');

  await host.locator('#laserBtn').click();
  await expect(host.locator('#laserBtn')).toHaveAttribute('aria-pressed', 'true');
  for (const viewer of viewers) await expect(viewer.locator('#laserBtn')).toBeVisible();
  await startPointing(a);
  await startPointing(b);
  await moveTo(a, 0.25, 0.3);
  await moveTo(b, 0.75, 0.7);
  // The sharer sees both pointers, and so does someone who isn't pointing.
  for (const [page, where] of [[host, 'pip'], [host, 'stage'], [c, 'stage']]) {
    await expect.poll(() => colorAt(page, where, 0.25, 0.3)).not.toBeNull();
    await expect.poll(() => colorAt(page, where, 0.75, 0.7)).not.toBeNull();
  }
  await a.mouse.down();
  await moveTo(a, 0.4, 0.45, 8);
  await b.mouse.down();
  await moveTo(b, 0.6, 0.5, 8);
  await c.locator('.screen-stage').screenshot({ path: testInfo.outputPath('lasers-viewer.png') });
  await a.mouse.up();
  await b.mouse.up();
  await moveTo(a, 0.25, 0.3);
  await moveTo(b, 0.75, 0.7);
  // Each pointer sees the other one too.
  await expect.poll(() => colorAt(a, 'stage', 0.75, 0.7)).not.toBeNull();
  await expect.poll(() => colorAt(b, 'stage', 0.25, 0.3)).not.toBeNull();
  // Rainbow cycles through colours over time.
  const hues = new Set();
  for (let i = 0; i < 12 && hues.size < 3; i++) {
    const color = await colorAt(c, 'stage', 0.25, 0.3);
    if (color) hues.add(Math.round(hueOf(color) / 40));
    await c.waitForTimeout(120);
  }
  expect(hues.size).toBeGreaterThanOrEqual(3);
  // Galaxy stays in the purple range, never anything like someone else's solid colour.
  const galaxy = await colorAt(c, 'stage', 0.75, 0.7);
  expect(hueGap(hueOf(galaxy), 275)).toBeLessThan(55);

  // c picks a solid colour while pointing; it shows up in that colour.
  await pickStyle(c, 'teal');
  await startPointing(c);
  await moveTo(c, 0.5, 0.2);
  await expect.poll(async () => {
    const color = await colorAt(host, 'pip', 0.5, 0.2);
    return color ? hueGap(hueOf(color), 171) < 25 : false;
  }).toBe(true);

  // b leaves: b's pointer disappears for everyone straight away.
  await b.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect.poll(() => colorAt(host, 'pip', 0.75, 0.7)).toBeNull();
  await expect.poll(() => colorAt(a, 'stage', 0.75, 0.7)).toBeNull();
  await expect.poll(() => colorAt(c, 'stage', 0.75, 0.7)).toBeNull();
  await expect.poll(() => colorAt(host, 'pip', 0.25, 0.3)).not.toBeNull();
  // The galaxy b let go is free again.
  await c.locator('#peopleBtn').click();
  await expect(c.locator('.style-option[data-style="galaxy"]')).toBeEnabled();
  await c.keyboard.press('Escape');

  // A viewer can't move someone else's pointer: the sharer labels points by the
  // connection they arrive on, so a's claim to be c just moves a's own orb.
  await a.evaluate(() => window.captureTest.channels.at(-1).send(JSON.stringify({ x: 0.9, y: 0.9, d: 0, p: 'not-a' })));
  await expect.poll(() => colorAt(c, 'stage', 0.9, 0.9)).not.toBeNull();
  await expect.poll(() => colorAt(c, 'stage', 0.25, 0.3)).toBeNull();
  // c's own teal orb is untouched (opening the panel moved c's mouse off the video, so point again).
  await moveTo(c, 0.5, 0.2);
  await expect.poll(() => colorAt(c, 'stage', 0.5, 0.2)).not.toBeNull();
  expect(hueGap(hueOf(await colorAt(c, 'stage', 0.5, 0.2)), 171)).toBeLessThan(25);

  // Turning the laser off clears every pointer for everyone.
  await host.locator('#laserBtn').click();
  for (const viewer of [a, c]) await expect(viewer.locator('#laserBtn')).toBeHidden();
  await expect.poll(() => colorAt(c, 'stage', 0.25, 0.3)).toBeNull();
  await expect.poll(() => colorAt(c, 'stage', 0.5, 0.2)).toBeNull();
  expect(errors).toEqual([]);
});

test('people controls and panel fit every screen size without overlapping', async ({ browser }, testInfo) => {
  const errors = [];
  const { host, viewers } = await startGroup(browser, errors, 3);
  const [viewer] = viewers;
  await host.locator('#laserBtn').click();
  await expect(viewer.locator('#laserBtn')).toBeVisible();
  // A notice is showing on the viewer's screen while the panel is open.
  await expect(viewer.locator('#message')).toBeVisible();
  for (const width of [320, 375, 480, 600, 768, 1024, 1440]) {
    for (const page of [host, viewer]) {
      await page.setViewportSize({ width, height: 700 });
      await page.locator('#peopleBtn').click();
      await expect(page.locator('#peoplePanel')).toBeVisible();
      const layout = await page.evaluate(() => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect();
        const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const controls = ['#statusBadge', '#peopleBtn', '#laserBtn', '#leaveBtn'].map(box).filter((rect) => rect.width);
        const panel = box('#peoplePanel');
        return {
          overlap: controls.some((a, i) => controls.some((b, j) => i < j && hits(a, b))),
          // Nothing floats over the open panel.
          onTop: [[panel.left + 20, panel.top + 20], [panel.right - 20, panel.bottom - 20], [(panel.left + panel.right) / 2, (panel.top + panel.bottom) / 2]]
            .every(([x, y]) => document.querySelector('#peoplePanel').contains(document.elementFromPoint(x, y))),
          panelInside: panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0 && panel.bottom <= innerHeight,
          scroll: document.documentElement.scrollWidth <= innerWidth
        };
      });
      expect(layout, `${width}px`).toEqual({ overlap: false, onTop: true, panelInside: true, scroll: true });
      if (width === 375 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`people-${page === host ? 'sharer' : 'viewer'}-${width}.png`) });
      await page.keyboard.press('Escape');
    }
  }
  expect(errors).toEqual([]);
});

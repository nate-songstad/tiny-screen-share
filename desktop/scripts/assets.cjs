// Draws the app icon and the disk image background. Run with: npm run assets
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const out = join(__dirname, '..', 'build');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const scratch = mkdtempSync(join(tmpdir(), 'screenpeek-assets-'));
const page = (width, height, body, name) => {
  const file = join(scratch, `${name}.html`);
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:transparent">
<canvas id="c" width="${width}" height="${height}"></canvas><script>${body}</script></body></html>`);
  return file;
};

const icon = `
const c = document.getElementById('c'), x = c.getContext('2d'), s = c.width / 1024;
x.scale(s, s);
// macOS icon grid: an 824px rounded square centred on 1024.
const r = 185, o = 100, w = 824;
x.shadowColor = 'rgba(0,0,0,0.28)'; x.shadowBlur = 28; x.shadowOffsetY = 12;
x.beginPath(); x.roundRect(o, o, w, w, r);
const g = x.createLinearGradient(0, o, 0, o + w); g.addColorStop(0, '#2f6049'); g.addColorStop(1, '#1d3d2f');
x.fillStyle = g; x.fill();
x.shadowColor = 'transparent';
// The screen.
x.lineWidth = 44; x.strokeStyle = '#eef4ec'; x.lineJoin = 'round';
x.beginPath(); x.roundRect(262, 300, 500, 340, 54); x.stroke();
x.lineCap = 'round'; x.beginPath(); x.moveTo(420, 730); x.lineTo(604, 730); x.stroke();
// The laser.
const glow = x.createRadialGradient(612, 430, 0, 612, 430, 120);
glow.addColorStop(0, 'rgba(255,60,60,0.75)'); glow.addColorStop(1, 'rgba(255,60,60,0)');
x.fillStyle = glow; x.beginPath(); x.arc(612, 430, 120, 0, Math.PI * 2); x.fill();
x.fillStyle = '#ff2d2d'; x.beginPath(); x.arc(612, 430, 42, 0, Math.PI * 2); x.fill();
x.fillStyle = 'rgba(255,235,235,0.95)'; x.beginPath(); x.arc(612, 430, 15, 0, Math.PI * 2); x.fill();
`;

const background = `
const c = document.getElementById('c'), x = c.getContext('2d'), s = c.width / 540;
x.scale(s, s);
x.fillStyle = '#f5f6f4'; x.fillRect(0, 0, 540, 380);
x.fillStyle = '#24352e'; x.textAlign = 'center';
x.font = '600 20px -apple-system, BlinkMacSystemFont, sans-serif';
x.fillText('Drag Screenpeek into Applications', 270, 62);
x.fillStyle = '#68756e'; x.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
x.fillText('Then open it from your Applications folder.', 270, 88);
// Arrow between the two icons (at x 140 and 400, y 190).
x.strokeStyle = '#9cb88b'; x.lineWidth = 5; x.lineCap = 'round'; x.lineJoin = 'round';
x.setLineDash([2, 12]); x.beginPath(); x.moveTo(218, 190); x.lineTo(316, 190); x.stroke();
x.setLineDash([]); x.beginPath(); x.moveTo(304, 176); x.lineTo(322, 190); x.lineTo(304, 204); x.stroke();
x.fillStyle = '#8a958c'; x.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
x.fillText('Screenpeek isn’t registered with Apple yet: the first time, open it from', 270, 318);
x.fillText('System Settings → Privacy & Security → Open Anyway.', 270, 334);
`;

async function render(width, height, script, file) {
  const win = new BrowserWindow({ show: false, width, height, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadFile(page(width, height, script, file));
  const png = await win.webContents.executeJavaScript(`document.getElementById('c').toDataURL('image/png')`);
  writeFileSync(join(out, file), Buffer.from(png.split(',')[1], 'base64'));
  win.destroy();
}

// Keep running between renders (the default is to quit when the last window closes).
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  await render(1024, 1024, icon, 'icon.png');
  await render(540, 380, background, 'background.png');
  await render(1080, 760, background, 'background@2x.png');
  rmSync(scratch, { recursive: true, force: true });
  app.quit();
});

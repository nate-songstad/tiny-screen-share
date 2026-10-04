// Laser pointer: positions are normalized to the video frame (0–1), so they land
// on the same spot whatever size or letterboxing each screen uses.
export const TRAIL_MS = 750;
const PULSE_MS = 550;

export function contentRect(video, width, height) {
  const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight || !width || !height) return null;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = sourceWidth * scale, h = sourceHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

// Accepts only well-formed pointer messages; anything else becomes null.
export function parsePoint(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== 'object') return null;
  if (msg.h === 1) return { hide: true };
  if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return null;
  const clamp = (value) => Math.min(1, Math.max(0, value));
  return { x: clamp(msg.x), y: clamp(msg.y), down: msg.d === 1 };
}

export function encodePoint(point) {
  if (point.hide) return '{"h":1}';
  return JSON.stringify({ x: Math.round(point.x * 1e4) / 1e4, y: Math.round(point.y * 1e4) / 1e4, d: point.down ? 1 : 0 });
}

export class LaserTrace {
  constructor() {
    this.cursor = null;
    this.points = [];
    this.pulses = [];
    this.down = false;
    this.stroke = 0;
    this.listeners = new Set();
  }

  apply(point, now = performance.now()) {
    // Also pruned here: nothing paints while the tab is hidden and no floating window is open.
    this.prune(now);
    if (point.hide) {
      this.cursor = null;
      this.down = false;
    } else {
      const pressed = point.down && !this.down;
      if (pressed) {
        this.stroke++;
        this.pulses.push({ x: point.x, y: point.y, t: now });
      }
      this.down = point.down;
      this.cursor = { x: point.x, y: point.y };
      if (point.down) this.points.push({ x: point.x, y: point.y, t: now, stroke: this.stroke });
      if (pressed) for (const listener of this.listeners) listener('press');
    }
    for (const listener of this.listeners) listener('change');
  }

  clear() {
    this.cursor = null;
    this.points = [];
    this.pulses = [];
    this.down = false;
    for (const listener of this.listeners) listener('change');
  }

  prune(now) {
    while (this.points.length && now - this.points[0].t > TRAIL_MS) this.points.shift();
    while (this.pulses.length && now - this.pulses[0].t > PULSE_MS) this.pulses.shift();
  }

  busy() { return Boolean(this.cursor || this.points.length || this.pulses.length); }
}

function draw(ctx, trace, rect, scale, now) {
  const at = (point) => [rect.x + point.x * rect.width, rect.y + point.y * rect.height];
  // Flat ends: rounded ones overlap at every joint and show as darker beads.
  ctx.lineCap = 'butt';
  const points = trace.points;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i];
    if (from.stroke !== to.stroke) continue;
    // Ease out so the line thins and fades smoothly rather than blinking off.
    const life = 1 - (now - from.t) / TRAIL_MS;
    if (life <= 0) continue;
    const alpha = life * life;
    ctx.strokeStyle = `rgba(255, 48, 48, ${alpha})`;
    ctx.shadowColor = `rgba(255, 0, 0, ${alpha * 0.8})`;
    ctx.shadowBlur = 10 * scale;
    ctx.lineWidth = (2.5 + 2.5 * life) * scale;
    ctx.beginPath();
    ctx.moveTo(...at(from));
    ctx.lineTo(...at(to));
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  for (const pulse of trace.pulses) {
    const progress = (now - pulse.t) / PULSE_MS;
    if (progress >= 1) continue;
    const [x, y] = at(pulse);
    ctx.strokeStyle = `rgba(255, 60, 60, ${(1 - progress) * 0.9})`;
    ctx.lineWidth = 3 * scale * (1 - progress) + scale;
    ctx.beginPath();
    ctx.arc(x, y, (8 + 26 * Math.sqrt(progress)) * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (trace.cursor) {
    const [x, y] = at(trace.cursor);
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 18 * scale);
    glow.addColorStop(0, 'rgba(255, 40, 40, 0.55)');
    glow.addColorStop(1, 'rgba(255, 40, 40, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 18 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff2d2d';
    ctx.beginPath();
    ctx.arc(x, y, (trace.down ? 6.5 : 5.5) * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 225, 225, 0.9)';
    ctx.beginPath();
    ctx.arc(x, y, 2 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Draws one trace over one video. Runs frames only while something is visible,
// using the animation clock of the window the canvas lives in (the floating
// window keeps animating while the sharer's main tab is in the background).
export class LaserView {
  constructor(canvas, video, trace, size = 1) {
    this.canvas = canvas;
    this.video = video;
    this.trace = trace;
    this.size = size;
    this.frame = 0;
    this.listener = () => this.wake();
    trace.listeners.add(this.listener);
  }

  wake() {
    if (this.frame || !this.canvas) return;
    const win = this.canvas.ownerDocument.defaultView;
    if (!win) return;
    // The floating window's frame timestamps use its own clock; trace times use ours.
    this.frame = win.requestAnimationFrame(() => this.paint(performance.now()));
  }

  paint(now) {
    this.frame = 0;
    const { canvas, video, trace } = this;
    if (!canvas) return;
    trace.prune(now);
    const win = canvas.ownerDocument.defaultView || window;
    const ratio = win.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * ratio), height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    const rect = contentRect(video, width, height);
    if (rect) draw(ctx, trace, rect, ratio * this.size, now);
    if (trace.busy()) this.wake();
  }

  destroy() {
    this.trace.listeners.delete(this.listener);
    const win = this.canvas?.ownerDocument.defaultView;
    if (this.frame) win?.cancelAnimationFrame(this.frame);
    this.canvas?.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas = null;
  }
}

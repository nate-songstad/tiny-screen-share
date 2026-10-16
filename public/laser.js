// Laser pointer: positions are normalized to the video frame (0–1), so they land
// on the same spot whatever size or letterboxing each screen uses.
export const TRAIL_MS = 750;
const PULSE_MS = 550;

// Nobody in a room shares a style. New people get the first solid colour that
// is free; the fun styles are never handed out, only claimed, first come first served.
export const LASER_STYLES = [
  { id: 'red', name: 'Red', rgb: [255, 45, 45] },
  { id: 'blue', name: 'Blue', rgb: [40, 132, 255] },
  { id: 'amber', name: 'Amber', rgb: [255, 166, 0] },
  { id: 'violet', name: 'Violet', rgb: [168, 85, 247] },
  { id: 'teal', name: 'Teal', rgb: [0, 190, 160] },
  { id: 'pink', name: 'Pink', rgb: [255, 70, 170] },
  { id: 'lime', name: 'Lime', rgb: [110, 200, 40] },
  { id: 'rainbow', name: 'Rainbow', fun: true },
  { id: 'galaxy', name: 'Galaxy', fun: true },
  { id: 'fire', name: 'Fire', fun: true }
];
const solids = LASER_STYLES.filter((style) => !style.fun);
const byId = new Map(LASER_STYLES.map((style) => [style.id, style]));
export const autoStyles = solids.map((style) => style.id);
export const styleName = (id) => byId.get(id)?.name || 'Laser';
export const isStyle = (id) => typeof id === 'string' && byId.has(id);

function hue(degrees) {
  const h = ((degrees % 360) + 360) % 360 / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  return [Math.round(55 + r * 200), Math.round(55 + g * 200), Math.round(55 + b * 200)];
}
const mix = (a, b, amount) => a.map((value, i) => Math.round(value + (b[i] - value) * amount));
const wave = (value) => (Math.sin(value) + 1) / 2;

// The colour of one style at a moment: trail points use their own time, so a
// rainbow's colours stay where they were drawn while the orb keeps cycling.
export function tint(id, t) {
  if (id === 'rainbow') return hue(t / 4);
  if (id === 'galaxy') return mix([70, 60, 255], [225, 60, 255], wave(t / 260));
  if (id === 'fire') return mix([255, 55, 0], [255, 190, 0], wave(t / 90));
  return (byId.get(id) || solids[0]).rgb;
}

// A CSS swatch for pickers and buttons.
export function swatch(id) {
  if (id === 'rainbow') return 'conic-gradient(#ff3b3b, #ffb000, #6fd23c, #19c2ff, #8a5cff, #ff4fb4, #ff3b3b)';
  if (id === 'galaxy') return 'radial-gradient(circle at 30% 30%, #fff 0 1.5px, transparent 2px), radial-gradient(circle at 70% 62%, #fff 0 1px, transparent 1.5px), radial-gradient(circle at 50% 50%, #c35bff, #3b1a8f 70%)';
  if (id === 'fire') return 'radial-gradient(circle at 50% 65%, #ffe066, #ff8a00 45%, #e8290b 80%)';
  return `rgb(${tint(id, 0).join(', ')})`;
}

export function contentRect(video, width, height) {
  const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight || !width || !height) return null;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = sourceWidth * scale, h = sourceHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

// Accepts only well-formed pointer messages; anything else becomes null.
// `p` names whose pointer it is when the sharer relays it to other viewers.
export function parsePoint(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== 'object') return null;
  const from = typeof msg.p === 'string' && msg.p.length <= 64 ? msg.p : undefined;
  if (msg.h === 1) return { hide: true, from };
  if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return null;
  const clamp = (value) => Math.min(1, Math.max(0, value));
  return { x: clamp(msg.x), y: clamp(msg.y), down: msg.d === 1, from };
}

export function encodePoint(point, from) {
  const tag = from ? { p: from } : {};
  if (point.hide) return JSON.stringify({ h: 1, ...tag });
  return JSON.stringify({ x: Math.round(point.x * 1e4) / 1e4, y: Math.round(point.y * 1e4) / 1e4, d: point.down ? 1 : 0, ...tag });
}

// One person's pointer.
export class LaserTrace {
  constructor(emit = () => {}) {
    this.cursor = null;
    this.points = [];
    this.pulses = [];
    this.down = false;
    this.stroke = 0;
    this.emit = emit;
  }

  apply(point, now = performance.now()) {
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
      if (pressed) this.emit('press');
    }
    this.emit('change');
  }

  prune(now) {
    while (this.points.length && now - this.points[0].t > TRAIL_MS) this.points.shift();
    while (this.pulses.length && now - this.pulses[0].t > PULSE_MS) this.pulses.shift();
  }

  busy() { return Boolean(this.cursor || this.points.length || this.pulses.length); }
}

// Everyone's pointers on one screen, keyed by person.
export class LaserBoard {
  constructor() {
    this.traces = new Map();
    this.listeners = new Set();
    // Set by the app: how a person's pointer looks ({ style, label }).
    this.look = () => ({ style: 'red', label: '' });
  }

  emit(type) { for (const listener of this.listeners) listener(type); }

  apply(id, point, now = performance.now()) {
    // Also pruned here: nothing paints while the tab is hidden and no floating window is open.
    this.prune(now);
    let trace = this.traces.get(id);
    if (!trace) {
      if (point.hide) return;
      trace = new LaserTrace((type) => this.emit(type));
      this.traces.set(id, trace);
    }
    trace.apply(point, now);
  }

  get(id) { return this.traces.get(id); }

  // Forget one person's pointer, or everyone's.
  clear(id) {
    if (id === undefined) this.traces.clear();
    else this.traces.delete(id);
    this.emit('change');
  }

  prune(now) {
    for (const [id, trace] of this.traces) {
      trace.prune(now);
      if (!trace.busy()) this.traces.delete(id);
    }
  }

  busy() { return [...this.traces.values()].some((trace) => trace.busy()); }

  // Whether the next frame differs from this one: a still, solid-colour orb needs no redraws.
  animating() {
    for (const [id, trace] of this.traces) {
      if (trace.points.length || trace.pulses.length) return true;
      if (trace.cursor && byId.get(this.look(id).style)?.fun) return true;
    }
    return false;
  }
}

const rgba = ([r, g, b], alpha) => `rgba(${r}, ${g}, ${b}, ${alpha})`;
// Stable pseudo-random numbers, so galaxy stars stay put as the trail fades.
const noise = (seed) => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

function draw(ctx, trace, look, rect, scale, now) {
  const { style, label } = look;
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
    const color = tint(style, from.t);
    ctx.strokeStyle = rgba(color, alpha);
    ctx.shadowColor = rgba(color, alpha * 0.8);
    ctx.shadowBlur = 10 * scale;
    ctx.lineWidth = (2.5 + 2.5 * life) * scale;
    ctx.beginPath();
    ctx.moveTo(...at(from));
    ctx.lineTo(...at(to));
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  if (style === 'galaxy') {
    // Stars scattered along the trail, twinkling as they fade.
    for (let i = 0; i < points.length; i += 2) {
      const point = points[i];
      const life = 1 - (now - point.t) / TRAIL_MS;
      if (life <= 0) continue;
      const seed = point.t + i;
      const [x, y] = at(point);
      const twinkle = 0.5 + 0.5 * Math.sin(now / 70 + seed);
      ctx.fillStyle = `rgba(255, 255, 255, ${life * twinkle})`;
      ctx.beginPath();
      ctx.arc(x + (noise(seed) - 0.5) * 18 * scale, y + (noise(seed + 1) - 0.5) * 18 * scale, (0.6 + noise(seed + 2) * 1.2) * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (const pulse of trace.pulses) {
    const progress = (now - pulse.t) / PULSE_MS;
    if (progress >= 1) continue;
    const [x, y] = at(pulse);
    ctx.strokeStyle = rgba(tint(style, now), (1 - progress) * 0.9);
    ctx.lineWidth = 3 * scale * (1 - progress) + scale;
    ctx.beginPath();
    ctx.arc(x, y, (8 + 26 * Math.sqrt(progress)) * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (!trace.cursor) return;
  const [x, y] = at(trace.cursor);
  const color = tint(style, now);
  const glow = ctx.createRadialGradient(x, y, 0, x, y, 18 * scale);
  glow.addColorStop(0, rgba(color, 0.55));
  glow.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, 18 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = rgba(color, 1);
  ctx.beginPath();
  ctx.arc(x, y, (trace.down ? 6.5 : 5.5) * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.beginPath();
  ctx.arc(x, y, 2 * scale, 0, Math.PI * 2);
  ctx.fill();
  if (style === 'galaxy') {
    // A few stars orbit the orb.
    for (let k = 0; k < 3; k++) {
      const angle = now / 420 + k * (Math.PI * 2 / 3);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.6 + 0.4 * Math.sin(now / 90 + k)})`;
      ctx.beginPath();
      ctx.arc(x + Math.cos(angle) * 13 * scale, y + Math.sin(angle) * 13 * scale, 1.3 * scale, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (label) {
    // Who is pointing, in a small tag beside the orb that stays on the canvas.
    ctx.font = `600 ${11 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    // The person's laser colour sits in the tag, next to their name.
    const pad = 6 * scale, height = 18 * scale, offset = 13 * scale, dot = 3.5 * scale;
    const width = ctx.measureText(label).width + pad * 3 + dot * 2;
    let left = x + offset, top = y + offset;
    if (left + width > ctx.canvas.width) left = x - offset - width;
    if (top + height > ctx.canvas.height) top = y - offset - height;
    ctx.fillStyle = 'rgba(20, 30, 26, 0.82)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(left, top, width, height, 5 * scale);
    else ctx.rect(left, top, width, height);
    ctx.fill();
    ctx.fillStyle = rgba(color, 1);
    ctx.beginPath();
    ctx.arc(left + pad + dot, top + height / 2, dot, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(label, left + pad * 2 + dot * 2, top + height / 2);
  }
}

// Draws every pointer on a board over one video. Runs frames only while
// something is visible, using the animation clock of the window the canvas
// lives in (the floating window keeps animating while the sharer's main tab is
// in the background).
export class LaserView {
  constructor(canvas, video, board, size = 1) {
    this.canvas = canvas;
    this.video = video;
    this.board = board;
    this.size = size;
    this.frame = 0;
    this.listener = () => this.wake();
    board.listeners.add(this.listener);
    // Frames only run while something moves, so repaint when the size changes too.
    const win = canvas.ownerDocument.defaultView;
    this.observer = win?.ResizeObserver ? new win.ResizeObserver(this.listener) : null;
    this.observer?.observe(canvas);
    video.addEventListener('resize', this.listener);
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
    const { canvas, video, board } = this;
    if (!canvas) return;
    board.prune(now);
    const win = canvas.ownerDocument.defaultView || window;
    const ratio = win.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * ratio), height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    const rect = contentRect(video, width, height);
    if (rect) for (const [id, trace] of board.traces) draw(ctx, trace, board.look(id), rect, ratio * this.size, now);
    if (board.animating()) this.wake();
  }

  destroy() {
    this.board.listeners.delete(this.listener);
    this.observer?.disconnect();
    this.video.removeEventListener('resize', this.listener);
    const win = this.canvas?.ownerDocument.defaultView;
    if (this.frame) win?.cancelAnimationFrame(this.frame);
    this.canvas?.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas = null;
  }
}

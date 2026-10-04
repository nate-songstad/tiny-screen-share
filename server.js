import express from 'express';
import http from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const app = express();
// Keep the HTML, styles and client protocol in sync across deployments.
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url)), {
  setHeaders(res) { res.setHeader('Cache-Control', 'no-store'); }
}));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map();
const reconnectGrace = Number(process.env.RECONNECT_GRACE_MS) || 30000;
const flipTimeout = Number(process.env.FLIP_TIMEOUT_MS) || 60000;

function send(ws, message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function snapshot(room, member) {
  const sharer = room.members.get(room.sharer);
  const other = [...room.members.values()].find((item) => item !== member);
  return {
    type: 'state', code: room.code, role: room.sharer === member.token ? 'sharer' : 'viewer',
    epoch: room.epoch, ready: room.ready, paused: room.paused,
    partner: other ? (other.ws ? 'online' : 'reconnecting') : 'absent',
    sharerOnline: Boolean(sharer?.ws), flipId: room.flip?.id || null,
    laser: room.laser, laserId: room.laserId
  };
}

function broadcast(room) {
  for (const member of room.members.values()) send(member.ws, snapshot(room, member));
}

function cancelFlip(room, notice) {
  if (!room.flip) return;
  clearTimeout(room.flip.timer);
  room.flip = null;
  if (notice) for (const member of room.members.values()) send(member.ws, { type: 'notice', message: notice });
}

function endRoom(room, message = 'This screenpeek has ended.') {
  cancelFlip(room);
  for (const member of room.members.values()) {
    clearTimeout(member.timer);
    if (member.ws) {
      member.ws.meta = null;
      send(member.ws, { type: 'ended', message });
    }
  }
  rooms.delete(room.code);
}

function removeMember(room, member) {
  clearTimeout(member.timer);
  if (room.sharer === member.token) {
    endRoom(room, 'The sharer left. You can start a new screenpeek.');
  } else {
    room.members.delete(member.token);
    cancelFlip(room);
    room.epoch++;
    broadcast(room);
  }
}

function attach(room, member, ws) {
  clearTimeout(member.timer);
  const oldSocket = member.ws;
  member.ws = ws;
  ws.meta = { code: room.code, token: member.token };
  if (oldSocket && oldSocket !== ws) {
    oldSocket.meta = null;
    send(oldSocket, { type: 'ended', message: 'This session was opened in another tab.' });
    oldSocket.close();
  }
  send(ws, { type: 'session', code: room.code, token: member.token });
  room.epoch++;
  broadcast(room);
}

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    const error = (message, fatal = false) => send(ws, { type: 'error', message, fatal });

    if (['create', 'join', 'resume'].includes(msg.type)) {
      if (ws.meta) return error('You are already in a screenpeek.');
      if (msg.type === 'create') {
        let code;
        do { code = String(randomInt(100000, 1000000)); } while (rooms.has(code));
        const member = { token: randomUUID(), ws: null, timer: null };
        const room = { code, members: new Map([[member.token, member]]), sharer: member.token,
          epoch: 0, ready: true, paused: false, flip: null, laser: false, laserId: null };
        rooms.set(code, room);
        attach(room, member, ws);
        return;
      }
      const room = rooms.get(String(msg.code));
      if (!room) return error('That screenpeek has ended or the code is incorrect.', true);
      if (msg.type === 'resume') {
        const member = room.members.get(msg.token);
        if (!member) return error('Your session has expired. Join again or start a new screenpeek.', true);
        cancelFlip(room);
        if (room.sharer === member.token) {
          room.ready = msg.hasStream === true;
          room.paused = room.ready && msg.paused === true;
          // The floating laser window survives a dropped socket, but not a refresh.
          room.laser = room.ready && msg.laser === true;
        }
        attach(room, member, ws);
      } else {
        if (!/^\d{6}$/.test(String(msg.code))) return error('Enter a six-digit code.', true);
        if (room.members.size >= 2) return error('This screenpeek already has two people.', true);
        const member = { token: randomUUID(), ws: null, timer: null };
        room.members.set(member.token, member);
        attach(room, member, ws);
      }
      return;
    }

    const room = rooms.get(ws.meta?.code);
    const member = room?.members.get(ws.meta?.token);
    if (!room || member?.ws !== ws) return;
    const isSharer = member.token === room.sharer;
    const other = [...room.members.values()].find((item) => item !== member);

    switch (msg.type) {
      case 'signal':
        // Ignore SDP/ICE from connections before a refresh, retry or flip.
        if (msg.epoch === room.epoch && room.ready && msg.data && typeof msg.data === 'object') {
          send(other?.ws, { type: 'signal', epoch: room.epoch, data: msg.data });
        }
        break;
      case 'ready':
        if (!isSharer) return;
        room.ready = true;
        room.paused = false;
        room.epoch++;
        broadcast(room);
        break;
      case 'not-ready':
        if (!isSharer || !room.ready) return;
        room.ready = false;
        room.paused = false;
        room.laser = false;
        cancelFlip(room);
        room.epoch++;
        broadcast(room);
        break;
      case 'pause':
        if (!isSharer || !room.ready || typeof msg.paused !== 'boolean') return;
        room.paused = msg.paused;
        broadcast(room);
        break;
      case 'laser':
        // Always answer, so the sharer can tell a refusal from an older broadcast.
        if (!isSharer || typeof msg.on !== 'boolean') return;
        room.laser = msg.on && room.ready;
        room.laserId = Number.isSafeInteger(msg.id) ? msg.id : null;
        broadcast(room);
        break;
      case 'request-flip':
        if (!isSharer || !room.ready || !other?.ws || room.flip) return;
        room.flip = { id: randomUUID(), target: other.token };
        room.flip.timer = setTimeout(() => {
          cancelFlip(room, 'The flip request expired. You can try again.');
          broadcast(room);
        }, flipTimeout);
        broadcast(room);
        break;
      case 'cancel-flip':
      case 'decline-flip':
        if (!room.flip || msg.flipId !== room.flip.id) return;
        if (msg.type === 'cancel-flip' ? !isSharer : room.flip.target !== member.token) return;
        cancelFlip(room, isSharer ? 'Flip request cancelled.' : 'Flip declined. The current sharer keeps the floor.');
        broadcast(room);
        break;
      case 'accept-flip':
        if (!room.flip || msg.flipId !== room.flip.id || room.flip.target !== member.token || !other?.ws) {
          send(ws, { type: 'flip-rejected', message: 'That flip request is no longer available.' });
          return;
        }
        cancelFlip(room);
        room.sharer = member.token;
        room.ready = true;
        room.paused = false;
        room.laser = false;
        room.epoch++;
        broadcast(room);
        break;
      case 'retry':
        room.epoch++;
        broadcast(room);
        break;
      case 'leave':
        ws.meta = null;
        removeMember(room, member);
        break;
      case 'end':
        if (isSharer) endRoom(room);
        break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.meta?.code);
    const member = room?.members.get(ws.meta?.token);
    if (!room || member?.ws !== ws) return;
    member.ws = null;
    cancelFlip(room);
    if (room.sharer === member.token) room.ready = false;
    room.epoch++;
    broadcast(room);
    member.timer = setTimeout(() => removeMember(room, member), reconnectGrace);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) ws.terminate();
    else { ws.alive = false; ws.ping(); }
  }
}, 10000);
wss.on('close', () => clearInterval(heartbeat));

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Screenpeek running on http://localhost:${port}`));

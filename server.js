import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function cleanRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (!room.host && !room.viewer) rooms.delete(roomCode);
}

wss.on('connection', (ws) => {
  ws.meta = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'create-room') {
      let code;
      do {
        code = String(Math.floor(100000 + Math.random() * 900000));
      } while (rooms.has(code));

      rooms.set(code, { host: ws, viewer: null });
      ws.meta = { role: 'host', roomCode: code };
      send(ws, { type: 'room-created', code });
      return;
    }

    if (msg.type === 'join-room') {
      const code = String(msg.code || '').trim();
      const room = rooms.get(code);

      if (!room || !room.host) {
        send(ws, { type: 'error', message: 'That share code is not active.' });
        return;
      }

      if (room.viewer && room.viewer !== ws) {
        send(ws, { type: 'error', message: 'Someone is already viewing this share.' });
        return;
      }

      room.viewer = ws;
      ws.meta = { role: 'viewer', roomCode: code };
      send(ws, { type: 'joined-room', code });
      send(room.host, { type: 'viewer-ready' });
      return;
    }

    if (msg.type === 'signal') {
      const meta = ws.meta;
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (!room) return;

      const target = meta.role === 'host' ? room.viewer : room.host;
      if (target) send(target, { type: 'signal', data: msg.data });
      return;
    }

    if (msg.type === 'stop-share') {
      const meta = ws.meta;
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (!room) return;

      if (meta.role === 'host') {
        if (room.viewer) send(room.viewer, { type: 'share-ended' });
        rooms.delete(meta.roomCode);
      }
    }
  });

  ws.on('close', () => {
    const meta = ws.meta;
    if (!meta) return;

    const room = rooms.get(meta.roomCode);
    if (!room) return;

    if (meta.role === 'host') {
      if (room.viewer) send(room.viewer, { type: 'share-ended' });
      room.host = null;
    } else {
      if (room.host) send(room.host, { type: 'viewer-left' });
      room.viewer = null;
    }

    cleanRoom(meta.roomCode);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Tiny Screen Share running on http://localhost:${port}`);
});

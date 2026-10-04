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
  if (room.participants.size === 0) rooms.delete(roomCode);
}

function otherParticipant(room, ws) {
  return [...room.participants].find((participant) => participant !== ws);
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

      rooms.set(code, {
        participants: new Set([ws]),
        sharer: ws,
        flipTarget: null
      });
      ws.meta = { roomCode: code };
      send(ws, { type: 'room-created', code });
      return;
    }

    if (msg.type === 'join-room') {
      const code = String(msg.code || '').trim();
      const room = rooms.get(code);

      if (!room || !room.sharer) {
        send(ws, { type: 'error', message: 'That share code is not active.' });
        return;
      }

      if (room.participants.size >= 2 && !room.participants.has(ws)) {
        send(ws, { type: 'error', message: 'Someone is already viewing this share.' });
        return;
      }

      room.participants.add(ws);
      ws.meta = { roomCode: code };
      send(ws, { type: 'joined-room', code });
      send(room.sharer, { type: 'viewer-ready' });
      return;
    }

    if (msg.type === 'signal') {
      const meta = ws.meta;
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (!room) return;

      const target = otherParticipant(room, ws);
      if (target) send(target, { type: 'signal', data: msg.data });
      return;
    }

    if (msg.type === 'request-flip') {
      const meta = ws.meta;
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (!room || room.sharer !== ws) return;

      const target = otherParticipant(room, ws);
      if (!target) {
        send(ws, { type: 'error', message: 'There is no viewer to take over yet.' });
        return;
      }

      room.flipTarget = target;
      send(target, { type: 'flip-requested' });
      send(ws, { type: 'flip-pending' });
      return;
    }

    if (msg.type === 'accept-flip') {
      const meta = ws.meta;
      if (!meta) {
        send(ws, { type: 'flip-failed', message: 'The handoff is no longer available.' });
        return;
      }
      const room = rooms.get(meta.roomCode);
      if (!room || room.flipTarget !== ws || room.sharer === ws) {
        send(ws, { type: 'flip-failed', message: 'The handoff is no longer available.' });
        return;
      }

      const previousSharer = room.sharer;
      room.sharer = ws;
      room.flipTarget = null;
      send(previousSharer, { type: 'flip-accepted', role: 'viewer' });
      send(ws, { type: 'flip-accepted', role: 'sharer' });
      return;
    }

    if (msg.type === 'decline-flip') {
      const meta = ws.meta;
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (!room || room.flipTarget !== ws) return;

      room.flipTarget = null;
      send(room.sharer, { type: 'flip-declined' });
      return;
    }

    if (msg.type === 'stop-share') {
      const meta = ws.meta;
      if (!meta) return;
      const room = rooms.get(meta.roomCode);
      if (!room) return;

      if (room.sharer !== ws) return;

      const viewer = otherParticipant(room, ws);
      if (viewer) send(viewer, { type: 'share-ended' });
      rooms.delete(meta.roomCode);
    }
  });

  ws.on('close', () => {
    const meta = ws.meta;
    if (!meta) return;

    const room = rooms.get(meta.roomCode);
    if (!room) return;

    room.participants.delete(ws);

    if (room.flipTarget === ws) {
      room.flipTarget = null;
      if (room.sharer) send(room.sharer, { type: 'flip-declined' });
    }

    if (room.sharer === ws) {
      const viewer = otherParticipant(room, ws);
      if (viewer) send(viewer, { type: 'share-ended' });
      rooms.delete(meta.roomCode);
      return;
    }

    if (room.sharer) send(room.sharer, { type: 'viewer-left' });

    cleanRoom(meta.roomCode);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Tiny Screen Share running on http://localhost:${port}`);
});

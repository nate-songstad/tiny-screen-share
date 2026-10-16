import express from 'express';
import http from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { autoStyles, isStyle } from './public/laser.js';

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
// The sharer sends one video connection to each viewer.
const maxPeople = 7;
if (autoStyles.length < maxPeople) throw new Error('Every place needs its own laser colour.');
const segmenter = new Intl.Segmenter();

function send(ws, message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

// Names are optional, shown to everyone and always rendered as text.
// Strip control and direction-changing characters; keep emoji joiners.
function cleanName(value) {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, 400).normalize('NFC')
    .replace(/[\p{Cc}\p{Cs}\p{Co}\p{Cn}؜​‎‏‪-‮⁠-⁤⁦-⁩﻿]/gu, '')
    .replace(/\s+/g, ' ').trim();
  let name = '', count = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (count === 32 || name.length + segment.length > 64) break;
    name += segment;
    count++;
  }
  return name.trim() || null;
}

const isSharer = (room, member) => room.sharer === member.token;
// Anyone watching and online can take an offered floor, unless they passed.
const canTake = (room, member) => Boolean(room.flip && member.ws && !isSharer(room, member) && !room.flip.passed.has(member.token));
const takers = (room) => [...room.members.values()].filter((member) => canTake(room, member));

function snapshot(room, member) {
  const sharer = room.members.get(room.sharer);
  return {
    type: 'state', code: room.code, you: member.id, role: isSharer(room, member) ? 'sharer' : 'viewer',
    // A viewer's connection generation; signals from older connections are dropped.
    epoch: member.link, ready: room.ready, paused: room.paused, sharerOnline: Boolean(sharer?.ws),
    flipId: room.flip && (isSharer(room, member) || canTake(room, member)) ? room.flip.id : null,
    laser: room.laser, laserId: room.laserId,
    members: [...room.members.values()].map((item) => ({
      id: item.id, name: item.name, style: item.style, role: isSharer(room, item) ? 'sharer' : 'viewer',
      online: Boolean(item.ws), link: item.link
    }))
  };
}

function broadcast(room) {
  for (const member of room.members.values()) send(member.ws, snapshot(room, member));
}

// Starting a new connection generation drops in-flight signals for the old one.
function relink(room, member) {
  if (member && !isSharer(room, member)) member.link++;
  else for (const item of room.members.values()) item.link++;
}

function cancelFlip(room, notice) {
  if (!room.flip) return;
  clearTimeout(room.flip.timer);
  room.flip = null;
  if (notice) for (const member of room.members.values()) send(member.ws, { type: 'notice', message: notice });
}

// When nobody is left who could take the floor, the request is over.
function settleFlip(room, notice) {
  if (room.flip && !takers(room).length) cancelFlip(room, notice);
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
  if (isSharer(room, member)) {
    endRoom(room, 'The sharer left. You can start a new screenpeek.');
  } else {
    room.members.delete(member.token);
    settleFlip(room);
    broadcast(room);
  }
}

function addMember(room) {
  const members = [...room.members.values()];
  // There are as many solid colours as places, so one is always free.
  const style = autoStyles.find((id) => !members.some((item) => item.style === id));
  const member = { token: randomUUID(), id: randomUUID(), name: null, style, link: 0, ws: null, timer: null };
  room.members.set(member.token, member);
  return member;
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
  send(ws, { type: 'session', code: room.code, token: member.token, id: member.id });
  relink(room, member);
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
        const room = { code, members: new Map(), sharer: null,
          ready: true, paused: false, flip: null, laser: false, laserId: null };
        room.sharer = addMember(room).token;
        rooms.set(code, room);
        attach(room, room.members.get(room.sharer), ws);
        return;
      }
      const room = rooms.get(String(msg.code));
      if (!room) return error('That screenpeek has ended or the code is incorrect.', true);
      if (msg.type === 'resume') {
        const member = room.members.get(msg.token);
        if (!member) return error('Your session has expired. Join again or start a new screenpeek.', true);
        if (isSharer(room, member)) {
          cancelFlip(room);
          room.ready = msg.hasStream === true;
          room.paused = room.ready && msg.paused === true;
          // The floating laser window survives a dropped socket, but not a refresh.
          room.laser = room.ready && msg.laser === true;
        }
        attach(room, member, ws);
      } else {
        if (!/^\d{6}$/.test(String(msg.code))) return error('Enter a six-digit code.', true);
        if (room.members.size >= maxPeople) return error(`This screenpeek is full. Up to ${maxPeople} people can join.`, true);
        attach(room, addMember(room), ws);
      }
      return;
    }

    const room = rooms.get(ws.meta?.code);
    const member = room?.members.get(ws.meta?.token);
    if (!room || member?.ws !== ws) return;
    const sharing = isSharer(room, member);
    const sharer = room.members.get(room.sharer);

    switch (msg.type) {
      case 'signal':
        // Ignore SDP/ICE from connections before a refresh, retry or flip.
        if (!room.ready || !msg.data || typeof msg.data !== 'object') return;
        if (sharing) {
          const target = [...room.members.values()].find((item) => item.id === msg.to);
          if (target && target !== member && msg.epoch === target.link) {
            send(target.ws, { type: 'signal', epoch: target.link, data: msg.data });
          }
        } else if (msg.epoch === member.link) {
          send(sharer?.ws, { type: 'signal', from: member.id, epoch: member.link, data: msg.data });
        }
        break;
      case 'name': {
        const name = cleanName(msg.name);
        if (name === member.name) return;
        member.name = name;
        broadcast(room);
        break;
      }
      case 'style':
        // No two people share a laser, so nobody mistakes someone else's pointer for their own.
        if (!isStyle(msg.style) || msg.style === member.style) return;
        if ([...room.members.values()].some((item) => item.style === msg.style)) {
          send(ws, { type: 'notice', message: 'Someone already has that laser. Pick another one.' });
          return;
        }
        member.style = msg.style;
        broadcast(room);
        break;
      case 'ready':
        if (!sharing) return;
        room.ready = true;
        room.paused = false;
        relink(room);
        broadcast(room);
        break;
      case 'not-ready':
        if (!sharing || !room.ready) return;
        room.ready = false;
        room.paused = false;
        room.laser = false;
        cancelFlip(room);
        relink(room);
        broadcast(room);
        break;
      case 'pause':
        if (!sharing || !room.ready || typeof msg.paused !== 'boolean') return;
        room.paused = msg.paused;
        broadcast(room);
        break;
      case 'laser':
        // Always answer, so the sharer can tell a refusal from an older broadcast.
        if (!sharing || typeof msg.on !== 'boolean') return;
        room.laser = msg.on && room.ready;
        room.laserId = Number.isSafeInteger(msg.id) ? msg.id : null;
        broadcast(room);
        break;
      case 'request-flip':
        // The floor goes to whoever accepts first. Everyone is trusted to take turns.
        if (!sharing) return;
        if (room.ready && !room.flip) {
          room.flip = { id: randomUUID(), passed: new Set() };
          if (!takers(room).length) room.flip = null;
          else {
            room.flip.timer = setTimeout(() => {
              cancelFlip(room, 'The flip request expired. You can try again.');
              broadcast(room);
            }, flipTimeout);
          }
        }
        // Answered even when refused, so the sharer's Flip button never sticks.
        broadcast(room);
        break;
      case 'cancel-flip':
        if (!sharing || !room.flip || msg.flipId !== room.flip.id) return;
        cancelFlip(room, 'Flip request cancelled.');
        broadcast(room);
        break;
      case 'decline-flip':
        if (!room.flip || msg.flipId !== room.flip.id || !canTake(room, member)) return;
        room.flip.passed.add(member.token);
        settleFlip(room, room.flip.passed.size > 1
          ? 'Everyone passed. The current sharer keeps the floor.'
          : 'Flip declined. The current sharer keeps the floor.');
        broadcast(room);
        break;
      case 'accept-flip':
        if (!room.flip || msg.flipId !== room.flip.id || !canTake(room, member) || !sharer?.ws) {
          send(ws, { type: 'flip-rejected', message: 'Someone else took the floor first, or the offer ended.' });
          return;
        }
        cancelFlip(room);
        room.sharer = member.token;
        room.ready = true;
        room.paused = false;
        room.laser = false;
        relink(room);
        broadcast(room);
        break;
      case 'retry':
        relink(room, member);
        broadcast(room);
        break;
      case 'leave':
        ws.meta = null;
        removeMember(room, member);
        break;
      case 'end':
        if (sharing) endRoom(room);
        break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.meta?.code);
    const member = room?.members.get(ws.meta?.token);
    if (!room || member?.ws !== ws) return;
    member.ws = null;
    if (isSharer(room, member)) {
      cancelFlip(room);
      room.ready = false;
    } else settleFlip(room);
    relink(room, member);
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

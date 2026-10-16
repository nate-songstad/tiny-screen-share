import { LASER_STYLES, LaserBoard, LaserView, contentRect, encodePoint, parsePoint, styleName, swatch } from './laser.js';

const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map((el) => [el.id, el]));
const storageKey = 'screenpeek.session.v3';
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let socket, session, room, stream, pendingStream, captureJob;
let online = false;
let busy = false;
// One video connection per remote person: the sharer has one to each viewer,
// a viewer has one to the sharer. Keyed by that person's id.
const links = new Map();
let messages = Promise.resolve();
let reconnectTimer, handshakeTimer;
let reconnectStarted = 0;
let copyTimer;
let lifecycle = 0;
// Laser pointer. The sharer allows it; each viewer then chooses to point.
const board = new LaserBoard();
let stageView, pip;
let pipJob = 0;
let laserMode = false;
let laserRequest = 0;
let laserWanted = null;
let laserResume = false;
let pointerDown = false;
let peopleOpen = false;
let peopleKey = '';

function visible(element, show) { element.classList.toggle('hidden', !show); }
function notice(message = '', error = false) {
  ui.message.textContent = message;
  ui.message.dataset.error = String(error);
  ui.message.setAttribute('role', error ? 'alert' : 'status');
  visible(ui.message, Boolean(message));
}
function persist() {
  try {
    if (session) sessionStorage.setItem(storageKey, JSON.stringify(session));
    else sessionStorage.removeItem(storageKey);
  } catch { /* The current session still works when browser storage is blocked. */ }
}
function hasStream() { return stream?.getVideoTracks().some((track) => track.readyState === 'live') || false; }
function stopStream(value) { value?.getTracks().forEach((track) => track.stop()); }
function send(type, data = {}) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type, ...data }));
  return true;
}

function member(id) { return room?.members.find((item) => item.id === id); }
function self() { return member(room?.you); }
function sharerMember() { return room?.members.find((item) => item.role === 'sharer'); }
// No name means Anonymous; their laser colour still tells them apart.
function nameOf(person) { return person?.name || 'Anonymous'; }
function viewers() { return room?.members.filter((item) => item.role === 'viewer' && item.id !== room.you) || []; }
function sharerLink() { return room?.role === 'viewer' ? links.get(sharerMember()?.id) : undefined; }

function closeLink(id) {
  const link = links.get(id);
  if (!link) return;
  links.delete(id);
  clearTimeout(link.timer);
  clearTimeout(link.disconnectTimer);
  link.pc.close();
  link.channel?.close();
  if (link.sharing) {
    board.clear(id);
    relay(id, { hide: true });
  } else {
    pointerDown = false;
    board.clear();
    ui.remoteVideo.srcObject = null;
  }
}
function closeLinks() { for (const id of [...links.keys()]) closeLink(id); }

function cancelCapture() {
  captureJob = null;
  stopStream(pendingStream);
  pendingStream = null;
}

function goHome(message = '', error = false) {
  lifecycle++;
  clearTimeout(reconnectTimer);
  clearTimeout(handshakeTimer);
  clearTimeout(copyTimer);
  ui.copyBtn.textContent = 'Copy link';
  ui.inviteBtn.textContent = 'Copy invite link';
  const previous = socket;
  socket = null;
  previous?.close();
  closeLinks();
  board.clear();
  cancelCapture();
  stopStream(stream);
  stream = null;
  ui.localVideo.srcObject = null;
  room = null;
  session = null;
  laserMode = false;
  laserWanted = null;
  laserResume = false;
  peopleOpen = false;
  closePip();
  persist();
  online = false;
  busy = false;
  reconnectStarted = 0;
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  notice(message, error);
  render();
}

function laserOn() { return room?.role === 'sharer' && (laserWanted ?? room.laser) === true; }
function canPoint() {
  return room?.role === 'viewer' && room.laser && online && room.ready && room.sharerOnline
    && !room.paused && sharerLink()?.status === 'connected' && Boolean(ui.remoteVideo.srcObject);
}

function sendOn(channel, data) {
  if (channel?.readyState === 'open' && channel.bufferedAmount < 16384) channel.send(data);
}
function sendPoint(value) { sendOn(sharerLink()?.channel, encodePoint(value)); }
// The sharer passes each viewer's pointer on to everyone else watching.
function relay(from, value) {
  const data = encodePoint(value, from);
  for (const link of links.values()) if (link.sharing && link.id !== from) sendOn(link.channel, data);
}
function point(value) {
  board.apply(room.you, value);
  sendPoint(value);
}
board.look = (id) => {
  const person = member(id);
  // Name tags help tell pointers apart once more than one other person could point.
  const label = !person || id === room?.you || (!person.name && (room?.members.length || 0) <= 2) ? '' : nameOf(person);
  return { style: person?.style || 'red', label };
};

function setLaser(on) {
  laserRequest = Math.max(laserRequest + 1, Date.now());
  if (!send('laser', { on, id: laserRequest })) return;
  laserWanted = on;
  // Opening the floating window needs this click, so it happens before anything async.
  if (on) openPip();
  render();
}

function openPip() {
  const job = ++pipJob;
  const fallback = 'Your browser can’t float a window over other apps, so the laser shows in the preview on this tab. Chrome and Edge can float it.';
  if (!window.documentPictureInPicture) { notice(fallback); return; }
  const { width: sourceWidth, height: sourceHeight } = stream?.getVideoTracks()[0]?.getSettings() || {};
  const aspect = sourceWidth && sourceHeight ? Math.min(Math.max(sourceWidth / sourceHeight, 0.6), 2.6) : 16 / 9;
  const width = Math.round(Math.min(640, Math.max(440, screen.availWidth * 0.34)));
  documentPictureInPicture.requestWindow({ width, height: Math.round(width / aspect) + 46 }).then((win) => {
    if (job !== pipJob || !laserOn()) win.close();
    else buildPip(win);
  }, () => {
    if (job === pipJob && laserOn()) notice('The floating laser window couldn’t open, so the laser shows in the preview on this tab.');
  });
}

function buildPip(win) {
  const doc = win.document;
  doc.title = 'Screenpeek laser';
  const style = doc.createElement('style');
  style.textContent = `
    html, body { margin: 0; height: 100%; background: #17211d; color: #e6ede7; overflow: hidden;
      font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { display: flex; flex-direction: column; }
    .frame { position: relative; flex: 1; min-height: 0; box-shadow: inset 0 0 0 0 #ff3b3000; }
    .frame.flash { animation: flash .6s ease-out; }
    @keyframes flash { 0% { box-shadow: inset 0 0 0 4px #ff3b30cc; } 100% { box-shadow: inset 0 0 0 0 #ff3b3000; } }
    video, canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    video { object-fit: contain; }
    canvas { pointer-events: none; }
    .paused { position: absolute; inset: 0; display: grid; place-items: center; background: #17211dd9; color: #c9d5cd; text-align: center; padding: 16px; }
    .paused[hidden] { display: none; }
    .bar { display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 8px 0 14px; box-sizing: border-box; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #ff2d2d; box-shadow: 0 0 8px #ff2d2d; }
    .label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button { font: inherit; color: #e6ede7; background: transparent; border: 1px solid #3e5145; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
    button:hover { background: #283a2f; }
    @media (prefers-reduced-motion: reduce) { .frame.flash { animation: none; } }`;
  doc.head.append(style);
  doc.body.innerHTML = `<div class="frame"><video autoplay muted playsinline></video><canvas></canvas>
    <div class="paused" hidden>Sharing paused · nobody can see your screen</div></div>
    <div class="bar"><span class="dot"></span><span class="label">Laser pointer on · viewers can point at your screen</span><button type="button">Turn off</button></div>`;
  const video = doc.querySelector('video');
  const frame = doc.querySelector('.frame');
  const flash = (type) => {
    if (type !== 'press') return;
    frame.classList.remove('flash');
    void frame.offsetWidth;
    frame.classList.add('flash');
  };
  const current = { win, video, frame, flash, paused: doc.querySelector('.paused'), view: new LaserView(doc.querySelector('canvas'), video, board) };
  board.listeners.add(flash);
  pip = current;
  doc.querySelector('button').addEventListener('click', () => setLaser(false));
  win.addEventListener('pagehide', () => {
    if (pip !== current) return;
    dropPip();
    // Closing the floating window is how the sharer turns the laser off.
    if (laserOn() && online) {
      setLaser(false);
      notice('Laser pointer turned off.');
    }
  });
  render();
}

function dropPip() {
  if (!pip) return;
  pip.view.destroy();
  board.listeners.delete(pip.flash);
  pip.video.srcObject = null;
  pip = null;
}

function closePip() {
  pipJob++;
  const win = pip?.win;
  dropPip();
  win?.close();
}

function syncLaser() {
  const sharer = room?.role === 'sharer';
  if (!laserOn()) closePip();
  if (!room?.laser || sharer) laserMode = false;
  const pointing = laserMode && canPoint();
  if (!pointing) pointerDown = false;
  const own = room && !sharer ? board.get(room.you) : null;
  if (own && !pointing) {
    if (own.cursor) sendPoint({ hide: true });
    board.clear(room.you);
  }
  // Viewers see others' pointers under the same conditions that let them point.
  const showing = sharer ? laserOn() && !room.paused && hasStream() : canPoint();
  if (!showing && board.traces.size) board.clear();
  for (const id of board.traces.keys()) if (!member(id)) board.clear(id);
  ui.laserCanvas.classList.toggle('pointing', pointing);
  const video = sharer ? ui.localVideo : ui.remoteVideo;
  if (stageView?.video !== video || !room) {
    stageView?.destroy();
    stageView = room ? new LaserView(ui.laserCanvas, video, board) : null;
  }
  stageView?.wake();
  if (pip) {
    if (pip.video.srcObject !== stream) {
      pip.video.srcObject = stream;
      pip.video.play().catch(() => {});
    }
    pip.paused.hidden = !room.paused;
    pip.view.wake();
  }
}

// The people panel: your name, your laser, and everyone in the room.
function renderPeople() {
  const me = self();
  const sharer = room.role === 'sharer';
  ui.peopleCount.textContent = String(room.members.length);
  ui.peopleBtn.setAttribute('aria-label', `People: ${room.members.length} of 7. Your name and laser`);
  ui.peopleBtn.setAttribute('aria-expanded', String(peopleOpen));
  ui.peopleBtn.style.setProperty('--swatch', swatch(me?.style));
  visible(ui.peoplePanel, peopleOpen);
  document.body.classList.toggle('people-open', peopleOpen);
  ui.nameInput.disabled = !online;
  ui.saveNameBtn.disabled = !online;
  const key = JSON.stringify([room.you, room.members, online, sharer && [...links].map(([id, link]) => [id, link.status])]);
  if (key === peopleKey) return;
  peopleKey = key;

  const holders = new Map(room.members.map((person) => [person.style, person]));
  // Rebuilding the options would otherwise drop keyboard focus on the one just chosen.
  const focused = document.activeElement?.closest?.('.style-option')?.dataset.style;
  ui.styleOptions.replaceChildren(...LASER_STYLES.map((style) => {
    const holder = holders.get(style.id);
    const mine = holder?.id === room.you;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'style-option';
    button.dataset.style = style.id;
    button.style.setProperty('--swatch', swatch(style.id));
    button.setAttribute('aria-pressed', String(mine));
    button.disabled = !online || (holder && !mine);
    const taken = holder && !mine ? ` · taken by ${nameOf(holder)}` : '';
    button.setAttribute('aria-label', `${style.name}${mine ? ' · yours' : taken}`);
    button.title = `${style.name}${mine ? ' (yours)' : taken}`;
    const dot = document.createElement('span');
    dot.className = 'style-swatch';
    const label = document.createElement('span');
    label.className = 'style-name';
    label.textContent = style.name;
    button.append(dot, label);
    return button;
  }));
  if (focused) {
    const option = ui.styleOptions.querySelector(`[data-style="${focused}"]`);
    (option && !option.disabled ? option : ui.peoplePanel).focus({ preventScroll: true });
  }

  ui.peopleList.replaceChildren(...room.members.map((person) => {
    const item = document.createElement('li');
    item.className = 'person';
    const dot = document.createElement('span');
    dot.className = 'person-dot';
    dot.style.setProperty('--swatch', swatch(person.style));
    dot.title = `${styleName(person.style)} laser`;
    const name = document.createElement('span');
    name.className = 'person-name';
    name.textContent = nameOf(person);
    const tags = [];
    if (person.id === room.you) tags.push('you');
    if (person.role === 'sharer') tags.push('sharing');
    let state = '';
    if (!person.online) state = 'Reconnecting…';
    else if (sharer && person.id !== room.you) {
      const status = links.get(person.id)?.status;
      state = status === 'connected' ? 'Watching' : status === 'failed' ? 'Couldn’t connect' : 'Connecting…';
    }
    item.append(dot, name, ...tags.map((text) => {
      const tag = document.createElement('span');
      tag.className = 'person-tag';
      tag.textContent = text;
      return tag;
    }));
    if (state) {
      const status = document.createElement('span');
      status.className = 'person-state';
      status.textContent = state;
      item.append(status);
    }
    return item;
  }));
}

function openPeople(open) {
  if (open === peopleOpen || !room) return;
  peopleOpen = open;
  if (open) ui.nameInput.value = self()?.name || '';
  render();
  // Straight to the name field while you don't have one yet.
  if (open && !self()?.name) ui.nameInput.focus({ preventScroll: true });
}

function render() {
  syncLaser();
  document.body.classList.toggle('is-viewer', room?.role === 'viewer');
  visible(ui.home, !room);
  visible(ui.session, Boolean(room));
  ui.startBtn.disabled = busy || Boolean(captureJob);
  ui.joinBtn.disabled = busy || Boolean(captureJob);
  ui.codeInput.disabled = busy || Boolean(captureJob);
  ui.startBtn.textContent = captureJob?.kind === 'create' ? 'Choose your screen…' : busy && !room ? 'Connecting…' : 'Share my screen ↗';
  if (!room) {
    visible(ui.peoplePanel, false);
    document.body.classList.remove('people-open');
    peopleKey = '';
    return;
  }

  const sharer = room.role === 'sharer';
  ui.session.dataset.role = room.role;
  const watchers = sharer ? viewers() : [];
  const watching = watchers.filter((person) => person.online);
  const statuses = watching.map((person) => links.get(person.id)?.status || 'connecting');
  const connectedCount = statuses.filter((status) => status === 'connected').length;
  const peerStatus = sharer
    ? (connectedCount ? 'connected' : statuses.length && statuses.every((status) => status === 'failed') ? 'failed' : 'connecting')
    : sharerLink()?.status || 'idle';
  const connected = peerStatus === 'connected';
  const live = online && room.ready && !room.paused && hasStream();
  const sharerName = nameOf(sharerMember());
  ui.roleLabel.textContent = sharer ? 'You have the floor' : 'A shared view';
  ui.sessionTitle.textContent = sharer ? 'Sharing your screen' : `Watching ${sharerName}’s screen`;
  ui.roomCode.textContent = room.code;
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', room.code);
  ui.shareLink.value = url.toString();

  let status = 'Connecting…', tone = 'waiting';
  let title = 'Connecting your screens', description = 'This should only take a moment.';
  let overlay = true;
  if (!online) {
    status = 'Reconnecting…';
    title = 'Reconnecting to your screenpeek';
    description = 'Keep this tab open. We’ll bring you back automatically.';
  } else if (sharer && (!hasStream() || !room.ready)) {
    status = 'Ready to resume';
    title = 'You’re still in the room';
    description = 'After a refresh, choose your screen again to resume sharing.';
  } else if (!sharer && !room.sharerOnline) {
    status = 'Sharer reconnecting';
    title = 'The sharer is reconnecting';
    description = 'Your room is still open. Their screen will return when they reconnect.';
  } else if (!sharer && !room.ready) {
    status = 'Waiting for screen';
    title = 'Waiting for their screen';
    description = 'The sharer is back and needs to choose a screen to continue.';
  } else if (room.paused) {
    status = 'Paused';
    title = 'Sharing paused';
    description = sharer ? 'Your screen is hidden from everyone. Resume whenever you’re ready.' : `${sharerName} paused their screen. It will return when they resume.`;
  } else if (sharer && !watching.length) {
    status = watchers.length ? 'Viewer reconnecting' : 'Waiting for viewer';
    overlay = !live;
  } else if (peerStatus === 'failed') {
    status = 'Couldn’t connect'; tone = 'error';
    title = 'Let’s try that again';
    description = 'The screen connection was interrupted. Retry, or try another network if it keeps happening.';
  } else if (sharer) {
    if (connectedCount) tone = 'live';
    if (connectedCount === watching.length) status = connectedCount === 1 ? 'Viewer connected' : `${connectedCount} viewers connected`;
    else if (connectedCount) status = `${connectedCount} of ${watching.length} viewers connected`;
    overlay = !live;
  } else if (connected) {
    status = 'Live'; tone = 'live';
    overlay = false;
  }

  ui.sessionStatus.textContent = status;
  ui.statusBadge.dataset.tone = tone;
  ui.stageTitle.textContent = title;
  ui.stageDescription.textContent = description;
  visible(ui.stageOverlay, overlay);
  visible(ui.localVideo, sharer && live && !overlay);
  visible(ui.remoteVideo, !sharer && !overlay);
  visible(ui.previewLabel, sharer && !overlay);
  visible(ui.invitePanel, sharer);
  visible(ui.resumeBtn, online && sharer && (!hasStream() || !room.ready));
  ui.resumeBtn.disabled = Boolean(captureJob);
  ui.resumeBtn.textContent = captureJob ? 'Choose your screen…' : 'Resume sharing';
  visible(ui.retryBtn, online && room.ready && peerStatus === 'failed' && !room.paused && (sharer ? watching.length > 0 : room.sharerOnline));
  visible(ui.pauseBtn, sharer);
  ui.pauseBtn.textContent = room.paused ? 'Resume' : 'Pause';
  ui.pauseBtn.disabled = !online || !hasStream() || !room.ready;
  visible(ui.flipBtn, sharer);
  ui.flipBtn.disabled = !online || !hasStream() || !room.ready || !watching.length || Boolean(room.flipId);
  ui.flipBtn.textContent = room.flipId ? 'Flip requested' : 'Flip ⇄';
  ui.leaveBtn.textContent = sharer ? 'End screenpeek' : 'Leave';
  ui.leaveBtn.title = sharer && room.members.length > 1 ? 'Ends the screenpeek for everyone' : '';
  visible(ui.laserBtn, sharer || room.laser);
  const laserActive = sharer ? laserOn() : laserMode;
  ui.laserBtn.setAttribute('aria-pressed', String(laserActive));
  ui.laserBtn.style.setProperty('--swatch', swatch(sharer ? 'red' : self()?.style));
  ui.laserBtn.disabled = sharer ? !online || !hasStream() || !room.ready : !canPoint();
  ui.laserLabel.textContent = sharer ? (laserActive ? 'Laser on' : 'Laser pointer') : (laserActive ? 'Pointing' : 'Laser');
  ui.laserBtn.title = sharer
    ? (laserActive ? 'Turn off the laser pointer' : 'Let viewers point at your screen with a laser pointer')
    : (laserActive ? 'Stop pointing (Esc)' : 'Point at their screen. Click and drag to circle something.');
  const full = room.members.length >= 7;
  ui.sessionHint.textContent = sharer
    ? (room.members.length === 1 ? 'Invite up to six people with the code or link above.'
      : laserActive ? 'Viewers can point at your screen. The floating window shows where.'
        : full ? 'The room is full: seven people. Flip to give someone else the floor.'
          : 'Pause for privacy. Flip to give someone else the floor.')
    : 'You can stay in this room while you take turns sharing.';

  const flipping = online && Boolean(room.flipId);
  const group = sharer ? watching.length > 1 : room.members.length > 2;
  visible(ui.flipPrompt, flipping);
  visible(ui.acceptFlipBtn, !sharer);
  visible(ui.declineFlipBtn, !sharer);
  visible(ui.cancelFlipBtn, sharer);
  ui.acceptFlipBtn.disabled = Boolean(captureJob);
  ui.acceptFlipBtn.textContent = captureJob ? 'Choose your screen…' : 'Accept & share';
  ui.declineFlipBtn.disabled = Boolean(captureJob);
  ui.flipTitle.textContent = sharer ? (group ? 'Offering the floor to everyone' : 'Waiting for them to accept') : 'Your turn to share?';
  ui.flipDescription.textContent = sharer
    ? (group ? 'Whoever accepts first shares next. You keep the floor until then and can cancel any time.'
      : 'You keep the floor until they choose a screen. You can cancel any time.')
    : (group ? `${sharerName} is offering the floor. Whoever accepts first shares next; their screen stays live until then.`
      : 'Choose what to share. Their screen stays live until you accept.');
  renderPeople();
}

function watchStream(value) {
  value.getVideoTracks()[0].addEventListener('ended', () => {
    if (stream === value && room?.role === 'sharer') {
      send('end');
      goHome('Screen sharing stopped. Your screenpeek has ended.');
    } else if (pendingStream === value) {
      send('decline-flip', { flipId: room?.flipId });
      cancelCapture();
      notice('Screen selection ended. The current sharer keeps the floor.');
      render();
    }
  }, { once: true });
}

function connect(action) {
  clearTimeout(reconnectTimer);
  clearTimeout(handshakeTimer);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  socket = ws;
  handshakeTimer = setTimeout(() => {
    if (socket === ws) ws.close();
  }, 8000);
  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    if (action.type === 'resume') {
      action = { ...action, hasStream: hasStream(), paused: Boolean(stream && !stream.getVideoTracks()[0].enabled), laser: laserOn() };
      laserResume = true;
    }
    ws.send(JSON.stringify(action));
  });
  ws.addEventListener('message', (event) => {
    messages = messages.then(async () => {
      if (socket !== ws) return;
      await onMessage(JSON.parse(event.data));
    }).catch((error) => {
      console.error('Session message failed', error);
      if (socket === ws) for (const link of links.values()) linkFailed(link);
    });
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    clearTimeout(handshakeTimer);
    online = false;
    closeLinks();
    cancelCapture();
    if (!session) {
      goHome('Could not reach the sharing service. Please try again.', true);
      return;
    }
    reconnectStarted ||= Date.now();
    if (Date.now() - reconnectStarted >= 20000) {
      goHome('Connection lost. Please join again or start a new screenpeek.', true);
      return;
    }
    render();
    reconnectTimer = setTimeout(() => connect({ type: 'resume', ...session }), 700);
  });
}

function linkFailed(link) {
  if (links.get(link.id) !== link) return;
  link.status = 'failed';
  clearTimeout(link.timer);
  render();
}

function openLink(id, epoch) {
  closeLink(id);
  const sharing = room.role === 'sharer';
  const pc = new RTCPeerConnection(rtcConfig);
  const link = { id, pc, epoch, sharing, status: 'connecting', candidates: [], channel: null };
  links.set(id, link);
  const current = () => links.get(id) === link;
  link.timer = setTimeout(() => linkFailed(link), 15000);
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && current()) signal(link, { candidate });
  };
  pc.ondatachannel = ({ channel }) => {
    if (current() && !sharing && channel.label === 'laser') watchChannel(link, channel);
  };
  pc.ontrack = ({ streams }) => {
    if (!current() || sharing) return;
    ui.remoteVideo.srcObject = streams[0];
    ui.remoteVideo.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (!current()) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(link.timer);
      clearTimeout(link.disconnectTimer);
      link.status = 'connected';
    } else if (pc.connectionState === 'failed') linkFailed(link);
    else if (pc.connectionState === 'disconnected') {
      link.status = 'connecting';
      link.disconnectTimer = setTimeout(() => linkFailed(link), 5000);
    }
    render();
  };
  return link;
}

function signal(link, data) {
  send('signal', link.sharing ? { to: link.id, epoch: link.epoch, data } : { epoch: link.epoch, data });
}

function watchChannel(link, channel) {
  link.channel = channel;
  channel.addEventListener('message', ({ data }) => {
    if (links.get(link.id) !== link || !room) return;
    const value = parsePoint(data);
    if (!value) return;
    if (link.sharing) {
      // The sharer decides whether pointing is allowed, so it filters what arrives,
      // and it knows who sent each point from the connection it came in on.
      if (!laserOn() || room.paused) return;
      board.apply(link.id, value);
      relay(link.id, value);
    } else if (canPoint() && value.from && value.from !== room.you && member(value.from)) {
      board.apply(value.from, value);
    }
  });
  channel.addEventListener('close', () => {
    if (link.channel !== channel) return;
    link.channel = null;
    if (link.sharing) {
      board.clear(link.id);
      relay(link.id, { hide: true });
    } else board.clear();
  });
}

async function offer(link) {
  try {
    for (const track of stream.getTracks()) link.pc.addTrack(track, stream);
    watchChannel(link, link.pc.createDataChannel('laser', { ordered: true, maxRetransmits: 0 }));
    const description = await link.pc.createOffer();
    if (links.get(link.id) !== link) return;
    await link.pc.setLocalDescription(description);
    if (links.get(link.id) === link) signal(link, { description: link.pc.localDescription });
  } catch (error) {
    // A connection closed mid-offer was replaced on purpose; only a live one has failed.
    if (links.get(link.id) !== link) return;
    console.warn('Could not start a screen connection', error);
    linkFailed(link);
  }
}

// Bring connections in line with the room: one per online viewer for the
// sharer, one to the sharer for a viewer. Connections whose generation is
// unchanged are left alone, so people joining or leaving don't interrupt others.
async function reconcile() {
  const wanted = new Map();
  if (room && online && room.ready) {
    if (room.role === 'sharer') {
      if (hasStream()) for (const person of viewers()) if (person.online) wanted.set(person.id, person.link);
    } else if (room.sharerOnline && sharerMember()) wanted.set(sharerMember().id, room.epoch);
  }
  const sharing = room?.role === 'sharer';
  for (const [id, link] of [...links]) {
    if (wanted.get(id) !== link.epoch || link.sharing !== sharing) closeLink(id);
  }
  const offers = [];
  for (const [id, epoch] of wanted) {
    if (links.has(id)) continue;
    const link = openLink(id, epoch);
    if (link.sharing) offers.push(offer(link));
  }
  await Promise.all(offers);
}

async function applySignal(link, data) {
  const { pc } = link;
  const { description, candidate } = data;
  const current = () => links.get(link.id) === link;
  if (description) {
    if ((!link.sharing && description.type !== 'offer') || (link.sharing && description.type !== 'answer')) return;
    await pc.setRemoteDescription(description);
    if (!current()) return;
    for (const queued of link.candidates) await pc.addIceCandidate(queued);
    link.candidates = [];
    if (description.type === 'offer') {
      const answer = await pc.createAnswer();
      if (!current()) return;
      await pc.setLocalDescription(answer);
      if (current()) signal(link, { description: pc.localDescription });
    }
  }
  if (candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(candidate);
    else link.candidates.push(candidate);
  }
}

async function onMessage(msg) {
  if (msg.type === 'session') {
    session = { code: msg.code, token: msg.token };
    persist();
    const url = new URL(location.href);
    url.searchParams.set('room', msg.code);
    history.replaceState(null, '', url);
    return;
  }
  if (msg.type === 'state') {
    clearTimeout(handshakeTimer);
    reconnectStarted = 0;
    online = true;
    busy = false;
    const previous = room;
    room = msg;
    if (!previous) notice();
    if (laserResume || previous?.role !== room.role || room.laserId === laserRequest) laserWanted = null;
    laserResume = false;
    if (room.role === 'sharer' && pendingStream) {
      stream = pendingStream;
      pendingStream = null;
      captureJob = null;
      ui.localVideo.srcObject = stream;
    }
    if (room.role === 'viewer') {
      stopStream(stream);
      stream = null;
      ui.localVideo.srcObject = null;
      if (captureJob?.kind === 'flip' && captureJob.flipId !== room.flipId) cancelCapture();
    } else if (hasStream()) {
      stream.getVideoTracks().forEach((track) => { track.enabled = !room.paused; });
    }
    if (captureJob?.kind === 'resume' && room.ready) captureJob = null;
    if (captureJob?.kind === 'create') captureJob = null;
    if (room.role === 'sharer' && room.ready && !hasStream()) send('not-ready');
    const before = previous?.members.find((person) => person.role === 'sharer');
    const now = sharerMember();
    if (previous?.role && previous.role !== room.role) notice(room.role === 'sharer' ? 'Floor flipped. You’re now sharing.' : `Floor flipped. ${nameOf(now)} is sharing now.`);
    else if (room.role === 'viewer' && before && now && before.id !== now.id) notice(`Floor flipped. ${nameOf(now)} is sharing now.`);
    else if (room.role === 'viewer' && room.laser !== Boolean(previous?.laser)) {
      if (room.laser) {
        notice('They turned on the laser pointer. Choose Laser to point at their screen.');
        ui.laserBtn.classList.add('invite');
      } else notice('They turned off the laser pointer.');
    }
    await reconcile();
    render();
    return;
  }
  if (msg.type === 'signal') {
    if (!room || !msg.data || typeof msg.data !== 'object') return;
    const link = links.get(room.role === 'sharer' ? msg.from : sharerMember()?.id);
    if (!link || msg.epoch !== link.epoch) return;
    try {
      await applySignal(link, msg.data);
    } catch (error) {
      if (links.get(link.id) !== link) return;
      console.warn('Screen connection signal failed', error);
      linkFailed(link);
    }
    return;
  }
  if (msg.type === 'ended' || (msg.type === 'error' && msg.fatal)) {
    goHome(msg.message, msg.type === 'error');
  } else if (msg.type === 'flip-rejected') {
    // Losing the race for the floor is part of taking turns, not an error.
    cancelCapture();
    notice(msg.message);
    render();
  } else if (msg.type === 'notice' || msg.type === 'error') notice(msg.message, msg.type === 'error');
}

async function capture(kind) {
  if (captureJob || (kind !== 'create' && !online)) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    notice('Screen sharing is unavailable in this browser. Use a desktop browser on HTTPS or localhost. You can still join as a viewer.', true);
    return;
  }
  const job = { kind, flipId: room?.flipId, lifecycle };
  captureJob = job;
  notice();
  render();
  let captured;
  try {
    // Keep this call directly in the click handler's task: capture requires user activation.
    captured = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 20, max: 30 } }, audio: false
    });
    if (captureJob !== job || lifecycle !== job.lifecycle || (kind !== 'create' && !online)
      || (kind === 'flip' && room?.flipId !== job.flipId)) {
      stopStream(captured);
      return;
    }
    if (captured.getVideoTracks()[0]?.readyState !== 'live') throw new Error('The selected screen is no longer available.');
    watchStream(captured);
    if (kind === 'flip') {
      pendingStream = captured;
      if (!send('accept-flip', { flipId: job.flipId })) throw new Error('The connection was lost.');
    } else {
      stream = captured;
      ui.localVideo.srcObject = stream;
      if (kind === 'create') {
        busy = true;
        connect({ type: 'create' });
      } else if (!send('ready')) throw new Error('The connection was lost.');
    }
  } catch (error) {
    stopStream(captured);
    if (captureJob !== job) return;
    if (stream === captured) stream = null;
    pendingStream = null;
    captureJob = null;
    busy = false;
    if (kind === 'flip') send('decline-flip', { flipId: job.flipId });
    const cancelled = error.name === 'NotAllowedError' || error.name === 'AbortError';
    notice(cancelled
      ? (kind === 'flip' ? 'Screen selection cancelled. The current sharer keeps the floor.' : 'Screen selection cancelled. You can try again when you’re ready.')
      : 'Could not share that screen. Check your browser’s screen-recording permission and try again.', !cancelled);
  }
  render();
}

function join(code) {
  if (busy || captureJob) return;
  if (!/^\d{6}$/.test(code)) { notice('Enter a six-digit share code.', true); return; }
  busy = true;
  notice('Joining your screenpeek…');
  render();
  connect({ type: 'join', code });
}

ui.startBtn.addEventListener('click', () => capture('create'));
ui.resumeBtn.addEventListener('click', () => capture('resume'));
ui.acceptFlipBtn.addEventListener('click', () => capture('flip'));
ui.joinForm.addEventListener('submit', (event) => { event.preventDefault(); join(ui.codeInput.value.trim()); });
ui.codeInput.addEventListener('input', () => { ui.codeInput.value = ui.codeInput.value.replace(/\D/g, '').slice(0, 6); });
ui.flipBtn.addEventListener('click', () => {
  ui.flipBtn.disabled = true;
  notice();
  send('request-flip');
});
ui.cancelFlipBtn.addEventListener('click', () => send('cancel-flip', { flipId: room?.flipId }));
ui.declineFlipBtn.addEventListener('click', () => send('decline-flip', { flipId: room?.flipId }));
ui.pauseBtn.addEventListener('click', () => {
  if (!hasStream() || !online) return;
  const paused = !room.paused;
  // Stop sending visible frames immediately, before the server acknowledges.
  stream.getVideoTracks().forEach((track) => { track.enabled = !paused; });
  room = { ...room, paused };
  send('pause', { paused });
  render();
});
ui.laserBtn.addEventListener('click', () => {
  if (!room) return;
  if (room.role === 'sharer') setLaser(!laserOn());
  else {
    laserMode = !laserMode && canPoint();
    if (laserMode) notice();
    render();
  }
});
ui.laserBtn.addEventListener('animationend', () => ui.laserBtn.classList.remove('invite'));

ui.peopleBtn.addEventListener('click', () => openPeople(!peopleOpen));
ui.closePeopleBtn.addEventListener('click', () => {
  openPeople(false);
  ui.peopleBtn.focus();
});
ui.nameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (send('name', { name: ui.nameInput.value })) ui.nameInput.blur();
});
ui.styleOptions.addEventListener('click', (event) => {
  const option = event.target.closest('.style-option');
  if (option && !option.disabled) send('style', { style: option.dataset.style });
});
// Clicking anywhere else closes the panel.
document.addEventListener('pointerdown', (event) => {
  if (peopleOpen && !ui.peoplePanel.contains(event.target) && !ui.peopleBtn.contains(event.target)) openPeople(false);
});

function pointerAt(event) {
  const box = ui.laserCanvas.getBoundingClientRect();
  const rect = contentRect(ui.remoteVideo, box.width, box.height);
  if (!rect) return null;
  return { x: (event.clientX - box.left - rect.x) / rect.width, y: (event.clientY - box.top - rect.y) / rect.height };
}
const inside = (value) => value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1;
const clamp = (value) => Math.min(1, Math.max(0, value));
function pointing() { return ui.laserCanvas.classList.contains('pointing'); }
function ownCursor() { return Boolean(room && board.get(room.you)?.cursor); }
function hidePointer() {
  pointerDown = false;
  if (ownCursor()) point({ hide: true });
}

ui.laserCanvas.addEventListener('pointerdown', (event) => {
  if (!pointing() || event.button !== 0) return;
  const value = pointerAt(event);
  if (!value || !inside(value)) return;
  event.preventDefault();
  ui.laserCanvas.setPointerCapture(event.pointerId);
  pointerDown = true;
  point({ ...value, down: true });
});
ui.laserCanvas.addEventListener('pointermove', (event) => {
  if (!pointing()) return;
  const value = pointerAt(event);
  if (!value) return;
  // While drawing, keep the line on the screen edge instead of breaking it.
  if (pointerDown) point({ x: clamp(value.x), y: clamp(value.y), down: true });
  else if (event.pointerType !== 'touch' && inside(value)) point({ ...value, down: false });
  else if (ownCursor()) point({ hide: true });
});
for (const type of ['pointerup', 'pointercancel']) {
  ui.laserCanvas.addEventListener(type, (event) => {
    if (!pointerDown) return;
    pointerDown = false;
    const value = pointerAt(event);
    if (type === 'pointercancel' || event.pointerType === 'touch' || !value || !inside(value)) point({ hide: true });
    else point({ ...value, down: false });
  });
}
ui.laserCanvas.addEventListener('pointerleave', () => { if (!pointerDown) hidePointer(); });
window.addEventListener('blur', () => { if (pointing()) hidePointer(); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (peopleOpen) {
    openPeople(false);
    ui.peopleBtn.focus();
  } else if (laserMode) {
    laserMode = false;
    render();
  }
});

ui.retryBtn.addEventListener('click', () => {
  notice();
  for (const link of links.values()) link.status = 'connecting';
  render();
  send('retry');
});
ui.leaveBtn.addEventListener('click', () => {
  const sharing = room?.role === 'sharer';
  send(sharing ? 'end' : 'leave');
  goHome(sharing ? 'Your screenpeek has ended.' : 'You left the screenpeek.');
});
async function copyLink(button) {
  try {
    await navigator.clipboard.writeText(ui.shareLink.value);
    button.textContent = 'Copied!';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      ui.copyBtn.textContent = 'Copy link';
      ui.inviteBtn.textContent = 'Copy invite link';
    }, 1800);
  } catch {
    if (button === ui.copyBtn) {
      ui.shareLink.focus();
      ui.shareLink.select();
      notice('Copy the selected link to invite someone.');
    } else notice(`Copying was blocked. Share this link: ${ui.shareLink.value}`);
  }
}
ui.copyBtn.addEventListener('click', () => copyLink(ui.copyBtn));
ui.inviteBtn.addEventListener('click', () => copyLink(ui.inviteBtn));
document.querySelector('.brand').addEventListener('click', (event) => {
  event.preventDefault();
  if (room) send(room.role === 'sharer' ? 'end' : 'leave');
  goHome();
});
window.addEventListener('pagehide', () => {
  // Refresh is a temporary disconnect, not an explicit leave.
  stopStream(stream);
  stopStream(pendingStream);
  socket?.close();
});

const incoming = new URLSearchParams(location.search).get('room');
try {
  const saved = JSON.parse(sessionStorage.getItem(storageKey));
  if (saved && saved.code === incoming && typeof saved.token === 'string') session = saved;
} catch { /* No recoverable session. */ }
if (session) {
  busy = true;
  notice('Rejoining your screenpeek…');
  connect({ type: 'resume', ...session });
} else if (incoming) join(incoming);
render();

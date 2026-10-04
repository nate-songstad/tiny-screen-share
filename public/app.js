const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map((el) => [el.id, el]));
const storageKey = 'screenpeek.session.v3';
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let socket, session, room, stream, pendingStream, peer, captureJob;
let online = false;
let busy = false;
let peerStatus = 'idle';
let peerEpoch = -1;
let candidates = [];
let messages = Promise.resolve();
let reconnectTimer, handshakeTimer, peerTimer, disconnectTimer;
let reconnectStarted = 0;
let copyTimer;
let lifecycle = 0;

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

function closePeer() {
  clearTimeout(peerTimer);
  clearTimeout(disconnectTimer);
  const previous = peer;
  peer = null;
  previous?.close();
  peerEpoch = -1;
  candidates = [];
  peerStatus = 'idle';
  ui.remoteVideo.srcObject = null;
}

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
  const previous = socket;
  socket = null;
  previous?.close();
  closePeer();
  cancelCapture();
  stopStream(stream);
  stream = null;
  ui.localVideo.srcObject = null;
  room = null;
  session = null;
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

function render() {
  visible(ui.home, !room);
  visible(ui.session, Boolean(room));
  ui.startBtn.disabled = busy || Boolean(captureJob);
  ui.joinBtn.disabled = busy || Boolean(captureJob);
  ui.codeInput.disabled = busy || Boolean(captureJob);
  ui.startBtn.textContent = captureJob?.kind === 'create' ? 'Choose your screen…' : busy && !room ? 'Connecting…' : 'Share my screen ↗';
  if (!room) return;

  const sharer = room.role === 'sharer';
  ui.session.dataset.role = room.role;
  const connected = peerStatus === 'connected';
  const live = online && room.ready && !room.paused && hasStream();
  ui.roleLabel.textContent = sharer ? 'You have the floor' : 'A shared view';
  ui.sessionTitle.textContent = sharer ? 'Sharing your screen' : 'Watching their screen';
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
    description = sharer ? 'Your screen is hidden from the viewer. Resume whenever you’re ready.' : 'Your partner has paused their screen. It will return when they resume.';
  } else if (room.partner !== 'online' && sharer) {
    status = room.partner === 'reconnecting' ? 'Viewer reconnecting' : 'Waiting for viewer';
    overlay = !live;
  } else if (peerStatus === 'failed') {
    status = 'Couldn’t connect'; tone = 'error';
    title = 'Let’s try that again';
    description = 'The screen connection was interrupted. Retry, or try another network if it keeps happening.';
  } else if (connected) {
    status = sharer ? 'Viewer connected' : 'Live'; tone = 'live';
    overlay = false;
  } else if (sharer && live) overlay = false;

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
  visible(ui.retryBtn, online && room.ready && room.partner === 'online' && peerStatus === 'failed' && !room.paused);
  visible(ui.pauseBtn, sharer);
  ui.pauseBtn.textContent = room.paused ? 'Resume' : 'Pause';
  ui.pauseBtn.disabled = !online || !hasStream() || !room.ready;
  visible(ui.flipBtn, sharer);
  ui.flipBtn.disabled = !online || !hasStream() || !room.ready || room.partner !== 'online' || Boolean(room.flipId);
  ui.flipBtn.textContent = room.flipId ? 'Flip requested' : 'Flip ⇄';
  ui.leaveBtn.textContent = sharer ? 'End screenpeek' : 'Leave';
  ui.sessionHint.textContent = sharer
    ? (room.partner === 'absent' ? 'Invite someone with the code or link above.' : 'Pause for privacy. Flip to give them the floor.')
    : 'You can stay in this room while you take turns sharing.';

  const flipping = online && Boolean(room.flipId);
  visible(ui.flipPrompt, flipping);
  visible(ui.acceptFlipBtn, !sharer);
  visible(ui.declineFlipBtn, !sharer);
  visible(ui.cancelFlipBtn, sharer);
  ui.acceptFlipBtn.disabled = Boolean(captureJob);
  ui.acceptFlipBtn.textContent = captureJob ? 'Choose your screen…' : 'Accept & share';
  ui.declineFlipBtn.disabled = Boolean(captureJob);
  ui.flipTitle.textContent = sharer ? 'Waiting for them to accept' : 'Your turn to share?';
  ui.flipDescription.textContent = sharer
    ? 'You keep the floor until they choose a screen. You can cancel any time.'
    : 'Choose what to share. Their screen stays live until you accept.';
}

function watchStream(value) {
  value.getVideoTracks()[0].addEventListener('ended', () => {
    if (stream === value && room?.role === 'sharer') {
      send('end');
      goHome('Screen sharing stopped. Your screenpeek has ended.');
    } else if (pendingStream === value) {
      send('decline-flip', { flipId: room?.flipId });
      cancelCapture();
      notice('Screen selection ended. The other person keeps the floor.');
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
      action = { ...action, hasStream: hasStream(), paused: Boolean(stream && !stream.getVideoTracks()[0].enabled) };
    }
    ws.send(JSON.stringify(action));
  });
  ws.addEventListener('message', (event) => {
    messages = messages.then(async () => {
      if (socket !== ws) return;
      await onMessage(JSON.parse(event.data));
    }).catch((error) => {
      console.error('Session message failed', error);
      if (socket === ws) connectionFailed();
    });
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    clearTimeout(handshakeTimer);
    online = false;
    closePeer();
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

function connectionFailed() {
  if (!room) return;
  peerStatus = 'failed';
  clearTimeout(peerTimer);
  render();
}

function makePeer(epoch) {
  closePeer();
  const pc = new RTCPeerConnection(rtcConfig);
  peer = pc;
  peerEpoch = epoch;
  peerStatus = 'connecting';
  peerTimer = setTimeout(() => { if (peer === pc) connectionFailed(); }, 15000);
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && peer === pc) send('signal', { epoch, data: { candidate } });
  };
  pc.ontrack = ({ streams }) => {
    if (peer !== pc || room?.role !== 'viewer') return;
    ui.remoteVideo.srcObject = streams[0];
    ui.remoteVideo.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (peer !== pc) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(peerTimer);
      clearTimeout(disconnectTimer);
      peerStatus = 'connected';
    } else if (pc.connectionState === 'failed') connectionFailed();
    else if (pc.connectionState === 'disconnected') {
      peerStatus = 'connecting';
      disconnectTimer = setTimeout(() => { if (peer === pc) connectionFailed(); }, 5000);
    }
    render();
  };
  return pc;
}

async function negotiate() {
  if (!room || !online || !room.ready || room.partner !== 'online') return;
  const epoch = room.epoch;
  const pc = makePeer(epoch);
  if (room.role === 'sharer' && hasStream()) {
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const offer = await pc.createOffer();
    if (peer !== pc) return;
    await pc.setLocalDescription(offer);
    if (peer === pc) send('signal', { epoch, data: { description: pc.localDescription } });
  }
  render();
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
    if (previous?.role && previous.role !== room.role) notice('Floor flipped. You’re now ' + (room.role === 'sharer' ? 'sharing.' : 'watching.'));
    if (!previous || previous.epoch !== room.epoch) {
      closePeer();
      await negotiate();
    }
    render();
    return;
  }
  if (msg.type === 'signal') {
    if (!room || msg.epoch !== room.epoch || msg.epoch !== peerEpoch || !peer) return;
    const pc = peer;
    const { description, candidate } = msg.data;
    if (description) {
      if ((room.role === 'viewer' && description.type !== 'offer') || (room.role === 'sharer' && description.type !== 'answer')) return;
      await pc.setRemoteDescription(description);
      if (pc !== peer) return;
      for (const queued of candidates) await pc.addIceCandidate(queued);
      candidates = [];
      if (description.type === 'offer') {
        const answer = await pc.createAnswer();
        if (pc !== peer) return;
        await pc.setLocalDescription(answer);
        if (pc === peer) send('signal', { epoch: room.epoch, data: { description: pc.localDescription } });
      }
    }
    if (candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else candidates.push(candidate);
    }
    return;
  }
  if (msg.type === 'ended' || (msg.type === 'error' && msg.fatal)) {
    goHome(msg.message, msg.type === 'error');
  } else if (msg.type === 'flip-rejected') {
    cancelCapture();
    notice(msg.message, true);
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
      ? (kind === 'flip' ? 'Screen selection cancelled. The other person keeps the floor.' : 'Screen selection cancelled. You can try again when you’re ready.')
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
ui.retryBtn.addEventListener('click', () => {
  notice();
  peerStatus = 'connecting';
  render();
  send('retry');
});
ui.leaveBtn.addEventListener('click', () => {
  const sharing = room?.role === 'sharer';
  send(sharing ? 'end' : 'leave');
  goHome(sharing ? 'Your screenpeek has ended.' : 'You left the screenpeek.');
});
ui.copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(ui.shareLink.value);
    ui.copyBtn.textContent = 'Copied!';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { ui.copyBtn.textContent = 'Copy link'; }, 1800);
  } catch {
    ui.shareLink.focus();
    ui.shareLink.select();
    notice('Copy the selected link to invite someone.');
  }
});
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

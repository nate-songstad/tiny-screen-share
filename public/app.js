const home = document.querySelector('#home');
const host = document.querySelector('#host');
const viewer = document.querySelector('#viewer');
const startBtn = document.querySelector('#startBtn');
const stopBtn = document.querySelector('#stopBtn');
const joinForm = document.querySelector('#joinForm');
const codeInput = document.querySelector('#codeInput');
const roomCode = document.querySelector('#roomCode');
const shareLink = document.querySelector('#shareLink');
const copyBtn = document.querySelector('#copyBtn');
const hostStatus = document.querySelector('#hostStatus');
const viewerStatus = document.querySelector('#viewerStatus');
const remoteVideo = document.querySelector('#remoteVideo');
const homeError = document.querySelector('#homeError');
const viewerError = document.querySelector('#viewerError');

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

let ws;
let pc;
let screenStream;
let currentRoom;
let role;

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function setError(el, message) {
  el.textContent = message;
  message ? show(el) : hide(el);
}

function websocketUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(websocketUrl());
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
    ws.addEventListener('message', onSocketMessage);
  });
}

async function ensureSocket() {
  if (ws?.readyState === WebSocket.OPEN) return;
  await connectSocket();
}

function send(type, data = {}) {
  ws.send(JSON.stringify({ type, ...data }));
}

function createPeer() {
  pc?.close();
  pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate) send('signal', { data: { candidate: event.candidate } });
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (role === 'host') {
      if (pc.connectionState === 'connected') hostStatus.textContent = 'Viewer connected';
      if (['failed', 'disconnected'].includes(pc.connectionState)) hostStatus.textContent = 'Waiting for viewer…';
    } else {
      if (pc.connectionState === 'connected') viewerStatus.textContent = 'Viewing shared screen';
      if (pc.connectionState === 'failed') failViewer('Could not connect to the shared screen.');
    }
  };

  if (role === 'viewer') {
    pc.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().catch(() => {});
    };
  }

  return pc;
}

async function startSharing() {
  setError(homeError, '');

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 20, max: 30 } },
      audio: false
    });

    role = 'host';
    await ensureSocket();
    send('create-room');

    screenStream.getVideoTracks()[0].addEventListener('ended', stopSharing);
  } catch (err) {
    if (err?.name === 'NotAllowedError') {
      setError(homeError, 'Screen sharing was cancelled.');
    } else {
      setError(homeError, 'Could not start screen sharing. Use HTTPS or localhost and try again.');
    }
  }
}

async function hostCreateOffer() {
  createPeer();
  for (const track of screenStream.getTracks()) {
    pc.addTrack(track, screenStream);
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send('signal', { data: { description: pc.localDescription } });
}

async function joinRoom(code) {
  code = String(code || '').replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) {
    setError(homeError, 'Enter a valid 6-digit code.');
    return;
  }

  setError(homeError, '');
  role = 'viewer';
  currentRoom = code;

  try {
    await ensureSocket();
    send('join-room', { code });
  } catch {
    setError(homeError, 'Could not connect to the sharing service.');
  }
}

async function handleSignal(data) {
  if (!pc) createPeer();

  if (data.description) {
    await pc.setRemoteDescription(data.description);

    if (data.description.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send('signal', { data: { description: pc.localDescription } });
    }
  }

  if (data.candidate) {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      console.error('ICE candidate error', err);
    }
  }
}

async function onSocketMessage(event) {
  const msg = JSON.parse(event.data);

  if (msg.type === 'room-created') {
    currentRoom = msg.code;
    roomCode.textContent = msg.code;
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('room', msg.code);
    shareLink.value = url.toString();
    hide(home);
    show(host);
    hostStatus.textContent = 'Waiting for viewer…';
    return;
  }

  if (msg.type === 'joined-room') {
    hide(home);
    show(viewer);
    viewerStatus.textContent = 'Connecting…';
    createPeer();
    return;
  }

  if (msg.type === 'viewer-ready') {
    await hostCreateOffer();
    return;
  }

  if (msg.type === 'signal') {
    await handleSignal(msg.data);
    return;
  }

  if (msg.type === 'viewer-left') {
    pc?.close();
    pc = null;
    hostStatus.textContent = 'Waiting for viewer…';
    return;
  }

  if (msg.type === 'share-ended') {
    pc?.close();
    pc = null;
    remoteVideo.srcObject = null;
    failViewer('The screen share has ended.');
    return;
  }

  if (msg.type === 'error') {
    if (role === 'viewer' && !viewer.classList.contains('hidden')) failViewer(msg.message);
    else setError(homeError, msg.message);
  }
}

function failViewer(message) {
  viewerStatus.textContent = 'Share unavailable';
  setError(viewerError, message);
}

function stopSharing() {
  if (role !== 'host') return;
  if (ws?.readyState === WebSocket.OPEN) send('stop-share');
  screenStream?.getTracks().forEach((track) => track.stop());
  pc?.close();
  location.href = location.origin + location.pathname;
}

startBtn.addEventListener('click', startSharing);
stopBtn.addEventListener('click', stopSharing);

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  joinRoom(codeInput.value);
});

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
});

copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(shareLink.value);
  copyBtn.textContent = 'Copied';
  setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
});

const incomingRoom = new URLSearchParams(location.search).get('room');
if (incomingRoom) joinRoom(incomingRoom);

const home = document.querySelector('#home');
const host = document.querySelector('#host');
const viewer = document.querySelector('#viewer');
const startBtn = document.querySelector('#startBtn');
const stopBtn = document.querySelector('#stopBtn');
const flipBtn = document.querySelector('#flipBtn');
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
const flipPrompt = document.querySelector('#flipPrompt');
const acceptFlipBtn = document.querySelector('#acceptFlipBtn');
const declineFlipBtn = document.querySelector('#declineFlipBtn');

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
let pendingCandidates = [];

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

function setShareDetails(code) {
  currentRoom = code;
  roomCode.textContent = code;
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', code);
  shareLink.value = url.toString();
}

function useScreenStream(stream) {
  screenStream = stream;
  screenStream.getVideoTracks()[0].addEventListener('ended', stopSharing, { once: true });
}

function resetFlipButton() {
  flipBtn.disabled = false;
  flipBtn.textContent = 'Flip';
}

function createPeer() {
  pc?.close();
  pc = new RTCPeerConnection(rtcConfig);
  const peer = pc;
  pendingCandidates = [];

  peer.onicecandidate = (event) => {
    if (event.candidate) send('signal', { data: { candidate: event.candidate } });
  };

  peer.onconnectionstatechange = () => {
    if (pc !== peer) return;
    if (role === 'host') {
      if (peer.connectionState === 'connected') {
        hostStatus.textContent = 'Viewer connected';
        resetFlipButton();
      }
      if (['failed', 'disconnected'].includes(peer.connectionState)) {
        hostStatus.textContent = 'Waiting for viewer…';
        flipBtn.disabled = true;
      }
    } else {
      if (peer.connectionState === 'connected') viewerStatus.textContent = 'Viewing shared screen';
      if (peer.connectionState === 'failed') failViewer('Could not connect to the shared screen.');
    }
  };

  if (role === 'viewer') {
    peer.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().catch(() => {});
    };
  }

  return pc;
}

async function startSharing() {
  setError(homeError, '');

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 20, max: 30 } },
      audio: false
    });

    useScreenStream(stream);
    role = 'host';
    await ensureSocket();
    send('create-room');
  } catch (err) {
    screenStream?.getTracks().forEach((track) => track.stop());
    screenStream = null;
    if (err?.name === 'NotAllowedError') {
      setError(homeError, 'Screen sharing was cancelled.');
    } else {
      setError(homeError, 'Could not start screen sharing. Use HTTPS or localhost and try again.');
    }
  }
}

async function hostCreateOffer() {
  if (!screenStream) return;
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

    for (const candidate of pendingCandidates) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.error('Queued ICE candidate error', err);
      }
    }
    pendingCandidates = [];

    if (data.description.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send('signal', { data: { description: pc.localDescription } });
    }
  }

  if (data.candidate) {
    if (!pc.remoteDescription) {
      pendingCandidates.push(data.candidate);
      return;
    }
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
    setShareDetails(msg.code);
    hide(home);
    show(host);
    hostStatus.textContent = 'Waiting for viewer…';
    flipBtn.disabled = true;
    return;
  }

  if (msg.type === 'joined-room') {
    setShareDetails(msg.code);
    hide(home);
    show(viewer);
    viewerStatus.textContent = 'Connecting…';
    createPeer();
    return;
  }

  if (msg.type === 'viewer-ready') {
    hostStatus.textContent = 'Connecting to viewer…';
    resetFlipButton();
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
    flipBtn.disabled = true;
    flipBtn.textContent = 'Flip';
    return;
  }

  if (msg.type === 'flip-requested') {
    setError(viewerError, '');
    show(flipPrompt);
    return;
  }

  if (msg.type === 'flip-pending') {
    hostStatus.textContent = 'Waiting for viewer to accept…';
    flipBtn.disabled = true;
    flipBtn.textContent = 'Flip requested';
    return;
  }

  if (msg.type === 'flip-declined') {
    hostStatus.textContent = 'Viewer connected';
    resetFlipButton();
    return;
  }

  if (msg.type === 'flip-failed') {
    if (role === 'viewer') {
      screenStream?.getTracks().forEach((track) => track.stop());
      screenStream = null;
      hide(flipPrompt);
      setError(viewerError, msg.message);
    }
    return;
  }

  if (msg.type === 'flip-accepted') {
    hide(flipPrompt);
    pc?.close();
    pc = null;
    remoteVideo.srcObject = null;

    if (msg.role === 'sharer') {
      role = 'host';
      hide(home);
      hide(viewer);
      show(host);
      setShareDetails(currentRoom);
      hostStatus.textContent = 'Connecting to viewer…';
      resetFlipButton();
      await hostCreateOffer();
    } else {
      role = 'viewer';
      const previousStream = screenStream;
      screenStream = null;
      hide(home);
      hide(host);
      show(viewer);
      viewerStatus.textContent = 'Connecting…';
      setError(viewerError, '');
      previousStream?.getTracks().forEach((track) => track.stop());
      createPeer();
    }
    return;
  }

  if (msg.type === 'share-ended') {
    pc?.close();
    pc = null;
    remoteVideo.srcObject = null;
    hide(flipPrompt);
    failViewer('The screen share has ended.');
    return;
  }

  if (msg.type === 'error') {
    if (role === 'viewer' && !viewer.classList.contains('hidden')) failViewer(msg.message);
    else if (role === 'host' && !host.classList.contains('hidden')) {
      hostStatus.textContent = msg.message;
      resetFlipButton();
    } else setError(homeError, msg.message);
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

async function acceptFlip() {
  acceptFlipBtn.disabled = true;
  declineFlipBtn.disabled = true;
  viewerStatus.textContent = 'Choose what to share…';
  setError(viewerError, '');

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 20, max: 30 } },
      audio: false
    });
    useScreenStream(stream);
    hide(flipPrompt);
    send('accept-flip');
  } catch (err) {
    send('decline-flip');
    hide(flipPrompt);
    viewerStatus.textContent = 'Viewing shared screen';
    if (err?.name === 'NotAllowedError') {
      setError(viewerError, 'Screen sharing was cancelled. The current sharer still has the floor.');
    } else {
      setError(viewerError, 'Could not start screen sharing.');
    }
  } finally {
    acceptFlipBtn.disabled = false;
    declineFlipBtn.disabled = false;
  }
}

startBtn.addEventListener('click', startSharing);
stopBtn.addEventListener('click', stopSharing);
flipBtn.addEventListener('click', () => send('request-flip'));
acceptFlipBtn.addEventListener('click', acceptFlip);
declineFlipBtn.addEventListener('click', () => {
  hide(flipPrompt);
  send('decline-flip');
});

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

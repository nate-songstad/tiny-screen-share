import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

async function client() {
  const socket = new WebSocket('ws://127.0.0.1:3217');
  const received = [];
  socket.on('message', (raw) => received.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return {
    socket, received,
    send(type, data = {}) { socket.send(JSON.stringify({ type, ...data })); },
    async next(type) {
      await expect.poll(() => received.some((msg) => msg.type === type)).toBe(true);
      return received.splice(received.findIndex((msg) => msg.type === type), 1)[0];
    }
  };
}

test('server rejects unsolicited handoffs and stale signals, validates messages, and restricts stop/pause to sharer', async () => {
  const host = await client();
  const viewer = await client();
  try {
    host.socket.send('null'); host.socket.send('{broken'); host.socket.send('[]');
    host.send('create');
    const session = await host.next('session');
    await host.next('state');
    viewer.send('join', { code: session.code });
    await viewer.next('session');
    const state = await viewer.next('state');
    await host.next('state');
    viewer.send('accept-flip', { flipId: 'not-a-request' });
    await viewer.next('flip-rejected');
    viewer.send('pause', { paused: true });
    viewer.send('end');
    viewer.send('signal', { epoch: state.epoch - 1, data: { probe: 'stale' } });
    viewer.send('signal', { epoch: state.epoch, data: { probe: 'current' } });
    expect((await host.next('signal')).data.probe).toBe('current');
    host.send('request-flip');
    const pending = await viewer.next('state');
    expect(pending.paused).toBe(false);
    expect(pending.role).toBe('viewer');
    expect(pending.flipId).toBeTruthy();
    host.send('end');
    await viewer.next('ended');
    viewer.send('accept-flip', { flipId: pending.flipId });
    viewer.send('join', { code: session.code });
    expect((await viewer.next('error')).fatal).toBe(true);
  } finally { host.socket.close(); viewer.socket.close(); }
});

test('resume requires private session token; old socket cannot overwrite a resumed session', async () => {
  const host = await client();
  const replacement = await client();
  const stranger = await client();
  try {
    host.send('create');
    const session = await host.next('session');
    await host.next('state');
    stranger.send('resume', { code: session.code, token: 'wrong' });
    expect((await stranger.next('error')).fatal).toBe(true);
    replacement.send('resume', { code: session.code, token: session.token, hasStream: false });
    await replacement.next('session');
    const state = await replacement.next('state');
    expect(state.role).toBe('sharer');
    expect(state.ready).toBe(false);
    await host.next('ended');
    replacement.send('ready');
    expect((await replacement.next('state')).ready).toBe(true);
    replacement.send('end');
    await replacement.next('ended');
  } finally { host.socket.close(); replacement.socket.close(); stranger.socket.close(); }
});

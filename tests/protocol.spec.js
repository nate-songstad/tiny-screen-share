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

test('only a ready sharer can allow the laser; every request is answered; flips and refreshes reset it', async () => {
  const host = await client();
  const viewer = await client();
  const fresh = await client();
  try {
    host.send('create');
    const session = await host.next('session');
    await host.next('state');
    viewer.send('join', { code: session.code });
    await viewer.next('session');
    expect((await viewer.next('state')).laser).toBe(false);
    await host.next('state');

    viewer.send('laser', { on: true, id: 5 });
    host.send('laser', { on: 'yes', id: 6 });
    host.send('laser', { on: true, id: 7 });
    const allowed = await host.next('state');
    expect(allowed.laser).toBe(true);
    expect(allowed.laserId).toBe(7);
    expect((await viewer.next('state')).laser).toBe(true);

    // Pausing keeps the permission; the clients suspend pointing themselves.
    host.send('pause', { paused: true });
    expect((await host.next('state')).laser).toBe(true);
    host.send('pause', { paused: false });
    await host.next('state');

    // A sharer without a screen is refused, and still gets an answer.
    host.send('not-ready');
    expect((await host.next('state')).laser).toBe(false);
    host.send('laser', { on: true, id: 8 });
    const refused = await host.next('state');
    expect(refused.laser).toBe(false);
    expect(refused.laserId).toBe(8);
    host.send('ready');
    await host.next('state');
    host.send('laser', { on: true, id: 9 });
    expect((await host.next('state')).laser).toBe(true);

    // Resume restores the laser only if the sharer says its window survived.
    fresh.send('resume', { code: session.code, token: session.token, hasStream: true, laser: true });
    await fresh.next('session');
    expect((await fresh.next('state')).laser).toBe(true);
    await host.next('ended');
    const again = await client();
    again.send('resume', { code: session.code, token: session.token, hasStream: true });
    await again.next('session');
    expect((await again.next('state')).laser).toBe(false);
    again.send('laser', { on: true, id: 10 });
    expect((await again.next('state')).laser).toBe(true);

    // Accepting a flip hands over the floor with the laser off.
    viewer.received.length = 0;
    again.send('request-flip');
    const request = await viewer.next('state');
    viewer.send('accept-flip', { flipId: request.flipId });
    await expect.poll(() => viewer.received.some((msg) => msg.type === 'state' && msg.role === 'sharer')).toBe(true);
    expect(viewer.received.filter((msg) => msg.type === 'state').at(-1).laser).toBe(false);
    again.send('laser', { on: true, id: 11 });
    viewer.send('end');
    await viewer.next('ended');
    again.socket.close();
  } finally { host.socket.close(); viewer.socket.close(); fresh.socket.close(); }
});

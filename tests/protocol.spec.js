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

// Joins `count` raw clients to a new room; the first one creates it.
async function group(count) {
  const people = [];
  for (let i = 0; i < count; i++) people.push(await client());
  people[0].send('create');
  const session = await people[0].next('session');
  for (const person of people.slice(1)) {
    person.send('join', { code: session.code });
    person.session = await person.next('session');
  }
  people[0].session = session;
  // Everyone's latest view of the room, once all have joined.
  await expect.poll(() => people.every((person) => person.received.some((msg) => msg.type === 'state' && msg.members.length === count))).toBe(true);
  return { people, code: session.code };
}
const latest = (person) => person.received.filter((msg) => msg.type === 'state').at(-1);
const close = (people) => people.forEach((person) => person.socket.close());

test('seven people fit; the eighth is turned away; a freed place and its colour can be reused', async () => {
  const { people, code } = await group(7);
  const extra = await client();
  try {
    const state = latest(people[0]);
    expect(state.members.map((person) => person.role)).toEqual(['sharer', ...Array(6).fill('viewer')]);
    // Every person gets a different solid colour automatically, never a fun one.
    expect(state.members.map((person) => person.style)).toEqual(['red', 'blue', 'amber', 'violet', 'teal', 'pink', 'lime']);
    expect(new Set(state.members.map((person) => person.id)).size).toBe(7);
    // Public ids are not the private resume tokens.
    for (const person of people) expect(state.members.some((item) => item.id === person.session.token)).toBe(false);
    extra.send('join', { code });
    const full = await extra.next('error');
    expect(full.fatal).toBe(true);
    expect(full.message).toContain('full');

    // Amber leaves; the next person gets amber, the first free colour.
    people[2].send('leave');
    await expect.poll(() => latest(people[0]).members.length).toBe(6);
    const again = await client();
    again.send('join', { code });
    await again.next('session');
    expect((await again.next('state')).members.at(-1).style).toBe('amber');
    again.socket.close();
  } finally { close(people); extra.socket.close(); }
});

test('lasers are never shared: fun styles are first come first served, solid ones too', async () => {
  const { people } = await group(3);
  const [host, a, b] = people;
  try {
    for (const junk of [undefined, null, 7, '', 'RED', 'plaid', { id: 'rainbow' }, '__proto__', 'constructor']) a.send('style', { style: junk });
    a.send('style', { style: 'rainbow' });
    await expect.poll(() => latest(host).members[1].style).toBe('rainbow');
    // Taken: refused with a notice, nothing changes.
    b.send('style', { style: 'rainbow' });
    expect((await b.next('notice')).message).toContain('already has that laser');
    b.send('style', { style: 'red' });
    expect((await b.next('notice')).message).toContain('already has that laser');
    expect(latest(host).members[2].style).toBe('amber');
    // a let blue go, so b can take it.
    b.send('style', { style: 'blue' });
    await expect.poll(() => latest(host).members[2].style).toBe('blue');
    b.send('style', { style: 'galaxy' });
    await expect.poll(() => latest(host).members[2].style).toBe('galaxy');
    // When someone lets a style go, another person can claim it.
    a.send('style', { style: 'fire' });
    await expect.poll(() => latest(host).members[1].style).toBe('fire');
    b.send('style', { style: 'rainbow' });
    await expect.poll(() => latest(host).members[2].style).toBe('rainbow');
    const styles = latest(host).members.map((person) => person.style);
    expect(new Set(styles).size).toBe(styles.length);
    // A person who drops out keeps their laser while their place is held.
    b.socket.close();
    await expect.poll(() => latest(host).members[2].online).toBe(false);
    host.send('style', { style: 'rainbow' });
    expect((await host.next('notice')).message).toContain('already has that laser');
  } finally { close(people); }
});

test('names are optional, cleaned, limited, and can be removed', async () => {
  const { people } = await group(2);
  const [host, viewer] = people;
  const named = (name) => expect.poll(() => latest(host).members[1].name).toBe(name);
  try {
    expect(latest(host).members.map((person) => person.name)).toEqual([null, null]);
    viewer.send('name', { name: '  Ada\n\t Lovelace  ' });
    await named('Ada Lovelace');
    // Direction overrides, zero-width and control characters are removed.
    viewer.send('name', { name: '‮evil​\u0000\u0007 ﻿name' });
    await named('evil name');
    viewer.send('name', { name: '<img src=x onerror=alert(1)>' });
    await named('<img src=x onerror=alert(1)>');
    // Emoji sequences survive intact; length is capped by characters.
    viewer.send('name', { name: '👩‍💻 dev' });
    await named('👩‍💻 dev');
    viewer.send('name', { name: 'x'.repeat(5000) });
    await named('x'.repeat(32));
    viewer.send('name', { name: 'é'.repeat(100) });
    await expect.poll(() => [...new Intl.Segmenter().segment(latest(host).members[1].name)].length).toBeLessThanOrEqual(32);
    expect(latest(host).members[1].name.length).toBeLessThanOrEqual(64);
    viewer.send('name', { name: 'à'.repeat(1) + '̀'.repeat(300) });
    await expect.poll(() => latest(host).members[1].name.length).toBeLessThanOrEqual(64);
    for (const junk of [42, { name: 'x' }, ['x'], true]) viewer.send('name', { name: junk });
    await named(null);
    viewer.send('name', { name: 'Grace' });
    await named('Grace');
    viewer.send('name', { name: '   ​  ' });
    await named(null);
    host.send('name', { name: 'Host' });
    await expect.poll(() => latest(viewer).members[0].name).toBe('Host');
  } finally { close(people); }
});

test('signals go only between the sharer and one viewer, per connection generation', async () => {
  const { people } = await group(3);
  const [host, a, b] = people;
  try {
    const state = latest(host);
    const [, idA, idB] = state.members.map((person) => person.id);
    const linkA = state.members[1].link, linkB = state.members[2].link;
    // Viewers can only reach the sharer, never another viewer.
    a.send('signal', { to: idB, epoch: latest(a).epoch, data: { probe: 'a' } });
    const fromA = await host.next('signal');
    expect(fromA.from).toBe(idA);
    expect(fromA.data.probe).toBe('a');
    // The sharer addresses one viewer; wrong ids, wrong generations and itself go nowhere.
    host.send('signal', { to: idB, epoch: linkB - 1, data: { probe: 'stale' } });
    host.send('signal', { to: 'nobody', epoch: linkB, data: { probe: 'nobody' } });
    host.send('signal', { to: state.members[0].id, epoch: state.members[0].link, data: { probe: 'self' } });
    host.send('signal', { to: idB, epoch: linkB, data: { probe: 'b' } });
    expect((await b.next('signal')).data.probe).toBe('b');
    host.send('signal', { to: idA, epoch: linkA, data: 'not an object' });
    host.send('signal', { to: idA, epoch: linkA, data: { probe: 'a2' } });
    expect((await a.next('signal')).data.probe).toBe('a2');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(a.received.some((msg) => msg.type === 'signal')).toBe(false);
    expect(b.received.some((msg) => msg.type === 'signal')).toBe(false);
    expect(host.received.some((msg) => msg.type === 'signal')).toBe(false);

    // b dropping out and returning starts a new connection for b only.
    b.socket.close();
    const back = await client();
    back.send('resume', { code: b.session.code, token: b.session.token });
    await back.next('session');
    await expect.poll(() => latest(host).members[2].online).toBe(true);
    const after = latest(host);
    expect(after.members[1].link).toBe(linkA);
    expect(after.members[2].link).toBeGreaterThan(linkB);
    // A viewer retrying only restarts its own connection.
    a.send('retry');
    await expect.poll(() => latest(host).members[1].link).toBeGreaterThan(linkA);
    expect(latest(host).members[2].link).toBe(after.members[2].link);
    back.socket.close();
  } finally { close(people); }
});

test('flips are offered to everyone: first to accept wins, passing is per person', async () => {
  const { people } = await group(4);
  const [host, a, b, c] = people;
  try {
    // Nobody can take the floor if nobody else is here.
    const alone = await client();
    alone.send('create');
    await alone.next('session');
    await alone.next('state');
    alone.send('request-flip');
    expect((await alone.next('state')).flipId).toBe(null);
    alone.socket.close();

    host.send('request-flip');
    await expect.poll(() => [a, b, c].every((person) => latest(person).flipId)).toBe(true);
    const { flipId } = latest(a);
    // Viewers cannot cancel; a pass only removes that person.
    a.send('cancel-flip', { flipId });
    a.send('decline-flip', { flipId });
    await expect.poll(() => latest(a).flipId).toBe(null);
    expect(latest(b).flipId).toBe(flipId);
    expect(latest(host).flipId).toBe(flipId);
    // Someone who passed can't take it after all.
    a.send('accept-flip', { flipId });
    await a.next('flip-rejected');
    // c drops out; b is still offered the floor.
    c.socket.close();
    await expect.poll(() => latest(host).members[3].online).toBe(false);
    expect(latest(b).flipId).toBe(flipId);
    // b accepts first; the old sharer becomes a viewer.
    b.send('accept-flip', { flipId });
    await expect.poll(() => latest(b).role).toBe('sharer');
    expect(latest(host).role).toBe('viewer');
    expect(latest(a).members.find((person) => person.role === 'sharer').id).toBe(latest(b).you);
    host.send('accept-flip', { flipId });
    await host.next('flip-rejected');

    // When everyone passes, the request ends for all, with a notice.
    host.received.length = 0;
    b.send('request-flip');
    await expect.poll(() => latest(host)?.flipId).toBeTruthy();
    const second = latest(host).flipId;
    host.send('decline-flip', { flipId: second });
    a.send('decline-flip', { flipId: second });
    expect((await b.next('notice')).message).toContain('Everyone passed');
    await expect.poll(() => latest(b).flipId).toBe(null);
  } finally { close(people); }
});

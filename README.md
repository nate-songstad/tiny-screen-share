# Tiny Screen Share

A deliberately tiny one-to-one screen sharing app.

- No accounts
- No meeting
- No camera
- No microphone
- Host clicks **Start Sharing** and gets a 6-digit code + link
- Viewer enters the code or opens the link
- The current sharer can request a flip; the viewer accepts and takes over without leaving the room
- Video is sent browser-to-browser with WebRTC
- The Node server only serves the page and relays WebRTC signaling messages

## Run locally

Requires Node 20+.

```bash
npm install
npm start
```

Open `http://localhost:3000`.

To test on one machine, start sharing in one browser window and open the generated link in another browser/profile.

## Deploy

This needs a host that supports a long-running Node process and WebSockets. Render, Railway, Fly.io, a small VPS, or your existing EC2 box are good fits.

It is **not a good fit for a normal Vercel serverless deployment** because the signaling server uses persistent WebSocket connections.

Set the start command to:

```bash
npm start
```

The host should provide `PORT`; the app reads it automatically.

## HTTPS

Browser screen capture (`getDisplayMedia`) requires a secure context. `localhost` works for local testing; a deployed copy should use HTTPS. Most modern hosting platforms provide HTTPS automatically.

## Reliability note

This first version uses public STUN servers and no TURN server. That keeps it simple and free. It should work on many normal home/office networks, but some restrictive corporate networks/firewalls may prevent a direct WebRTC connection. If that happens, add a TURN server (for example coturn) as a fallback.

## Privacy

The app never requests microphone or camera access. `getDisplayMedia()` requests only a video screen/window/tab stream with `audio: false`.

# Screenpeek

A deliberately tiny one-to-one screen sharing app.

- No accounts
- No meeting
- No camera
- No microphone
- Host clicks **Share my screen** and gets a 6-digit code + link
- Viewer enters the code or opens the link
- The viewer's screen fills the browser window by default, with only status and Leave controls; flipping automatically switches between viewing and sharing layouts
- The current sharer can request a flip; the viewer accepts and takes over without leaving the room
- Pause hides the screen from the viewer and disables outgoing video frames; resume continues in the same room
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

## Session behavior

- **Flip:** the current sharer keeps the floor until the viewer accepts and chooses a screen. Either decline or cancel the request without interrupting the current share. Requests expire after 60 seconds. Old captures are stopped after the handoff.
- **Refresh:** viewers reconnect automatically. Sharers return to the same room and choose **Resume sharing** to grant screen-capture permission again. Role identity is stored per tab in session storage; the invitation link contains only the room code.
- **Temporary disconnect:** the room reserves the participant's place for 30 seconds. The client attempts to reconnect for up to 20 seconds, then returns home with an explanation. A resumed live capture keeps its paused/unpaused state.
- **Leave / end:** viewers may leave and another viewer can join. Ending from the current sharer ends the room for both people and stops capture. Using the browser's Stop Sharing control also ends the room.
- **Connection failure:** there is a bounded connection wait and a Retry connection action, rather than a permanently blank player.

## Tests

```bash
npm ci
npx playwright install chromium
npm test
```

The suite starts an isolated server on port 3217. Tests use separate browser sessions and real WebRTC encoding/decoding. Most replace only the operating-system picker with a moving canvas stream, making cancelled and delayed selections reproducible. An additional test uses the browser's actual `getDisplayMedia` API with Chromium's synthetic display device.

Coverage includes repeated handoffs, pause (including black received frames), refresh in either role, refresh during a handoff, reconnects, stale requests, stopped tracks, room expiry, third-participant rejection, malformed signaling, permission errors, clipboard fallback, keyboard joining, and layouts from 320px to 1440px. Screenshots and failure traces are saved under `test-results/`.

The automation does not replace a real-device check of the macOS/Windows screen picker or a cross-network test. Before shipping, check desktop Chrome/Safari/Firefox on HTTPS with two devices, allow and deny OS recording permission, and verify tab/window/screen capture. Mobile viewing is supported; initiating screen capture depends on browser support.

## Deploy

This needs a host that supports a long-running Node process and WebSockets. Render, Railway, Fly.io, a small VPS, or your existing EC2 box are good fits.

It is **not a good fit for a normal Vercel serverless deployment** because the signaling server uses persistent WebSocket connections.

Set the start command to:

```bash
npm start
```

The host should provide `PORT`; the app reads it automatically.

Rooms live in one process's memory. Run a single instance (or implement a shared room store before horizontal scaling). A server restart ends existing rooms. Deploy the server and `public/` together: this version changes the signaling protocol. Clients should refresh after deployment. Static responses use `Cache-Control: no-store` so HTML, styles, and client code stay in sync.

## HTTPS

Browser screen capture (`getDisplayMedia`) requires a secure context. `localhost` works for local testing; a deployed copy should use HTTPS. Most modern hosting platforms provide HTTPS automatically.

## Reliability note

This app uses a public STUN server and no TURN server. Some restrictive networks/firewalls prevent a direct WebRTC connection; those require a TURN relay configured in the client's ICE server list. The local browser suite verifies application behavior and media flow, not connectivity across every network.

## Privacy

The app never requests microphone or camera access. `getDisplayMedia()` requests only a video screen/window/tab stream with `audio: false`.

# Screenpeek

A deliberately tiny screen sharing app for up to seven people.

- No accounts
- No meeting
- No camera
- No microphone
- Host clicks **Share my screen** and gets a 6-digit code + link
- Up to six viewers enter the code or open the link. Nobody needs a name to join; after joining, anyone can add one (or stay Anonymous) from the **People** panel
- The viewer uses the entire browser window, with floating status and Leave controls. Video is shown at the largest size that preserves its proportions without cropping. Different screen shapes may leave bars on two edges; flipping automatically switches between viewing and sharing layouts.
- The current sharer can offer the floor; whoever accepts first takes over without anyone leaving the room. It runs on the honor system: there's no queue or vote
- Pause hides the screen from the viewer and disables outgoing video frames; resume continues in the same room
- Laser pointer: the sharer allows it, then every viewer can point at the shared screen with their own laser (see below)
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

- **People:** up to seven per screenpeek (one sharer, six viewers); an eighth is told the room is full. A place is held for 30 seconds after a disconnect. Joining, leaving, refreshing or retrying only reconnects that one person; everyone else keeps watching uninterrupted. The **People** button shows who is here, their laser colour, and (for the sharer) each viewer's connection.
- **Names:** optional, added after joining from the People panel, up to 32 characters, and removable. People without one show as Anonymous, next to their laser colour. Names are cleaned on the server (control and text-direction characters removed) and always shown as plain text.
- **Flip:** the current sharer offers the floor to everyone. Whoever accepts and chooses a screen first takes over; anyone still choosing has their capture stopped. **Not now** only hides the offer for that person; when everyone has passed, the sharer keeps the floor. The sharer can cancel, and requests expire after 60 seconds. Old captures are stopped after the handoff.
- **Refresh:** viewers reconnect automatically. Sharers return to the same room and choose **Resume sharing** to grant screen-capture permission again. Role identity is stored per tab in session storage; the invitation link contains only the room code.
- **Temporary disconnect:** the room reserves the participant's place for 30 seconds. The client attempts to reconnect for up to 20 seconds, then returns home with an explanation. A resumed live capture keeps its paused/unpaused state.
- **Leave / end:** viewers may leave and someone else can take their place. Ending from the current sharer ends the room for everyone and stops capture. Using the browser's Stop Sharing control also ends the room.
- **Laser pointer:** off by default. The sharer clicks **Laser pointer**, which allows it and opens a floating window (Document Picture-in-Picture) showing their screen with the laser on top, so they can see it while working in other apps. Each viewer then chooses **Laser**: an orb in their laser colour follows their pointer, and click-and-drag leaves a trail that fades within about 0.75 seconds, with a pulse on press. Positions go browser to browser over WebRTC data channels; the sharer's browser ignores them unless the laser is allowed, labels each one by the connection it arrived on, and passes it on so every viewer sees everyone's pointer. Clicking the button again, choosing **Turn off**, or closing the floating window turns it off for everyone. Pausing suspends pointing; flipping or refreshing as the sharer turns it off. Browsers without Document Picture-in-Picture (Safari, Firefox) show the laser in the in-tab preview only. A web page cannot draw on top of other apps, so the floating window is the closest thing to an overlay without an installed app.
- **Laser colours:** no two people in a screenpeek share a laser. Everyone gets one of seven solid colours automatically (red, blue, amber, violet, teal, pink, lime). From the People panel anyone can switch to any free style, including the fun ones (Rainbow, Galaxy, Fire), which are never handed out automatically: first come, first served. A style is freed when its owner switches or leaves. In a room of three or more, each pointer carries a small tag with its owner's name.
- **Connection failure:** there is a bounded connection wait and a Retry connection action, rather than a permanently blank player.

## Tests

```bash
npm ci
npx playwright install chromium
npm test
```

The suite starts an isolated server on port 3217. Tests use separate browser sessions and real WebRTC encoding/decoding. Most replace only the operating-system picker with a moving canvas stream, making cancelled and delayed selections reproducible. An additional test uses the browser's actual `getDisplayMedia` API with Chromium's synthetic display device.

Coverage includes a full room of seven plus a rejected eighth, joins/leaves/refreshes that don't interrupt others, racing flip acceptances, per-person passes, names (including markup and invisible characters), unique and fun laser styles, several people pointing at once, repeated handoffs, pause (including black received frames), refresh in either role, refresh during a handoff, reconnects, stale requests, stopped tracks, room expiry, malformed signaling, permission errors, clipboard fallback, keyboard joining, and layouts from 320px to 1440px. Screenshots and failure traces are saved under `test-results/`.

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

## Capacity note

The sharer's browser sends a separate video stream to each viewer, so with six viewers it uploads six copies of the screen. That's fine on typical home or office connections for screen content, but a weak uplink or an old machine will show it first as lower frame rate or sharpness for viewers.

## Reliability note

This app uses a public STUN server and no TURN server. Some restrictive networks/firewalls prevent a direct WebRTC connection; those require a TURN relay configured in the client's ICE server list. The local browser suite verifies application behavior and media flow, not connectivity across every network.

## Privacy

The app never requests microphone or camera access. `getDisplayMedia()` requests only a video screen/window/tab stream with `audio: false`.

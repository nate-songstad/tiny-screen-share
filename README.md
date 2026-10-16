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
- **Temporary disconnect:** the room reserves the participant's place for 30 seconds, and the client keeps trying to reconnect for that long before returning home with an explanation. Video goes browser to browser, so it keeps playing while the connection to the server comes back; if the video connection survived, it carries on without restarting. A resumed live capture keeps its paused/unpaused state.
- **Starting or joining on a poor connection:** if the server can't be reached, the app keeps retrying quietly for about 20 seconds before saying so.
- **Unsteady video:** when the network path between two browsers drops, the sharer first tries to repair it in place (an ICE restart). If the video connection fails anyway, the viewer retries automatically three times with growing pauses, shown as "Reconnecting video…", and only then offers **Retry connection**.
- **Leave / end:** viewers may leave and someone else can take their place. Ending from the current sharer ends the room for everyone and stops capture. Using the browser's Stop Sharing control also ends the room.
- **Laser pointer:** off by default. The sharer clicks **Laser pointer**, which allows it and opens a floating window (Document Picture-in-Picture) showing their screen with the laser on top, so they can see it while working in other apps. Each viewer then chooses **Laser**: an orb in their laser colour follows their pointer, and click-and-drag leaves a trail that fades within about 0.75 seconds, with a pulse on press. Positions go browser to browser over WebRTC data channels; the sharer's browser ignores them unless the laser is allowed, labels each one by the connection it arrived on, and passes it on so every viewer sees everyone's pointer. Clicking the button again, choosing **Turn off**, or closing the floating window turns it off for everyone. Pausing suspends pointing; flipping or refreshing as the sharer turns it off. Browsers without Document Picture-in-Picture (Safari, Firefox) show the laser in the in-tab preview only. A web page cannot draw on top of other apps, so the floating window is the closest thing to an overlay without an installed app.
- **Laser colours:** no two people in a screenpeek share a laser. Everyone gets one of seven solid colours automatically (red, blue, amber, violet, teal, pink, lime). From the People panel anyone can switch to any free style, including the fun ones (Rainbow, Galaxy, Fire), which are never handed out automatically: first come, first served. A style is freed when its owner switches or leaves. In a room of three or more, each pointer carries a small tag with its owner's name.
- **Connection failure:** there is a bounded connection wait, automatic retries, and then a Retry connection action, rather than a permanently blank player.

## Tests

```bash
npm ci
npx playwright install chromium
npm test
```

The suite starts an isolated server on port 3217. Tests use separate browser sessions and real WebRTC encoding/decoding. Most replace only the operating-system picker with a moving canvas stream, making cancelled and delayed selections reproducible. An additional test uses the browser's actual `getDisplayMedia` API with Chromium's synthetic display device.

Coverage includes servers that can't be reached or drop mid-session (video keeps playing and isn't restarted), automatic video retries and the in-place repair, the sharer's capture cap, codec and per-viewer budget, viewers who look away, a full room of seven plus a rejected eighth, joins/leaves/refreshes that don't interrupt others, racing flip acceptances, per-person passes, names (including markup and invisible characters), unique and fun laser styles, several people pointing at once, repeated handoffs, pause (including black received frames), refresh in either role, refresh during a handoff, reconnects, stale requests, stopped tracks, room expiry, malformed signaling, permission errors, clipboard fallback, keyboard joining, and layouts from 320px to 1440px. Screenshots and failure traces are saved under `test-results/`.

The desktop app has its own suite in `desktop/` (see Screenpeek for Mac). The automation does not replace a real-device check of the macOS/Windows screen picker or a cross-network test. Before shipping, check desktop Chrome/Safari/Firefox on HTTPS with two devices, allow and deny OS recording permission, and verify tab/window/screen capture. Mobile viewing is supported; initiating screen capture depends on browser support.

## Screenpeek for Mac

`desktop/` is an Electron app that loads https://screenpeek.me and adds what a browser can't do: when you share an **entire screen**, everyone's lasers are drawn right on that screen, over every app, in a click-through window that is hidden from the capture itself (so viewers never see a second copy). Sharing a single window falls back to the in-app preview, because the overlay can't follow a window that moves. Everything else is the same site.

- **On by default, with a switch:** in the desktop app the laser shows on screen; **On my screen** in the toolbar turns that off (remembered). The site detects the app through a small, frozen `window.screenpeekDesktop` API and behaves exactly as before in browsers.
- **Its own screen picker:** so the app knows which display you chose. Without screen recording permission, the picker explains how to turn it on instead of failing.
- **First-launch setup:** welcome → move to Applications (if it's running from Downloads or the disk image) → screen recording permission, which it detects as you switch it on and then offers the relaunch macOS requires. Reopen it from **Screenpeek → Set Up Screen Sharing…**.
- **Locked down:** the window only ever shows screenpeek.me; other links open in your browser and popups are refused. The site gets four functions and nothing else; camera and microphone are refused before macOS is even asked; the app's own pages are served from an allow-list with strict content security policies; no third-party code ships in the app.
- **Offline:** a "Can't reach Screenpeek" page that retries every 10 seconds.

```bash
cd desktop
npm install
npm start            # runs against https://screenpeek.me
SCREENPEEK_URL=http://localhost:3000/ npm start   # against a local server
npm test             # drives the real app and browser viewers (windows open on screen)
REAL_CAPTURE=1 npx playwright test real-capture   # proves the overlay is invisible to real screen capture
npm run dist         # dist/Screenpeek.dmg: universal (Apple silicon + Intel), macOS 12+
PACKAGED=1 npx playwright test packaged           # runs the built app from its disk image
```

Run the desktop tests from a normal terminal. Electron windows can't open inside a sandboxed shell, and VS Code's integrated terminal sets `ELECTRON_RUN_AS_NODE`, which the test launcher removes for you.

**Releasing.** Deploy the site first (the app loads the live site), then attach `desktop/dist/Screenpeek.dmg` to a GitHub release, keeping that file name:

```bash
gh release create v1.0.0 desktop/dist/Screenpeek.dmg --title "Screenpeek for Mac 1.0.0"
```

The site's **Download Screenpeek Desktop** link (top left) goes to `/download`, which walks people through installing; its button goes to `/download/mac`, which redirects to the latest release's `Screenpeek.dmg`. Set `DESKTOP_DOWNLOAD_URL` on the server to send it elsewhere. Release files can only be downloaded publicly from a public repository.

**Signing.** The app is ad-hoc signed, not registered with Apple: the first time, macOS blocks it and people choose **System Settings → Privacy & Security → Open Anyway** (the download page and the disk image both say so). With an Apple Developer ID, set `mac.identity` to it, `hardenedRuntime` to `true` and `notarize` to `true` in `desktop/package.json`, and it will open with no warning.

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

The sharer's browser sends a separate video stream to each viewer, so with six viewers it uploads six copies of the screen. To keep that light:

- The capture is capped near 1080p (a Retina screen would otherwise be ~5K), and marked as detailed content so text stays sharp.
- H.264 is preferred when both browsers support it, which most computers encode in hardware; otherwise the browsers pick another codec.
- Each viewer's stream shares a budget: 20 fps and up to 2.5 Mbps for one viewer, down to 12 fps and 1.2 Mbps each for five or six.
- Nothing is sent to a viewer whose tab is in the background (unless they've popped the video out into picture-in-picture); it resumes the moment they look again.

A weak uplink or an old machine will still show it first as lower frame rate or sharpness for viewers.

## Reliability note

By default the app uses public STUN servers (Google and Cloudflare) and no TURN relay. Some networks (strict firewalls, some mobile hotspots and carrier-grade NAT) prevent a direct WebRTC connection; those need a TURN relay. Set one with the `ICE_SERVERS` environment variable, a JSON array of [RTCIceServer](https://developer.mozilla.org/en-US/docs/Web/API/RTCIceServer) objects, for example:

```bash
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"secret"}]' npm start
```

Hosted TURN is available from providers such as Cloudflare, Twilio or Metered. `LINK_TIMEOUT_MS` (default 15000) sets how long one video connection attempt may take. The local browser suite verifies application behavior and media flow, not connectivity across every network.

## Privacy

The app never requests microphone or camera access. `getDisplayMedia()` requests only a video screen/window/tab stream with `audio: false`.

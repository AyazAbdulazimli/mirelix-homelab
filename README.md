# Mirelix Homelab

Watch together, browse together, share screens, and talk — on your own server.

Mirelix is a self-hosted watch room with synchronized video playback, group voice/video calls, chat, and a collaborative whiteboard. Run it with Docker Compose. No Cloudflare account, database, or browser extension is required.

**Languages:** English · Azərbaycan dili · Türkçe
**Documentation:** English below · [Azərbaycanca](README.az.md)

## Features

- Shared website navigation, scrolling, and supported media controls.
- Synchronized YouTube, direct video/audio, and HLS playback, including late joins.
- Automatic media detection for extensionless video and HLS URLs.
- Group voice/video calls with a separate camera tile for each participant.
- Multiple simultaneous screen shares; each viewer chooses which screen to watch.
- Camera and microphone stay available while sharing a screen, with separate screen audio.
- Live chat, typing indicators, and a shared drawing board.
- Language switching without leaving the room; preference stays in your browser.
- Separate application and external-content proxy origins.
- Optional Caddy HTTPS configuration and a Tailscale HTTPS helper.

## Quick start

Install Docker Engine and Docker Compose, then download or clone this repository and open its directory:

```sh
cp .env.example .env
docker compose up -d --build
```

Open **http://localhost:3030** on the server, or **http://YOUR_SERVER_IP:3030** from another device. Create a room and share its invite link. An invite containing `localhost` only works on the device that opened it.

| Port | Purpose |
| --- | --- |
| `3030/tcp` | Application, rooms, chat, and WebRTC signaling |
| `3031/tcp` | Isolated website and media proxy |

Both ports must be reachable by participants. HTTP on a remote IP supports chat and some browsing, but cameras, microphones, screen capture, and some encrypted player handshakes require **HTTPS**. `localhost` is the development exception.

The image is built locally from source. No prebuilt image registry is required. A server restart clears active room state; there is no chat archive or database.

## HTTPS

Both the application and proxy must use HTTPS when the application is accessed over HTTPS. They must have **different origins**: a separate hostname or port. Putting both behind the same hostname and port with different URL paths does not provide the required isolation.

### Tailscale

For a private tailnet, with Tailscale running on the Docker host and the default application ports, use:

```sh
./scripts/enable-tailscale-https.sh --check
./scripts/enable-tailscale-https.sh
```

The helper requires Python 3, `ss`, Docker Compose, Tailscale, and `sudo`. It uses your own Tailscale DNS name and configures:

- Application: `https://YOUR_DEVICE.YOUR_TAILNET.ts.net:13030`
- Proxy: `https://YOUR_DEVICE.YOUR_TAILNET.ts.net:13031`

It checks Docker port publications and TCP listeners, preserves existing `.env` settings, updates `PUBLIC_ORIGIN` and `PROXY_ORIGIN`, and rebuilds the application. Administrator access may be requested by Tailscale. Participants need tailnet access to both ports. Existing services on port 443 are preserved.

Choose alternative HTTPS ports if needed:

```sh
MIRELIX_HTTPS_PORT=14030 MIRELIX_PROXY_HTTPS_PORT=14031 ./scripts/enable-tailscale-https.sh
```

### Caddy with your domains

Point two DNS names at your server. Set these values in `.env`:

```dotenv
APP_DOMAIN=mirelix.example.com
PROXY_DOMAIN=mirelix-proxy.example.net
PUBLIC_ORIGIN=https://mirelix.example.com
PROXY_ORIGIN=https://mirelix-proxy.example.net
BIND_ADDRESS=127.0.0.1
```

```sh
docker compose --profile https up -d --build
```

Caddy needs ports 80/TCP and 443/TCP and working certificate validation. Port 443/UDP is optional for HTTP/3. Private DNS deployments need a certificate trusted by participant devices. Keep the external-content proxy separate from applications storing private accounts or session cookies; a dedicated domain is preferable.

### Existing reverse proxy

With Nginx Proxy Manager, Traefik, or another proxy, forward the application hostname to port 3030 and the external-content hostname to port 3031. Enable WebSocket forwarding for the application. Preserve Host and send the correct `X-Forwarded-Proto`. Set `PROXY_ORIGIN` to the public HTTPS proxy origin and optionally `PUBLIC_ORIGIN` to redirect remote HTTP room visits to HTTPS.

If the reverse proxy is on another machine, bind the application ports to an interface it can reach rather than `127.0.0.1`.

## Configuration

Copy `.env.example` to `.env`. Docker Compose reads it automatically; `npm start` does not.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_PORT` | `3030` | Published application port |
| `PROXY_PORT` | `3031` | Published proxy port |
| `BIND_ADDRESS` | `0.0.0.0` | Interface for published ports |
| `PUBLIC_ORIGIN` | empty | Canonical HTTPS application origin and remote HTTP redirect target |
| `PROXY_ORIGIN` | automatic HTTP host/port | Browser-accessible proxy origin; set explicitly for HTTPS |
| `ICE_SERVERS` | Google STUN | Browser-visible JSON array of STUN/TURN servers |
| `TZ` | `Asia/Baku` | Server timezone |
| `APP_DOMAIN` / `PROXY_DOMAIN` | example domains | Hostnames used by the optional Caddy service |

For custom ports:

```dotenv
APP_PORT=8080
PROXY_PORT=8081
```

Then run `docker compose up -d`. Port settings and origins must match the addresses participants can actually reach.

### Calls and network connectivity

The default configuration uses STUN. `ICE_SERVERS=[]` permits host-candidate-only operation for suitable local networks. Tailscale handles private access to the application; media still uses browser WebRTC connectivity.

If participants cannot establish media connections, use your own TURN service:

```dotenv
ICE_SERVERS='[{"urls":"stun:turn.example.net:3478"},{"urls":["turn:turn.example.net:3478?transport=udp","turn:turn.example.net:3478?transport=tcp"],"username":"mirelix","credential":"REPLACE_ME"}]'
```

TURN is optional and is not bundled. Its credentials are delivered to browsers, so use credentials intended for these participants.

## Limits and intended use

Mirelix is intended for private homelabs and small groups. It has no account system, room passwords, or persistent message storage. Anyone with network access and a room link can join. Use your VPN or reverse proxy if access restrictions are needed.

Each participant sends media separately to every other participant. Group size is constrained by device performance and upload bandwidth. Four browser contexts, including mixed Chromium/Firefox calls, have been tested; this is not an unlimited conference service.

Website compatibility varies. DRM, CAPTCHA, account sessions, and some custom players may not work through the proxy. It is not a full remote browser. The proxy blocks private/local IP destinations and is not intended for browsing homelab administration panels. Do not expose it as an unrestricted public proxy.

On Android, the browser may not offer screen capture. Watching another participant's screen still works. Screen audio availability depends on the browser and the selected capture source. If incoming audio is blocked by autoplay rules, use **Enable call audio**.

Google Fonts, YouTube, external websites, and the default STUN service require their own network access. Application containers run as a non-root user with a read-only filesystem. Rooms and chat are ephemeral; optional Caddy certificate volumes are persistent.

## Maintenance

```sh
docker compose logs -f --tail=100 mirelix
docker compose restart mirelix
docker compose down
```

To update a Git checkout:

```sh
git pull --ff-only
docker compose up -d --build
```

For Caddy deployments include `--profile https` when managing the stack. Keep your `.env` file outside version control.

Health checks are available at `/healthz` on both ports. Runtime proxy settings are at `/api/runtime`; ICE settings are at `/api/ice`.

## Development and tests

Node.js **22.12+** is required; Docker uses Node.js 24.

```sh
npm ci
npm run build:vendor
npm test
PROXY_PORT=3031 npm start
```

With the server running:

```sh
npm run test:homelab -- http://localhost:3030
npx playwright install chromium firefox
npm run test:multiparty -- http://localhost:3030 mixed
npm run test:languages -- http://localhost:3030
npm run test:room-layout -- http://localhost:3030
npm run test:room-fullscreen -- http://localhost:3030 chromium
```

The multiparty check uses real browser peer connections with fake camera/microphone devices and canvas-generated screen tracks. It tests group calls, concurrent shares, delayed permission, ICE restart, reconnect, and departure. It does not test the operating system's capture picker. By default it isolates local ICE behavior; set `MIRELIX_TEST_STUN=1` to test the configured ICE servers.

Additional checks:

```sh
# Requires ffmpeg; includes extensionless video and HLS fixtures.
npm run test:native-media -- http://localhost:3030 chromium
npm run test:native-media -- http://localhost:3030 firefox

# Requires the live external provider to be available.
npm run test:provider -- http://localhost:3030 chromium
npm run test:provider -- http://localhost:3030 firefox
```

CI runs the unit/integration suite and builds and smoke-tests the Docker stack. Live external-provider tests are not CI requirements.

## AI-Assisted Development

Mirelix Homelab is an AI-assisted, vibe-coded open-source project.

AI coding tools have played a significant role in its development, from implementation to debugging and iteration. The project is guided by a human vision, with a focus on practical functionality, self-hosting, and continuous improvement.

AI-assisted development is embraced openly and transparently. Contributions, bug reports, and code reviews are welcome.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled dependencies.

Mirelix application code is available under the [MIT License](LICENSE). Third-party packages and external content retain their own licenses.

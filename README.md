# Chiply

A PWA chip tracker for Texas Hold'em home games. Cards stay physical on the table — every player uses their phone to bet, track their stack, see the pot, and know who's dealer / small blind / big blind.

## Features

- **Private rooms** — 4-letter codes, up to 10 players, shareable invite link.
- **Full betting flow** — blinds, check/call/bet/raise/fold, min-raise enforcement, all-ins, side pots, split pots.
- **Physical cards** — the app never deals cards; at showdown players compare hands at the table and the host taps the winner(s). Uncalled bets and single-eligible side pots return automatically.
- **Resilient chips** — player identity lives in `localStorage`, rooms persist to disk. Close the tab, lose Wi-Fi, or restart the server: rejoin and your seat and stack are exactly where you left them. Rooms expire after 24h idle.
- **Host tools** — change blinds between hands, rebuys, force-fold an away player, auto host transfer if the host disconnects.
- **Installable PWA** — add to home screen, works great on phones around a table.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end smoke test against a throwaway server
```

Configured by env vars: `PORT` (default 3000), `HOST` (default: every interface), `DATA_DIR` (default `./data`).

For a game night, run it on one machine and have everyone on the same Wi-Fi open `http://<your-lan-ip>:3000`. (Note: PWA installation and clipboard sharing require HTTPS or localhost; the game itself works fine over plain LAN HTTP.)

## How a hand works

1. Host taps **Start hand** — blinds post automatically and the button rotates.
2. Deal physical cards as usual. The app shows whose turn it is to act.
3. Players bet from their phones; the pot and current bet update live for everyone.
4. The app announces when to deal the flop/turn/river.
5. At showdown, players reveal physical cards; the host taps the winner(s) per pot (side pots handled separately). Chips move instantly.

## Project layout

- [server/index.js](server/index.js) — Express static server + WebSocket protocol.
- [server/game.js](server/game.js) — pure betting engine (streets, raises, side pots).
- [server/rooms.js](server/rooms.js) — room store with debounced JSON persistence (`$DATA_DIR/rooms.json`).
- [public/](public/) — vanilla JS PWA (no build step).

Regenerate icons with `npm run icons`.

## Deployment

Live at **[chiply.offhourslab.com](https://chiply.offhourslab.com)** on the shared OffHoursLab VPS, following the multi-app rules in [deploy/provision-server.sh](deploy/provision-server.sh): nginx terminates TLS and proxies (WebSockets included) to loopback-only port 3005, with dedicated `chiply` service and `deploy-chiply` users, `MemoryMax=192M`, and a sudoers grant that can restart only this unit.

- **Setup** (idempotent): [deploy/setup-chiply.sh](deploy/setup-chiply.sh) creates the users, `/opt/chiply`, the data dir, the systemd unit, the nginx vhost and the certificate.
- **CI**: push to `main` → `npm test` → SSH deploy as `deploy-chiply` ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)): `git reset --hard origin/main`, `npm install --omit=dev`, restart. The server checkout is disposable — never edit files there. Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`.
- **State**: `/var/lib/chiply/rooms.json`, the only path the service can write. Deliberately not backed up: rooms expire after 24h idle, so the file only has to survive restarts and deploys.

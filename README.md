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
```

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
- [server/rooms.js](server/rooms.js) — room store with debounced JSON persistence (`data/rooms.json`).
- [public/](public/) — vanilla JS PWA (no build step).

Regenerate icons with `npm run icons`.

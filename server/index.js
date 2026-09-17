import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rooms, createRoom, getRoom, addPlayer, sanitizeName, save, load, sweepExpired, touch,
  DENOMS, CHIP_STYLES,
} from './rooms.js';
import {
  startHand, applyAction, awardPot, forceFold, canStartHand,
  potTotal, callAmount, canRaise, minRaiseTo, log,
} from './game.js';

const PORT = process.env.PORT || 3000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

load();
setInterval(sweepExpired, 60 * 60 * 1000);

const app = express();
app.use(express.static(join(ROOT, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// code -> Map<playerId, ws>
const sockets = new Map();

function socketsFor(code) {
  if (!sockets.has(code)) sockets.set(code, new Map());
  return sockets.get(code);
}

function send(ws, type, data = {}) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data }));
}

function viewFor(room, playerId) {
  const h = room.hand;
  const me = room.players.find((p) => p.id === playerId);
  let actions = null;
  if (h && h.street !== 'showdown' && h.toActId === playerId && me) {
    const toCall = h.currentBet - h.committed[playerId];
    actions = {
      canCheck: toCall <= 0,
      callAmount: toCall > 0 ? callAmount(room, playerId) : 0,
      callIsAllIn: toCall > 0 && callAmount(room, playerId) >= me.stack,
      canRaise: canRaise(room, playerId) && me.stack + h.committed[playerId] > h.currentBet,
      minRaiseTo: minRaiseTo(room),
      maxRaiseTo: me.stack + h.committed[playerId],
      committed: h.committed[playerId],
    };
  }
  return {
    code: room.code,
    hostId: room.hostId,
    settings: room.settings,
    dealerId: room.dealerId,
    lastHand: room.lastHand,
    log: room.log.slice(-25),
    canStart: canStartHand(room),
    you: playerId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      stack: p.stack,
      connected: p.connected,
      sittingOut: p.sittingOut,
      committed: h ? h.committed[p.id] ?? 0 : 0,
      totalCommitted: h ? h.totalCommitted[p.id] ?? 0 : 0,
      folded: h ? h.folded.includes(p.id) : false,
      allIn: h ? h.allIn.includes(p.id) : false,
      inHand: h ? h.order.includes(p.id) : false,
    })),
    hand: h && {
      number: h.number,
      street: h.street,
      dealerId: h.dealerId,
      sbId: h.sbId,
      bbId: h.bbId,
      currentBet: h.currentBet,
      toActId: h.toActId,
      pot: potTotal(room),
      pots: h.pots,
      ranOut: h.ranOut ?? false,
    },
    actions,
  };
}

function broadcast(room) {
  touch(room);
  save();
  const conns = socketsFor(room.code);
  for (const [pid, ws] of conns) send(ws, 'state', { state: viewFor(room, pid) });
}

const hostTimers = new Map(); // code -> timeout

function scheduleHostTransfer(room) {
  clearTimeout(hostTimers.get(room.code));
  hostTimers.set(room.code, setTimeout(() => {
    const current = room.players.find((p) => p.id === room.hostId);
    if (current?.connected) return;
    const next = room.players.find((p) => p.connected);
    if (next && next.id !== room.hostId) {
      room.hostId = next.id;
      log(room, `${next.name} is now the host`);
      broadcast(room);
    }
  }, 20_000));
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, 'error', { message: 'Bad message' });
    }
    try {
      handle(ws, msg);
    } catch (err) {
      send(ws, 'error', { message: err.message });
    }
  });

  ws.on('close', () => {
    const room = ws.roomCode && rooms.get(ws.roomCode);
    if (!room || !ws.playerId) return;
    const conns = socketsFor(ws.roomCode);
    if (conns.get(ws.playerId) === ws) conns.delete(ws.playerId);
    const p = room.players.find((x) => x.id === ws.playerId);
    // Only mark disconnected if no other socket for this player (e.g., second tab).
    if (p && !conns.has(ws.playerId)) {
      p.connected = false;
      if (room.hostId === p.id) scheduleHostTransfer(room);
      broadcast(room);
    }
  });
});

function requireJoined(ws) {
  const room = ws.roomCode && rooms.get(ws.roomCode);
  if (!room) throw new Error('Not in a room');
  const p = room.players.find((x) => x.id === ws.playerId);
  if (!p) throw new Error('Not seated in this room');
  return { room, p };
}

function requireHost(ws) {
  const ctx = requireJoined(ws);
  if (ctx.room.hostId !== ws.playerId) throw new Error('Only the host can do that');
  return ctx;
}

function attach(ws, room, playerId) {
  // Replace any previous socket for this player.
  const conns = socketsFor(room.code);
  const old = conns.get(playerId);
  if (old && old !== ws) { old.playerId = null; old.close(4000, 'replaced'); }
  conns.set(playerId, ws);
  ws.roomCode = room.code;
  ws.playerId = playerId;
}

function handle(ws, msg) {
  const { type } = msg;

  if (type === 'create') {
    const playerId = String(msg.playerId || '').slice(0, 64);
    const name = sanitizeName(msg.name);
    if (!playerId || !name) throw new Error('Name required');
    const room = createRoom(name, playerId, msg.settings || {});
    attach(ws, room, playerId);
    log(room, `${name} created the room`);
    send(ws, 'joined', { code: room.code });
    return broadcast(room);
  }

  if (type === 'join') {
    const playerId = String(msg.playerId || '').slice(0, 64);
    const name = sanitizeName(msg.name);
    if (!playerId || !name) throw new Error('Name required');
    const room = getRoom(msg.code);
    if (!room) throw new Error('Room not found — check the code');
    const existing = room.players.find((p) => p.id === playerId);
    const p = addPlayer(room, playerId, name);
    attach(ws, room, playerId);
    clearTimeout(hostTimers.get(room.code));
    log(room, existing ? `${p.name} reconnected` : `${p.name} joined with ${p.stack} chips`);
    send(ws, 'joined', { code: room.code });
    return broadcast(room);
  }

  if (type === 'rejoin') {
    const playerId = String(msg.playerId || '').slice(0, 64);
    const room = getRoom(msg.code);
    const p = room?.players.find((x) => x.id === playerId);
    if (!room || !p) return send(ws, 'rejoinFailed');
    p.connected = true;
    attach(ws, room, playerId);
    clearTimeout(hostTimers.get(room.code));
    send(ws, 'joined', { code: room.code });
    return broadcast(room);
  }

  // Everything below requires being seated.
  if (type === 'leave') {
    const { room, p } = requireJoined(ws);
    if (room.hand?.order.includes(p.id) && !room.hand.folded.includes(p.id) && room.hand.street !== 'showdown') {
      throw new Error('Finish or fold the current hand first');
    }
    room.players = room.players.filter((x) => x.id !== p.id);
    socketsFor(room.code).delete(p.id);
    ws.roomCode = null;
    ws.playerId = null;
    log(room, `${p.name} left the table`);
    if (room.hostId === p.id && room.players.length) {
      room.hostId = (room.players.find((x) => x.connected) || room.players[0]).id;
      log(room, `${room.players.find((x) => x.id === room.hostId).name} is now the host`);
    }
    if (room.players.length === 0) rooms.delete(room.code);
    send(ws, 'left');
    save();
    return room.players.length && broadcast(room);
  }

  if (type === 'startHand') {
    const { room } = requireHost(ws);
    startHand(room);
    return broadcast(room);
  }

  if (type === 'action') {
    const { room } = requireJoined(ws);
    applyAction(room, ws.playerId, msg.action, msg.amount);
    return broadcast(room);
  }

  if (type === 'awardPot') {
    const { room } = requireHost(ws);
    awardPot(room, Number(msg.potIndex), Array.isArray(msg.winners) ? msg.winners : []);
    return broadcast(room);
  }

  if (type === 'forceFold') {
    const { room } = requireHost(ws);
    forceFold(room, String(msg.targetId));
    log(room, '(folded by host — player away)');
    return broadcast(room);
  }

  if (type === 'sitOut') {
    const { room, p } = requireJoined(ws);
    if (room.hand?.order.includes(p.id) && room.hand.street !== 'showdown' && !room.hand.folded.includes(p.id)) {
      throw new Error('Fold first, then sit out');
    }
    p.sittingOut = !!msg.value;
    log(room, `${p.name} ${p.sittingOut ? 'sits out' : 'is back in'}`);
    return broadcast(room);
  }

  if (type === 'addChips') {
    const { room } = requireHost(ws);
    const target = room.players.find((x) => x.id === msg.targetId);
    if (!target) throw new Error('Player not found');
    if (room.hand?.order.includes(target.id)) throw new Error('Wait until the hand ends');
    const amount = Math.floor(Number(msg.amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Error('Invalid amount');
    target.stack += amount;
    log(room, `Host added ${amount} chips to ${target.name} (rebuy)`);
    return broadcast(room);
  }

  if (type === 'setDisplay') {
    const { room } = requireHost(ws);
    if (DENOMS.includes(msg.denom)) room.settings.denom = msg.denom;
    if (CHIP_STYLES.includes(msg.chipStyle)) room.settings.chipStyle = msg.chipStyle;
    const labels = { none: 'plain chips', cents: 'pennies (1 chip = 1¢)', dollars: 'dollars (1 chip = $1)' };
    log(room, `Chip display: ${labels[room.settings.denom]}, ${room.settings.chipStyle === 'visual' ? 'chip graphics' : 'numbers'}`);
    return broadcast(room);
  }

  if (type === 'setBlinds') {
    const { room } = requireHost(ws);
    if (room.hand) throw new Error('Wait until the hand ends');
    const sb = Math.floor(Number(msg.smallBlind));
    const bb = Math.floor(Number(msg.bigBlind));
    if (!Number.isFinite(sb) || !Number.isFinite(bb) || sb < 1 || bb < sb) throw new Error('Invalid blinds');
    room.settings.smallBlind = Math.min(sb, 100_000);
    room.settings.bigBlind = Math.min(bb, 200_000);
    log(room, `Blinds are now ${room.settings.smallBlind}/${room.settings.bigBlind}`);
    return broadcast(room);
  }

  if (type === 'ping') return send(ws, 'pong');

  throw new Error(`Unknown message type: ${type}`);
}

// Heartbeat to reap dead sockets so "connected" dots stay accurate.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`Chiply running at http://localhost:${PORT}`);
});

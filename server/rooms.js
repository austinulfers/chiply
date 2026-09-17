// Room store with JSON-file persistence so chips survive server restarts and rejoins.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DATA_FILE = join(DATA_DIR, 'rooms.json');
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

export const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export const DENOMS = ['none', 'cents', 'dollars'];
export const CHIP_STYLES = ['numeric', 'visual'];

export function newRoomCode() {
  for (let tries = 0; tries < 50; tries++) {
    const bytes = randomBytes(4);
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate room code');
}

export function createRoom(hostName, hostId, settings = {}) {
  const code = newRoomCode();
  const room = {
    code,
    createdAt: Date.now(),
    lastActive: Date.now(),
    hostId,
    settings: {
      startingStack: clampInt(settings.startingStack, 100, 1_000_000, 1000),
      smallBlind: clampInt(settings.smallBlind, 1, 100_000, 5),
      bigBlind: clampInt(settings.bigBlind, 2, 200_000, 10),
      denom: DENOMS.includes(settings.denom) ? settings.denom : 'none',
      chipStyle: CHIP_STYLES.includes(settings.chipStyle) ? settings.chipStyle : 'numeric',
    },
    players: [],
    dealerId: null,
    hand: null,
    handCounter: 0,
    lastHand: null,
    log: [],
  };
  if (room.settings.bigBlind < room.settings.smallBlind) {
    room.settings.bigBlind = room.settings.smallBlind * 2;
  }
  addPlayer(room, hostId, hostName);
  rooms.set(code, room);
  save();
  return room;
}

export function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase().trim());
}

export function addPlayer(room, id, name) {
  const existing = room.players.find((p) => p.id === id);
  if (existing) {
    existing.connected = true;
    existing.name = sanitizeName(name) || existing.name;
    return existing;
  }
  if (room.players.length >= 10) throw new Error('Room is full (10 players max)');
  const p = {
    id,
    name: uniqueName(room, sanitizeName(name) || 'Player'),
    stack: room.settings.startingStack,
    connected: true,
    sittingOut: false,
    joinedAt: Date.now(),
  };
  room.players.push(p);
  return p;
}

function uniqueName(room, name) {
  let candidate = name;
  let i = 2;
  while (room.players.some((p) => p.name === candidate)) candidate = `${name} ${i++}`;
  return candidate;
}

export function sanitizeName(name) {
  return String(name || '').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 20);
}

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

export function touch(room) {
  room.lastActive = Date.now();
}

// ---------- persistence ----------
let saveTimer = null;

export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify([...rooms.values()]));
      renameSync(tmp, DATA_FILE);
    } catch (err) {
      console.error('Failed to persist rooms:', err.message);
    }
  }, 250);
}

export function load() {
  if (!existsSync(DATA_FILE)) return;
  try {
    const list = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    const now = Date.now();
    for (const room of list) {
      if (now - room.lastActive > ROOM_TTL_MS) continue;
      for (const p of room.players) p.connected = false;
      room.settings.denom ??= 'none';
      room.settings.chipStyle ??= 'numeric';
      rooms.set(room.code, room);
    }
    console.log(`Restored ${rooms.size} room(s) from disk`);
  } catch (err) {
    console.error('Failed to load rooms:', err.message);
  }
}

export function sweepExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [code, room] of rooms) {
    if (now - room.lastActive > ROOM_TTL_MS) {
      rooms.delete(code);
      removed++;
    }
  }
  if (removed) save();
}

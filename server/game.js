// Pure Texas Hold'em betting engine. Cards are physical — this tracks chips only.

const STREETS = ['preflop', 'flop', 'turn', 'river'];

export function log(room, msg) {
  room.log.push({ t: Date.now(), msg });
  if (room.log.length > 60) room.log.splice(0, room.log.length - 60);
}

function player(room, id) {
  return room.players.find((p) => p.id === id);
}

function eligiblePlayers(room) {
  return room.players.filter((p) => p.stack > 0 && !p.sittingOut);
}

export function canStartHand(room) {
  return !room.hand && eligiblePlayers(room).length >= 2;
}

function nextEligibleAfter(room, playerId) {
  const n = room.players.length;
  const start = Math.max(0, room.players.findIndex((p) => p.id === playerId));
  for (let i = 1; i <= n; i++) {
    const p = room.players[(start + i) % n];
    if (p.stack > 0 && !p.sittingOut) return p.id;
  }
  return null;
}

export function startHand(room) {
  if (!canStartHand(room)) throw new Error('Need at least 2 players with chips');
  const elig = eligiblePlayers(room);
  // Rotate dealer button to next eligible player.
  room.dealerId = room.dealerId && player(room, room.dealerId)
    ? nextEligibleAfter(room, room.dealerId)
    : elig[0].id;
  if (!elig.some((p) => p.id === room.dealerId)) room.dealerId = elig[0].id;

  const order = elig.map((p) => p.id);
  const dPos = order.indexOf(room.dealerId);
  const n = order.length;
  const headsUp = n === 2;
  const sbId = headsUp ? order[dPos] : order[(dPos + 1) % n];
  const bbId = headsUp ? order[(dPos + 1) % n] : order[(dPos + 2) % n];

  const hand = {
    number: (room.handCounter = (room.handCounter || 0) + 1),
    street: 'preflop',
    order,
    dealerId: room.dealerId,
    sbId,
    bbId,
    committed: {},        // chips put in on current street, per player
    totalCommitted: {},   // chips put in for whole hand, per player
    folded: [],
    allIn: [],
    acted: [],            // acted since last full raise (current street)
    currentBet: 0,
    minRaise: room.settings.bigBlind,
    toActId: null,
    pots: null,           // computed at showdown: [{amount, eligible, awarded}]
    winners: null,
  };
  for (const id of order) {
    hand.committed[id] = 0;
    hand.totalCommitted[id] = 0;
  }
  room.hand = hand;

  postBlind(room, sbId, room.settings.smallBlind, 'small blind');
  postBlind(room, bbId, room.settings.bigBlind, 'big blind');
  hand.currentBet = room.settings.bigBlind;

  const firstIdx = headsUp ? dPos : (dPos + 3) % n;
  hand.toActId = nextActable(room, firstIdx);
  log(room, `Hand #${hand.number} — ${player(room, room.dealerId).name} deals. Blinds ${room.settings.smallBlind}/${room.settings.bigBlind}.`);
  return room;
}

function postBlind(room, id, amount, label) {
  const p = player(room, id);
  const pay = Math.min(amount, p.stack);
  p.stack -= pay;
  room.hand.committed[id] += pay;
  room.hand.totalCommitted[id] += pay;
  if (p.stack === 0) {
    room.hand.allIn.push(id);
    log(room, `${p.name} posts ${label} ${pay} and is all-in`);
  }
}

function isActable(room, id) {
  const h = room.hand;
  if (h.folded.includes(id) || h.allIn.includes(id)) return false;
  return h.committed[id] < h.currentBet || !h.acted.includes(id);
}

// Find next actable player starting AT index startIdx (inclusive), scanning forward.
function nextActable(room, startIdx) {
  const h = room.hand;
  const n = h.order.length;
  for (let i = 0; i < n; i++) {
    const id = h.order[(startIdx + i) % n];
    if (isActable(room, id)) return id;
  }
  return null;
}

function livePlayers(room) {
  const h = room.hand;
  return h.order.filter((id) => !h.folded.includes(id));
}

export function potTotal(room) {
  const h = room.hand;
  if (!h) return 0;
  return Object.values(h.totalCommitted).reduce((a, b) => a + b, 0);
}

export function callAmount(room, id) {
  const h = room.hand;
  const p = player(room, id);
  return Math.min(h.currentBet - h.committed[id], p.stack);
}

export function canRaise(room, id) {
  const h = room.hand;
  const p = player(room, id);
  if (h.committed[id] + p.stack <= h.currentBet) return false; // can't even fully call
  // Facing an under-raise all-in after already acting: betting is not reopened.
  return !h.acted.includes(id) || h.currentBet === 0 || !h.underRaise;
}

export function minRaiseTo(room) {
  const h = room.hand;
  return h.currentBet === 0 ? room.settings.bigBlind : h.currentBet + h.minRaise;
}

export function applyAction(room, id, action, amount) {
  const h = room.hand;
  if (!h) throw new Error('No hand in progress');
  if (h.street === 'showdown') throw new Error('Hand is at showdown');
  if (h.toActId !== id) throw new Error('Not your turn');
  const p = player(room, id);
  const toCall = h.currentBet - h.committed[id];

  if (action === 'fold') {
    h.folded.push(id);
    if (!h.acted.includes(id)) h.acted.push(id);
    log(room, `${p.name} folds`);
  } else if (action === 'check') {
    if (toCall > 0) throw new Error('Cannot check, there is a bet');
    h.acted.push(id);
    log(room, `${p.name} checks`);
  } else if (action === 'call') {
    if (toCall <= 0) throw new Error('Nothing to call');
    const pay = Math.min(toCall, p.stack);
    p.stack -= pay;
    h.committed[id] += pay;
    h.totalCommitted[id] += pay;
    if (!h.acted.includes(id)) h.acted.push(id);
    if (p.stack === 0) {
      h.allIn.push(id);
      log(room, `${p.name} calls ${pay} and is all-in`);
    } else {
      log(room, `${p.name} calls ${pay}`);
    }
  } else if (action === 'raise' || action === 'allin') {
    let to = action === 'allin' ? h.committed[id] + p.stack : Math.floor(Number(amount));
    if (!Number.isFinite(to) || to <= 0) throw new Error('Invalid amount');
    const maxTo = h.committed[id] + p.stack;
    if (to > maxTo) throw new Error('Not enough chips');
    if (to <= h.currentBet) {
      // A short all-in that doesn't exceed the current bet is just a call.
      if (to === maxTo && to > h.committed[id]) return applyAction(room, id, 'call');
      throw new Error('Raise must exceed current bet');
    }
    if (!canRaise(room, id)) throw new Error('Betting is not reopened for you — call or fold');
    const raiseBy = to - h.currentBet;
    const isAllIn = to === maxTo;
    const fullRaise = raiseBy >= h.minRaise;
    if (!fullRaise && !isAllIn) throw new Error(`Minimum raise is to ${minRaiseTo(room)}`);

    const pay = to - h.committed[id];
    p.stack -= pay;
    h.committed[id] = to;
    h.totalCommitted[id] += pay;
    h.currentBet = to;
    if (fullRaise) {
      h.minRaise = raiseBy;
      h.underRaise = false;
      h.acted = [id]; // everyone else must act again
    } else {
      h.underRaise = true; // all-in under-raise: no reopen for players who acted
      if (!h.acted.includes(id)) h.acted.push(id);
    }
    if (isAllIn) {
      h.allIn.push(id);
      log(room, `${p.name} is all-in for ${to}`);
    } else {
      log(room, `${p.name} ${h.currentBet === raiseBy ? 'bets' : 'raises to'} ${to}`);
    }
  } else {
    throw new Error('Unknown action');
  }

  afterAction(room, id);
  return room;
}

function afterAction(room, actorId) {
  const h = room.hand;
  const live = livePlayers(room);

  // Everyone else folded — actor wins the pot without showdown.
  if (live.length === 1) {
    const winnerId = live[0];
    const p = player(room, winnerId);
    const amount = potTotal(room);
    p.stack += amount;
    h.winners = [{ id: winnerId, amount, reason: 'all others folded' }];
    log(room, `${p.name} wins ${amount} — everyone else folded`);
    finishHand(room);
    return;
  }

  // Next player on this street?
  const fromIdx = (h.order.indexOf(actorId) + 1) % h.order.length;
  const next = nextActable(room, fromIdx);
  if (next) {
    h.toActId = next;
    return;
  }

  // Street complete.
  advanceStreet(room);
}

function advanceStreet(room) {
  const h = room.hand;
  const live = livePlayers(room);
  const canStillBet = live.filter((id) => !h.allIn.includes(id));

  const idx = STREETS.indexOf(h.street);
  if (idx === STREETS.length - 1 || canStillBet.length <= 1) {
    // River done, or no more betting possible → showdown.
    goToShowdown(room, canStillBet.length <= 1 && idx < STREETS.length - 1);
    return;
  }

  h.street = STREETS[idx + 1];
  for (const id of h.order) h.committed[id] = 0;
  h.currentBet = 0;
  h.minRaise = room.settings.bigBlind;
  h.underRaise = false;
  h.acted = [];
  const dPos = h.order.indexOf(h.dealerId);
  h.toActId = nextActable(room, (dPos + 1) % h.order.length);
  log(room, `— ${h.street.toUpperCase()} — deal the ${h.street} now`);
}

function goToShowdown(room, ranOut) {
  const h = room.hand;
  h.street = 'showdown';
  h.toActId = null;
  h.pots = computePots(room);
  h.ranOut = !!ranOut;
  log(room, ranOut
    ? 'All-in — deal out the remaining cards, then the host awards the pot'
    : 'Showdown — compare hands, then the host awards the pot');

  // Auto-award pots that only one player is eligible for (uncalled excess).
  for (const pot of h.pots) {
    if (pot.eligible.length === 1) {
      const p = player(room, pot.eligible[0]);
      p.stack += pot.amount;
      pot.awarded = [{ id: p.id, amount: pot.amount }];
      log(room, `${p.name} takes back ${pot.amount} (uncalled)`);
    }
  }
  maybeFinishShowdown(room);
}

export function computePots(room) {
  const h = room.hand;
  const contributors = h.order.filter((id) => h.totalCommitted[id] > 0);
  const levels = [...new Set(contributors.map((id) => h.totalCommitted[id]))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const id of contributors) {
      amount += Math.max(0, Math.min(h.totalCommitted[id], level) - prev);
    }
    const eligible = contributors.filter((id) => !h.folded.includes(id) && h.totalCommitted[id] >= level);
    if (amount > 0) {
      const last = pots[pots.length - 1];
      if (last && sameSet(last.eligible, eligible)) last.amount += amount;
      else pots.push({ amount, eligible, awarded: null });
    }
    prev = level;
  }
  return pots;
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export function awardPot(room, potIndex, winnerIds) {
  const h = room.hand;
  if (!h || h.street !== 'showdown') throw new Error('Not at showdown');
  const pot = h.pots?.[potIndex];
  if (!pot) throw new Error('No such pot');
  if (pot.awarded) throw new Error('Pot already awarded');
  const winners = [...new Set(winnerIds)].filter((id) => pot.eligible.includes(id));
  if (winners.length === 0) throw new Error('Pick at least one eligible winner');

  // Order winners by seat after the dealer for odd-chip distribution.
  const dPos = h.order.indexOf(h.dealerId);
  const seatRank = (id) => (h.order.indexOf(id) - dPos - 1 + h.order.length * 2) % h.order.length;
  winners.sort((a, b) => seatRank(a) - seatRank(b));

  const base = Math.floor(pot.amount / winners.length);
  let remainder = pot.amount - base * winners.length;
  pot.awarded = winners.map((id) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    const amount = base + extra;
    player(room, id).stack += amount;
    return { id, amount };
  });
  const names = pot.awarded.map((w) => `${player(room, w.id).name} (+${w.amount})`).join(', ');
  log(room, `${potIndex === 0 ? 'Main pot' : `Side pot ${potIndex}`} of ${pot.amount} → ${names}`);
  maybeFinishShowdown(room);
  return room;
}

function maybeFinishShowdown(room) {
  const h = room.hand;
  if (h.pots && h.pots.every((p) => p.awarded)) {
    h.winners = h.pots.flatMap((p) => p.awarded);
    finishHand(room);
  }
}

function finishHand(room) {
  const h = room.hand;
  room.lastHand = {
    number: h.number,
    winners: h.winners,
    pot: potTotal(room),
  };
  room.hand = null;
  // Bust notifications.
  for (const p of room.players) {
    if (p.stack === 0 && h.order.includes(p.id)) log(room, `${p.name} is out of chips`);
  }
}

export function forceFold(room, id) {
  const h = room.hand;
  if (!h || h.street === 'showdown') throw new Error('No betting in progress');
  if (h.toActId !== id) throw new Error('That player is not up');
  return applyAction(room, id, 'fold');
}

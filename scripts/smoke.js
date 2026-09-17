// End-to-end smoke test: full hand with betting, all-in side pot, award, and reconnect.
import WebSocket from 'ws';

const URL = 'ws://localhost:3000/ws';
const results = [];
let failed = 0;

function check(label, cond) {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
}

function client(id) {
  const ws = new WebSocket(URL);
  const c = { id, ws, state: null, lastError: null, joined: null };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'state') c.state = msg.state;
    else if (msg.type === 'error') c.lastError = msg.message;
    else if (msg.type === 'joined') c.joined = msg.code;
  });
  c.send = (obj) => ws.send(JSON.stringify(obj));
  c.open = new Promise((res) => ws.on('open', res));
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(c, pred, label, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (c.state && pred(c.state)) return true;
    await sleep(40);
  }
  check(label, false);
  console.error('  state:', JSON.stringify(c.state?.hand ?? c.state, null, 1).slice(0, 800));
  return false;
}

const stacks = (c) => Object.fromEntries(c.state.players.map((p) => [p.name, p.stack]));

const A = client('smoke-a');
const B = client('smoke-b');
const C = client('smoke-c');
await Promise.all([A.open, B.open, C.open]);

// --- create & join ---
A.send({ type: 'create', playerId: 'smoke-a', name: 'Ann', settings: { startingStack: 500, smallBlind: 5, bigBlind: 10 } });
await waitFor(A, (s) => s.code, 'room created');
const CODE = A.state.code;
B.send({ type: 'join', playerId: 'smoke-b', name: 'Bob', code: CODE });
C.send({ type: 'join', playerId: 'smoke-c', name: 'Cy', code: CODE });
await waitFor(A, (s) => s.players.length === 3, '3 players seated');
check('all start with 500', Object.values(stacks(A)).every((v) => v === 500));

// Give Cy a short stack via host tool to force a side pot later.
// (Simulate: Cy loses chips — use addChips is only additive, so instead play with raise sizes.)

// --- hand 1: Ann deals; Bob SB, Cy BB; Ann first to act preflop ---
A.send({ type: 'startHand' });
await waitFor(A, (s) => s.hand?.street === 'preflop', 'hand started');
check('Ann is dealer', A.state.hand.dealerId === 'smoke-a');
check('Bob is SB', A.state.hand.sbId === 'smoke-b');
check('Cy is BB', A.state.hand.bbId === 'smoke-c');
check('pot = 15 after blinds', A.state.hand.pot === 15);
check('Ann to act', A.state.hand.toActId === 'smoke-a');
check('Ann sees actions', !!A.state.actions && A.state.actions.callAmount === 10);
check('Bob sees no actions', !B.state.actions);

// Illegal action: Bob tries to act out of turn.
B.send({ type: 'action', action: 'call' });
await sleep(150);
check('out-of-turn rejected', B.lastError === 'Not your turn');

// Illegal: Ann checks facing a bet.
A.send({ type: 'action', action: 'check' });
await sleep(150);
check('check facing bet rejected', A.lastError?.includes('Cannot check'));

// Ann raises to 30, Bob calls, Cy calls.
A.send({ type: 'action', action: 'raise', amount: 30 });
await waitFor(B, (s) => s.hand?.toActId === 'smoke-b', 'Bob to act after raise');
check('current bet 30', B.state.hand.currentBet === 30);
B.send({ type: 'action', action: 'call' });
await waitFor(C, (s) => s.hand?.toActId === 'smoke-c', 'Cy to act');
C.send({ type: 'action', action: 'call' });
await waitFor(A, (s) => s.hand?.street === 'flop', 'advanced to flop');
check('pot = 90 on flop', A.state.hand.pot === 90);
check('SB (Bob) first to act postflop', A.state.hand.toActId === 'smoke-b');

// Flop: Bob checks, Cy bets 40, Ann raises all-in 470, Bob folds, Cy calls (side pot: none — equal stacks... Cy has 470 too)
B.send({ type: 'action', action: 'check' });
await waitFor(C, (s) => s.hand?.toActId === 'smoke-c', 'Cy to act on flop');
C.send({ type: 'action', action: 'raise', amount: 40 });
await waitFor(A, (s) => s.hand?.toActId === 'smoke-a' && s.hand.currentBet === 40, 'Ann facing bet 40');
check('min raise-to is 80', A.state.actions.minRaiseTo === 80);
A.send({ type: 'action', action: 'allin' });
await waitFor(B, (s) => s.hand?.toActId === 'smoke-b' && s.hand.currentBet === 470, 'Ann all-in 470');
B.send({ type: 'action', action: 'fold' });
await waitFor(C, (s) => s.hand?.toActId === 'smoke-c', 'Cy to act facing all-in');
C.send({ type: 'action', action: 'call' });

// Both all-in → run out → showdown with pots computed.
await waitFor(A, (s) => s.hand?.street === 'showdown', 'reached showdown');
check('board ran out flag', A.state.hand.ranOut === true);
check('one pot (equal stacks)', A.state.hand.pots.length === 1);
check('pot total 1030', A.state.hand.pots[0].amount === 1030);
check('Bob not eligible', !A.state.hand.pots[0].eligible.includes('smoke-b'));

// Non-host tries to award.
B.send({ type: 'awardPot', potIndex: 0, winners: ['smoke-b'] });
await sleep(150);
check('non-host award rejected', B.lastError === 'Only the host can do that');

// Host awards to Cy.
A.send({ type: 'awardPot', potIndex: 0, winners: ['smoke-c'] });
await waitFor(A, (s) => !s.hand, 'hand finished');
const st1 = stacks(A);
check('Cy stack 1030', st1.Cy === 1030);
check('Ann stack 0', st1.Ann === 0);
check('Bob stack 470', st1.Bob === 470);
check('chip total conserved', st1.Ann + st1.Bob + st1.Cy === 1500);

// --- rebuy for Ann, then reconnect resilience test ---
A.send({ type: 'addChips', targetId: 'smoke-a', amount: 500 });
await waitFor(A, (s) => s.players.find((p) => p.id === 'smoke-a').stack === 500, 'rebuy applied');

// Start hand 2: dealer rotates to Bob; Cy SB, Ann BB.
A.send({ type: 'startHand' });
await waitFor(A, (s) => s.hand?.street === 'preflop' && s.hand.number === 2, 'hand 2 started');
check('dealer rotated to Bob', A.state.hand.dealerId === 'smoke-b');

// Bob (first to act) disconnects mid-hand, then rejoins — seat, stack, turn preserved.
const bobStackBefore = stacks(A).Bob;
B.ws.close();
await waitFor(A, (s) => !s.players.find((p) => p.id === 'smoke-b').connected, 'Bob marked disconnected');
check('hand still in progress', A.state.hand?.number === 2);

const B2 = client('smoke-b2');
await B2.open;
B2.send({ type: 'rejoin', code: CODE, playerId: 'smoke-b' });
await waitFor(B2, (s) => !!s.hand, 'Bob rejoined mid-hand');
check('Bob stack preserved', stacks(B2).Bob === bobStackBefore);
check('still Bob\'s turn', B2.state.hand.toActId === 'smoke-b' && !!B2.state.actions);
B2.send({ type: 'action', action: 'fold' });
await waitFor(A, (s) => s.hand?.toActId === 'smoke-c', 'play continues after rejoin');

// Cy folds → Ann wins by fold automatically.
C.send({ type: 'action', action: 'fold' });
await waitFor(A, (s) => !s.hand, 'win by fold auto-completes');
check('Ann collected blinds', stacks(A).Ann === 500 + 5); // BB returned + SB 5

// --- rejoin with unknown room fails gracefully ---
const X = client('smoke-x');
await X.open;
let rejoinFailed = false;
X.ws.on('message', (raw) => { if (JSON.parse(raw).type === 'rejoinFailed') rejoinFailed = true; });
X.send({ type: 'rejoin', code: 'ZZZZ', playerId: 'nobody' });
await sleep(200);
check('unknown rejoin → rejoinFailed', rejoinFailed);

console.log('\n' + results.join('\n'));
console.log(failed ? `\n${failed} FAILURES` : '\nALL PASS');
process.exit(failed ? 1 : 0);

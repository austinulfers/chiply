/* Chiply client — WebSocket state sync, reconnect-resilient via localStorage identity. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---------- identity & session ----------
  const playerId = (() => {
    let id = localStorage.getItem('chiply:playerId');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('chiply:playerId', id);
    }
    return id;
  })();

  const session = {
    get code() { return localStorage.getItem('chiply:room'); },
    set code(v) { v ? localStorage.setItem('chiply:room', v) : localStorage.removeItem('chiply:room'); },
    get name() { return localStorage.getItem('chiply:name') || ''; },
    set name(v) { localStorage.setItem('chiply:name', v); },
  };

  // ---------- websocket with auto-reconnect ----------
  let ws = null;
  let state = null;
  let reconnectDelay = 500;
  let intentionalClose = false;
  let pendingIntent = null; // action to send once connected

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      reconnectDelay = 500;
      setConnDot(true);
      if (pendingIntent) {
        ws.send(JSON.stringify(pendingIntent));
        pendingIntent = null;
      } else if (session.code) {
        ws.send(JSON.stringify({ type: 'rejoin', code: session.code, playerId }));
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };

    ws.onclose = (ev) => {
      setConnDot(false);
      if (intentionalClose || ev.code === 4000) return; // replaced by another tab
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    };
    ws.onerror = () => ws.close();
  }

  function sendMsg(obj) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    else toast('Reconnecting…', true);
  }

  let prevHandView = { num: null, street: null };
  let prevToActId = null;

  function handleMessage(msg) {
    if (msg.type === 'state') {
      const prev = prevHandView;
      const wasMyTurn = prevToActId === (state?.you ?? null) && prevToActId != null;
      state = msg.state;
      const h = state.hand;
      prevHandView = { num: h?.number ?? null, street: h?.street ?? null };
      const isMyTurn = h?.toActId === state.you && h?.street !== 'showdown';
      if (isMyTurn && !wasMyTurn) turnAlert();
      prevToActId = isMyTurn ? state.you : null;
      if (h && prev.num === h.number && prev.street && prev.street !== h.street) {
        announceStreet(prev.street, h);
      }
      render();
    } else if (msg.type === 'joined') {
      session.code = msg.code;
      showView('table');
    } else if (msg.type === 'left') {
      session.code = null;
      state = null;
      showView('home');
    } else if (msg.type === 'rejoinFailed') {
      session.code = null;
      showView('home');
    } else if (msg.type === 'error') {
      toast(msg.message, true);
    }
  }

  // ---------- views ----------
  function showView(name) {
    $('view-home').classList.toggle('hidden', name !== 'home');
    $('view-table').classList.toggle('hidden', name !== 'table');
    if (name === 'home') { renderHome(); releaseWakeLock(); }
    else acquireWakeLock();
  }

  function setConnDot(on) {
    $('conn-dot').classList.toggle('offline', !on);
  }

  // ---------- turn alerts: chime + vibration + wake lock ----------
  let alertsOn = localStorage.getItem('chiply:alerts') !== 'off';
  let audioCtx = null;

  function ensureAudio() {
    if (!alertsOn) return;
    try {
      audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch { /* no audio support */ }
  }

  function chime() {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const t = audioCtx.currentTime;
    // Two-note "ding-dong"
    [[880, 0], [1174.66, 0.12]].forEach(([freq, delay]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.18, t + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.5);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.55);
    });
  }

  function turnAlert() {
    if (!alertsOn || document.hidden) return; // background tabs can't play anyway
    chime();
    navigator.vibrate?.([180, 90, 180]);
  }

  // Keep the screen awake while seated at a table.
  let wakeLock = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* denied (low battery etc.) */ }
  }
  function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }

  // ---------- street-advance animation ("pot is good, dealer flips") ----------
  const RUNOUT_CARDS = { preflop: 5, flop: 2, turn: 1 };

  function announceStreet(prevStreet, h) {
    if (h.street === 'flop') playStreetAnimation('Dealer — flip the flop', 3);
    else if (h.street === 'turn') playStreetAnimation('Dealer — flip the turn', 1);
    else if (h.street === 'river') playStreetAnimation('Dealer — flip the river', 1);
    else if (h.street === 'showdown') {
      if (h.ranOut) playStreetAnimation('All-in — run out the board', RUNOUT_CARDS[prevStreet] ?? 0);
      else playStreetAnimation('Showdown — reveal your hands', 0);
    }
  }

  function playStreetAnimation(subtitle, cardCount) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.querySelector('.street-overlay')?.remove();
    const ov = document.createElement('div');
    ov.className = 'street-overlay';
    const inner = document.createElement('div');
    inner.className = 'street-overlay-inner';

    for (let i = 0; i < 8; i++) {
      const c = document.createElement('span');
      c.className = 'sweep-chip';
      const angle = (i / 8) * 2 * Math.PI;
      c.style.setProperty('--dx', `${Math.round(Math.cos(angle) * 150)}px`);
      c.style.setProperty('--dy', `${Math.round(Math.sin(angle) * 100)}px`);
      c.style.animationDelay = `${i * 0.03}s`;
      inner.appendChild(c);
    }

    const title = document.createElement('div');
    title.className = 'pot-good';
    title.textContent = 'POT IS GOOD';
    inner.appendChild(title);

    if (cardCount > 0) {
      const cards = document.createElement('div');
      cards.className = 'flip-cards';
      for (let i = 0; i < cardCount; i++) {
        const card = document.createElement('div');
        card.className = 'flip-card';
        card.style.animationDelay = `${0.55 + i * 0.18}s`;
        const flip = document.createElement('div');
        flip.className = 'flip-inner';
        flip.style.animationDelay = `${0.95 + i * 0.18}s`;
        const back = document.createElement('span');
        back.className = 'face back';
        const front = document.createElement('span');
        front.className = 'face front';
        front.textContent = '?';
        flip.append(back, front);
        card.appendChild(flip);
        cards.appendChild(card);
      }
      inner.appendChild(cards);
    }

    const sub = document.createElement('div');
    sub.className = 'street-sub';
    sub.textContent = subtitle;
    inner.appendChild(sub);

    ov.appendChild(inner);
    document.body.appendChild(ov);
    setTimeout(() => ov.remove(), 2600);
  }

  let toastTimer = null;
  function toast(text, isError = false) {
    const el = $('toast');
    el.textContent = text;
    el.classList.toggle('err', isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function fmt(n) {
    n = Number(n);
    const denom = state?.settings?.denom || 'none';
    if (denom === 'cents') {
      return (n / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
    }
    if (denom === 'dollars') {
      return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    }
    return n.toLocaleString();
  }

  // ---------- visual chip stacks ----------
  const CHIP_COLORS = [
    [1000, '#e8b23a'], [500, '#8e5bd9'], [100, '#23211f'], [25, '#2f9e57'],
    [10, '#3d7fd9'], [5, '#c93a3f'], [1, '#e9e6df'],
  ];

  function chipStack(amount, big = false) {
    const wrap = document.createElement('div');
    wrap.className = 'chips' + (big ? ' big' : '');
    let rest = Math.max(0, Math.floor(amount));
    for (const [value, color] of CHIP_COLORS) {
      const count = Math.floor(rest / value);
      if (!count) continue;
      rest -= count * value;
      const group = document.createElement('span');
      group.className = 'chip-group';
      group.title = `${count} × ${fmt(value)}`;
      const shown = Math.min(count, 4);
      for (let i = 0; i < shown; i++) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.style.background = color;
        if (value === 100 || value === 500) c.style.borderColor = '#ffffffcc';
        group.appendChild(c);
      }
      if (count > shown) {
        const more = document.createElement('span');
        more.className = 'chip-count';
        more.textContent = `×${count}`;
        group.appendChild(more);
      }
      wrap.appendChild(group);
    }
    return wrap;
  }

  const visualChips = () => state?.settings?.chipStyle === 'visual';

  // ---------- home ----------
  function renderHome() {
    $('name-input').value = session.name;
    const banner = $('resume-banner');
    if (session.code) {
      banner.classList.remove('hidden');
      $('resume-code').textContent = session.code;
    } else {
      banner.classList.add('hidden');
    }
  }

  function requireName() {
    const name = $('name-input').value.trim();
    if (!name) {
      toast('Enter your name first', true);
      $('name-input').focus();
      return null;
    }
    session.name = name;
    return name;
  }

  $('btn-create').addEventListener('click', () => {
    const name = requireName();
    if (!name) return;
    const intent = {
      type: 'create', playerId, name,
      settings: {
        startingStack: Number($('opt-stack').value),
        smallBlind: Number($('opt-sb').value),
        bigBlind: Number($('opt-bb').value),
        denom: $('opt-denom').value,
        chipStyle: $('opt-chipstyle').value,
      },
    };
    ws?.readyState === WebSocket.OPEN ? sendMsg(intent) : (pendingIntent = intent, connect());
  });

  $('btn-join').addEventListener('click', joinRoom);
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

  function joinRoom() {
    const name = requireName();
    if (!name) return;
    const code = $('join-code').value.trim().toUpperCase();
    if (code.length !== 4) return toast('Room codes are 4 characters', true);
    sendMsg({ type: 'join', playerId, name, code });
  }

  $('btn-resume').addEventListener('click', () => {
    sendMsg({ type: 'rejoin', code: session.code, playerId });
  });

  // ---------- table rendering ----------
  function render() {
    if (!state) return;
    const s = state;
    const me = s.players.find((p) => p.id === s.you);
    const isHost = s.hostId === s.you;
    const h = s.hand;

    $('room-code-text').textContent = s.code;

    // Street / pot
    if (h) {
      const streetNames = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' };
      $('street-label').textContent = `Hand #${h.number} · ${streetNames[h.street]}`;
      $('pot-amount').textContent = fmt(h.pot);
      if (h.street === 'showdown') {
        $('hand-info').textContent = h.ranOut ? 'Run out the board with the physical cards' : 'Compare hands at the table';
      } else {
        const toAct = s.players.find((p) => p.id === h.toActId);
        $('hand-info').textContent = h.currentBet > 0
          ? `Bet to match: ${fmt(h.currentBet)} · ${toAct ? toAct.name : ''} to act`
          : `No bet yet · ${toAct ? toAct.name : ''} to act`;
      }
      renderPotChips(h.pot);
      renderPotBreakdown(h);
    } else {
      renderPotChips(0);
      renderPotBreakdown(null);
      $('street-label').textContent = s.players.length < 2 ? 'Waiting for players…' : 'Between hands';
      $('pot-amount').textContent = s.lastHand ? fmt(s.lastHand.pot) : '0';
      $('hand-info').textContent = s.lastHand
        ? `Hand #${s.lastHand.number} won by ${s.lastHand.winners.map((w) => nameOf(w.id)).join(', ')}`
        : `Blinds ${fmt(s.settings.smallBlind)}/${fmt(s.settings.bigBlind)}`;
    }

    renderPlayers();
    renderHostPanel(isHost);
    renderActionBar(me);
    renderMyStatus(me);
    renderLog();

    // Footer
    $('btn-sitout').textContent = me?.sittingOut ? 'Deal me in' : 'Sit out';
    $('btn-alerts').textContent = alertsOn ? '\u{1F514} On' : '\u{1F515} Off';
    $('btn-host-tools').classList.toggle('hidden', !isHost);
  }

  function nameOf(id) {
    const p = state?.players.find((x) => x.id === id);
    return p ? p.name : '?';
  }

  function renderPotChips(amount) {
    const el = $('pot-chips');
    el.textContent = '';
    if (!visualChips() || amount <= 0) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    el.appendChild(chipStack(amount, true));
  }

  let expandedPot = null; // pot index whose eligibility detail is open

  function renderPotBreakdown(h) {
    const el = $('pot-breakdown');
    el.textContent = '';
    // Only meaningful once the pot has split (or at showdown).
    if (!h || !h.pots || h.pots.length < 2) {
      el.classList.add('hidden');
      expandedPot = null;
      return;
    }
    el.classList.remove('hidden');
    h.pots.forEach((pot, i) => {
      const pill = document.createElement('button');
      pill.className = 'pot-pill' + (pot.awarded ? ' awarded' : '') + (expandedPot === i ? ' open' : '');
      const label = i === 0 ? 'Main' : `Side ${i}`;
      pill.textContent = `${label} · ${fmt(pot.amount)}`;
      pill.addEventListener('click', () => {
        expandedPot = expandedPot === i ? null : i;
        render();
      });
      el.appendChild(pill);
    });
    if (expandedPot != null && h.pots[expandedPot]) {
      const pot = h.pots[expandedPot];
      const detail = document.createElement('div');
      detail.className = 'pot-detail';
      detail.textContent = pot.awarded
        ? `Won by ${pot.awarded.map((w) => `${nameOf(w.id)} (+${fmt(w.amount)})`).join(', ')}`
        : `Eligible: ${pot.eligible.map(nameOf).join(', ')}`;
      el.appendChild(detail);
    }
  }

  function moveSeat(index, delta) {
    const order = state.players.map((p) => p.id);
    const to = index + delta;
    if (to < 0 || to >= order.length) return;
    [order[index], order[to]] = [order[to], order[index]];
    sendMsg({ type: 'reorderSeats', order });
  }

  function renderPlayers() {
    const s = state;
    const h = s.hand;
    const editing = seatEditMode && !h && s.hostId === s.you;
    const ul = $('players');
    ul.textContent = '';
    s.players.forEach((p, idx) => {
      const li = document.createElement('li');
      li.className = 'player';
      if (h && h.toActId === p.id && h.street !== 'showdown') li.classList.add('to-act');
      if (p.folded) li.classList.add('folded');
      if (p.id === s.you) li.classList.add('me');

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = p.name.slice(0, 2).toUpperCase();
      const presence = document.createElement('span');
      presence.className = 'presence' + (p.connected ? '' : ' off');
      avatar.appendChild(presence);
      if (editing) {
        const num = document.createElement('span');
        num.className = 'seat-num';
        num.textContent = idx + 1;
        avatar.appendChild(num);
      }

      const mid = document.createElement('div');
      mid.className = 'p-mid';
      const nameRow = document.createElement('div');
      nameRow.className = 'p-name';
      nameRow.appendChild(document.createTextNode(p.id === s.you ? `${p.name} (you)` : p.name));
      const dealerId = h ? h.dealerId : s.dealerId;
      if (dealerId === p.id) nameRow.appendChild(badge('D', 'dealer'));
      if (h?.sbId === p.id) nameRow.appendChild(badge('SB', 'sb'));
      if (h?.bbId === p.id) nameRow.appendChild(badge('BB', 'bb'));
      if (p.id === s.hostId) nameRow.appendChild(badge('HOST', 'status'));
      if (p.sittingOut) nameRow.appendChild(badge('OUT', 'status'));
      mid.appendChild(nameRow);

      const sub = document.createElement('div');
      sub.className = 'p-sub';
      if (p.folded) sub.textContent = 'Folded';
      else if (p.allIn) sub.innerHTML = `<span class="p-bet">ALL-IN · ${fmt(p.totalCommitted)}</span>`;
      else if (h && p.inHand && p.committed > 0) sub.innerHTML = `Bet: <span class="p-bet">${fmt(p.committed)}</span>`;
      else if (h && !p.inHand) sub.textContent = 'Not in hand';
      else sub.textContent = p.connected ? '' : 'Disconnected — seat & chips saved';
      mid.appendChild(sub);
      if (visualChips() && h && p.committed > 0 && !p.folded) {
        mid.appendChild(chipStack(p.committed));
      }

      const stack = document.createElement('div');
      stack.className = 'p-stack';
      stack.innerHTML = `<span class="amt">${fmt(p.stack)}</span><span class="lbl">CHIPS</span>`;
      if (visualChips() && p.stack > 0) stack.appendChild(chipStack(p.stack));

      li.append(avatar, mid, stack);
      if (editing) {
        const controls = document.createElement('div');
        controls.className = 'seat-controls';
        const up = document.createElement('button');
        up.className = 'btn round seat-btn';
        up.textContent = '▲';
        up.disabled = idx === 0;
        up.setAttribute('aria-label', `Move ${p.name} up`);
        up.addEventListener('click', () => moveSeat(idx, -1));
        const down = document.createElement('button');
        down.className = 'btn round seat-btn';
        down.textContent = '▼';
        down.disabled = idx === s.players.length - 1;
        down.setAttribute('aria-label', `Move ${p.name} down`);
        down.addEventListener('click', () => moveSeat(idx, 1));
        controls.append(up, down);
        li.appendChild(controls);
        li.classList.add('editing');
      }
      ul.appendChild(li);
    });
  }

  function badge(text, cls) {
    const b = document.createElement('span');
    b.className = `badge ${cls}`;
    b.textContent = text;
    return b;
  }

  // ---------- host panel (start hand / seats / award pots) ----------
  const awardSelections = new Map(); // potIndex -> Set of winner ids
  let seatEditMode = false;

  function renderHostPanel(isHost) {
    const s = state;
    const panel = $('host-panel');
    panel.textContent = '';
    panel.classList.add('hidden');
    if (!isHost) { awardSelections.clear(); seatEditMode = false; return; }

    if (!s.hand) {
      awardSelections.clear();
      if (seatEditMode) {
        const hint = document.createElement('p');
        hint.className = 'seat-hint';
        hint.textContent = 'Move players so the order below matches clockwise seating at your table.';
        panel.appendChild(hint);
        const done = document.createElement('button');
        done.className = 'btn primary wide';
        done.textContent = 'Done arranging';
        done.addEventListener('click', () => { seatEditMode = false; render(); });
        panel.appendChild(done);
        panel.classList.remove('hidden');
        return;
      }
      if (s.canStart) {
        const btn = document.createElement('button');
        btn.className = 'btn primary wide';
        btn.textContent = s.lastHand ? 'Deal next hand' : 'Start first hand';
        btn.addEventListener('click', () => sendMsg({ type: 'startHand' }));
        panel.appendChild(btn);
      }
      if (s.players.length >= 2) {
        const arrange = document.createElement('button');
        arrange.className = 'btn ghost wide';
        arrange.textContent = 'Arrange seats';
        arrange.addEventListener('click', () => { seatEditMode = true; render(); });
        panel.appendChild(arrange);
      }
      if (panel.children.length) panel.classList.remove('hidden');
      return;
    }
    seatEditMode = false;

    if (s.hand.street === 'showdown' && s.hand.pots) {
      s.hand.pots.forEach((pot, i) => {
        if (pot.awarded) return;
        const box = document.createElement('div');
        box.className = 'pot-award';
        const title = document.createElement('h4');
        title.textContent = `${i === 0 ? 'Main pot' : `Side pot ${i}`}: ${fmt(pot.amount)}`;
        box.appendChild(title);
        const note = document.createElement('p');
        note.className = 'award-note';
        note.textContent = 'Tap the winner(s) — select multiple to split a chopped pot.';
        box.appendChild(note);

        if (!awardSelections.has(i)) awardSelections.set(i, new Set());
        const sel = awardSelections.get(i);
        const choices = document.createElement('div');
        choices.className = 'winner-choices';
        for (const pid of pot.eligible) {
          const b = document.createElement('button');
          b.className = 'btn' + (sel.has(pid) ? ' selected' : '');
          b.textContent = nameOf(pid);
          b.addEventListener('click', () => {
            sel.has(pid) ? sel.delete(pid) : sel.add(pid);
            render();
          });
          choices.appendChild(b);
        }
        box.appendChild(choices);

        const confirm = document.createElement('button');
        confirm.className = 'btn primary wide';
        confirm.disabled = sel.size === 0;
        confirm.textContent = sel.size > 1 ? `Split pot ${sel.size} ways` : 'Award pot';
        confirm.addEventListener('click', () => {
          sendMsg({ type: 'awardPot', potIndex: i, winners: [...sel] });
          awardSelections.delete(i);
        });
        box.appendChild(confirm);
        panel.appendChild(box);
      });
      if (panel.children.length) panel.classList.remove('hidden');
    }
  }

  // ---------- action bar ----------
  let raiseOpen = false;

  function renderActionBar(me) {
    const a = state.actions;
    const bar = $('action-bar');
    if (!a || !me) {
      bar.classList.add('hidden');
      raiseOpen = false;
      return;
    }
    bar.classList.remove('hidden');

    $('btn-check').classList.toggle('hidden', !a.canCheck);
    $('btn-call').classList.toggle('hidden', a.canCheck);
    if (!a.canCheck) {
      $('btn-call').textContent = a.callIsAllIn ? `All-in ${fmt(a.callAmount)}` : `Call ${fmt(a.callAmount)}`;
    }
    const raiseBtn = $('btn-raise-open');
    raiseBtn.classList.toggle('hidden', !a.canRaise);
    raiseBtn.textContent = state.hand.currentBet > 0 ? 'Raise' : 'Bet';

    const panel = $('raise-panel');
    panel.classList.toggle('hidden', !raiseOpen);
    if (raiseOpen) syncRaiseInputs();
  }

  function syncRaiseInputs(setValue) {
    const a = state.actions;
    if (!a) return;
    const slider = $('raise-slider');
    const input = $('raise-amount');
    slider.min = a.minRaiseTo;
    slider.max = a.maxRaiseTo;
    slider.step = Math.max(1, state.settings.smallBlind);
    let v = setValue ?? Number(input.value);
    if (!Number.isFinite(v) || v < a.minRaiseTo) v = a.minRaiseTo;
    if (v > a.maxRaiseTo) v = a.maxRaiseTo;
    slider.value = v;
    input.value = v;
    $('btn-raise-confirm').textContent =
      v >= a.maxRaiseTo ? `All-in ${fmt(v)}` : `${state.hand.currentBet > 0 ? 'Raise to' : 'Bet'} ${fmt(v)}`;
  }

  function renderMyStatus(me) {
    const el = $('my-status');
    const s = state;
    el.classList.add('hidden');
    if (!me) return;
    const h = s.hand;
    let text = '';
    if (h && h.street !== 'showdown') {
      const mine = s.players.find((p) => p.id === s.you);
      if (mine.folded) text = 'You folded — wait for the next hand';
      else if (mine.allIn) text = `You're all-in for ${fmt(mine.totalCommitted)} — good luck!`;
      else if (h.toActId !== s.you && mine.inHand) text = `Waiting for ${nameOf(h.toActId)}…`;
      else if (!mine.inHand) text = 'You\'ll be dealt in next hand';
    } else if (h && h.street === 'showdown' && s.hostId !== s.you) {
      text = 'Showdown — the host will award the pot';
    } else if (!h && me.stack === 0) {
      text = 'Out of chips — ask the host for a rebuy';
    }
    if (text) {
      el.textContent = text;
      el.classList.remove('hidden');
    }
  }

  function renderLog() {
    const ul = $('log');
    ul.textContent = '';
    for (const entry of state.log) {
      const li = document.createElement('li');
      li.textContent = entry.msg;
      ul.appendChild(li);
    }
  }

  // ---------- action handlers ----------
  $('btn-fold').addEventListener('click', () => { raiseOpen = false; sendMsg({ type: 'action', action: 'fold' }); });
  $('btn-check').addEventListener('click', () => sendMsg({ type: 'action', action: 'check' }));
  $('btn-call').addEventListener('click', () => sendMsg({ type: 'action', action: 'call' }));
  $('btn-raise-open').addEventListener('click', () => { raiseOpen = true; render(); });
  $('btn-raise-cancel').addEventListener('click', () => { raiseOpen = false; render(); });
  $('btn-raise-confirm').addEventListener('click', () => {
    const amount = Number($('raise-amount').value);
    raiseOpen = false;
    sendMsg({ type: 'action', action: 'raise', amount });
  });

  $('raise-slider').addEventListener('input', (e) => syncRaiseInputs(Number(e.target.value)));
  $('raise-amount').addEventListener('change', () => syncRaiseInputs());
  $('raise-minus').addEventListener('click', () => {
    const step = state.settings.bigBlind;
    syncRaiseInputs(Number($('raise-amount').value) - step);
  });
  $('raise-plus').addEventListener('click', () => {
    const step = state.settings.bigBlind;
    syncRaiseInputs(Number($('raise-amount').value) + step);
  });
  document.querySelectorAll('.raise-presets .btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = state.actions;
      if (!a) return;
      const pot = state.hand.pot;
      const bet = state.hand.currentBet;
      const map = {
        min: a.minRaiseTo,
        half: bet + Math.floor(pot / 2) || Math.floor(pot / 2),
        pot: bet + pot || pot,
        allin: a.maxRaiseTo,
      };
      syncRaiseInputs(map[btn.dataset.preset]);
    });
  });

  // ---------- misc table controls ----------
  $('room-code-btn').addEventListener('click', async () => {
    const url = `${location.origin}/?room=${state.code}`;
    const text = `Join my Chiply poker table! Room code: ${state.code}\n${url}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Chiply', text, url });
      else {
        await navigator.clipboard.writeText(text);
        toast('Invite copied to clipboard');
      }
    } catch { /* user cancelled share */ }
  });

  $('btn-leave').addEventListener('click', () => {
    if (confirm('Leave the table? Your seat and chips will be given up.')) {
      sendMsg({ type: 'leave' });
    }
  });

  $('btn-sitout').addEventListener('click', () => {
    const me = state?.players.find((p) => p.id === state.you);
    sendMsg({ type: 'sitOut', value: !me?.sittingOut });
  });

  $('btn-alerts').addEventListener('click', () => {
    alertsOn = !alertsOn;
    localStorage.setItem('chiply:alerts', alertsOn ? 'on' : 'off');
    if (alertsOn) {
      ensureAudio();
      chime(); // audible confirmation while we have the user gesture
      navigator.vibrate?.(80);
    }
    render();
  });

  // Audio contexts need a user gesture; prime on the first tap anywhere.
  document.addEventListener('pointerdown', ensureAudio, { once: true });

  // ---------- host tools sheet ----------
  $('btn-host-tools').addEventListener('click', () => {
    $('tool-sb').value = state.settings.smallBlind;
    $('tool-bb').value = state.settings.bigBlind;
    $('tool-denom').value = state.settings.denom || 'none';
    $('tool-chipstyle').value = state.settings.chipStyle || 'numeric';
    const undoBtn = $('tool-undo');
    undoBtn.disabled = !state.undoLabel;
    undoBtn.textContent = state.undoLabel ? `Undo — ${state.undoLabel}` : 'Nothing to undo';
    const sel = $('tool-player');
    sel.textContent = '';
    for (const p of state.players) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    $('sheet-backdrop').classList.remove('hidden');
  });
  $('sheet-close').addEventListener('click', () => $('sheet-backdrop').classList.add('hidden'));
  $('sheet-backdrop').addEventListener('click', (e) => {
    if (e.target === $('sheet-backdrop')) $('sheet-backdrop').classList.add('hidden');
  });
  $('tool-set-blinds').addEventListener('click', () => {
    sendMsg({ type: 'setBlinds', smallBlind: Number($('tool-sb').value), bigBlind: Number($('tool-bb').value) });
    $('sheet-backdrop').classList.add('hidden');
  });
  const sendDisplay = () => sendMsg({ type: 'setDisplay', denom: $('tool-denom').value, chipStyle: $('tool-chipstyle').value });
  $('tool-denom').addEventListener('change', sendDisplay);
  $('tool-chipstyle').addEventListener('change', sendDisplay);
  $('tool-add-chips').addEventListener('click', () => {
    sendMsg({ type: 'addChips', targetId: $('tool-player').value, amount: Number($('tool-chips').value) });
    $('tool-chips').value = '';
    $('sheet-backdrop').classList.add('hidden');
  });
  $('tool-force-fold').addEventListener('click', () => {
    const toActId = state?.hand?.toActId;
    if (!toActId) return toast('No one is up right now', true);
    if (confirm(`Fold ${nameOf(toActId)}'s hand?`)) {
      sendMsg({ type: 'forceFold', targetId: toActId });
      $('sheet-backdrop').classList.add('hidden');
    }
  });
  $('tool-undo').addEventListener('click', () => {
    if (!state?.undoLabel) return;
    if (confirm(`Undo “${state.undoLabel}”? Chips and the hand return to how they were just before it.`)) {
      sendMsg({ type: 'undo' });
      $('sheet-backdrop').classList.add('hidden');
    }
  });

  // ---------- boot ----------
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom && /^[A-Za-z0-9]{4}$/.test(urlRoom)) {
    $('join-code').value = urlRoom.toUpperCase();
    history.replaceState(null, '', '/');
  }
  showView('home');
  connect();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Reconnect promptly when returning to the app (phone unlock, tab switch).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (ws?.readyState !== WebSocket.OPEN) connect();
      if (session.code) acquireWakeLock(); // wake locks auto-release on hide
    }
  });
})();

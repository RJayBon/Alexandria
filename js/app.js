/* ==========================================================================
   ALEXANDRIA · app.js  (full-stack build — PHP + MySQL)
   No hardcoded data anywhere. The page embeds the live state once
   (window.__BOOT__), then every action POSTs to api/*.php → stored
   procedures → MySQL, and the client re-syncs via api/bootstrap.php.

   The five course data structures still live client-side as instrumentation:
   they are HYDRATED from database rows on every sync — BST/HashTable index
   the catalog for instant search, the Linked List mirrors the ledger table,
   the Stack mirrors checkin_checkpoints, the Queues mirror waitlist rows,
   and the toast Queue consumes the notifications table strictly FIFO.
   ========================================================================== */

'use strict';

(function () {
  /* ------------------------------ helpers ------------------------------ */
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const DAY = 86400000, HOUR = 3600000, MIN = 60000;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const pad2 = n => String(n).padStart(2, '0');
  const fmtDate  = ts => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  /* server clock offset — due labels count against MySQL's clock */
  let OFFSET = 0;
  const nowMs = () => Date.now() + OFFSET;
  const fmtClock = ts => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

  function timeAgo(ts) {
    const d = nowMs() - ts;
    if (d < 45 * 1000) return 'just now';
    if (d < HOUR) return `${Math.max(1, Math.floor(d / MIN))} min ago`;
    if (d < DAY)  return `${Math.floor(d / HOUR)} h ago`;
    return `${Math.floor(d / DAY)} d ago`;
  }

  function dueLabel(dueAt) {
    const d = dueAt - nowMs();
    const abs = Math.abs(d);
    const dd = Math.floor(abs / DAY), hh = Math.floor((abs % DAY) / HOUR), mm = Math.floor((abs % HOUR) / MIN);
    const core = dd > 0 ? `${dd}d ${pad2(hh)}h` : hh > 0 ? `${hh}h ${pad2(mm)}m` : `${Math.max(mm, 1)}m`;
    return d < 0 ? `Overdue · ${core}` : `${core} left`;
  }

  const initials = name => name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');

  const store = {
    get(k, fb) { try { return localStorage.getItem(k) || fb; } catch (e) { return fb; } },
    set(k, v)  { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  /* ------------------------------ API ------------------------------ */
  async function api(path, payload) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.message) || `Request failed (HTTP ${res.status})`);
    }
    return data;
  }

  /* ------------------------------ state ------------------------------ */
  const BOOT = window.__BOOT__ || { ok: false, error: 'No boot data', state: null };

  const state = {
    books: new BinarySearchTree(),     // catalog index, key = lowercase title
    booksById: new HashTable(31),      // id / isbn → book row
    loans: new HashTable(31),          // loan code → loan
    history: new SinglyLinkedList(),   // ledger mirror, head = newest
    undoStack: new Stack(),            // checkpoint mirror (LIFO)
    toastQueue: new Queue(),           // on-screen toast pipeline (FIFO)
    notifications: [],                 // notification-centre mirror
    unread: 0,
    lastNotifId: 0,
    filter: 'all',
    searchIds: null,
    histFilter: 'all',
    selectedLoanCode: null,
    borrowTarget: null,
    user: store.get('alexandria:user', 'Guest Reader'),
    warnedOver: new Set(),
    warnedDue: new Set(),
    dbOffline: true,
  };
  window.ALEXANDRIA = state;

  const refreshIcons = () => { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); };

  /* ------------------------- hydrate from MySQL ------------------------- */
  function hydrate(data) {
    OFFSET = (data.serverNow || Date.now()) - Date.now();

    state.books = new BinarySearchTree();
    state.booksById = new HashTable(31);
    state.loans = new HashTable(31);
    state.history = new SinglyLinkedList();
    state.undoStack = new Stack();

    (data.books || []).forEach(raw => {
      const book = {
        id: raw.id, isbn: raw.isbn, title: raw.title, author: raw.author,
        genre: raw.genre, year: raw.year, hue: raw.hue, status: raw.status,
        holdFor: raw.holdFor || null, holdUntil: raw.holdUntil || null,
        waitlist: new Queue(),
        loanCode: raw.loan ? raw.loan.code : null,
      };
      (raw.waitlist || []).forEach(p => book.waitlist.enqueue({ name: p.name, at: p.at }));  // QUEUE.build front→rear
      state.books.insert(book.title.toLowerCase(), book);                                     // BST INSERT
      state.booksById.set(book.id, book);                                                     // HASH set
      state.booksById.set(book.isbn, book);
      if (raw.loan) {
        state.loans.set(raw.loan.code, { code: raw.loan.code, bookId: book.id, ...raw.loan });
      }
    });

    /* ledger arrives newest-first → insert tail-to-head so HEAD = newest */
    const hist = data.history || [];
    for (let i = hist.length - 1; i >= 0; i--) state.history.insertAtHead(hist[i]);

    /* undo rows arrive TOP-first → push bottom-to-top so head is the top */
    const undo = data.undoStack || [];
    for (let i = undo.length - 1; i >= 0; i--) state.undoStack.push(undo[i]);

    state.lastNotifId = Math.max(state.lastNotifId, data.lastNotifId || 0);
  }

  async function refresh() {
    try {
      const res = await fetch('api/bootstrap.php', { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || 'Sync failed');
      state.dbOffline = false;
      hydrate(data.state);
      scanDueDates();
      renderAll();
    } catch (e) {
      state.dbOffline = true;
      notify('error', 'Sync failed', e.message + ' — showing last known state.');
    }
  }

  /* ======================================================================
     FEATURE 5 · REAL-TIME NOTIFICATION ALERTS (Toast)
     Feed: api/events.php?since_id=N → rows arrive ordered by id ASC
     (FIFO). Each is push-mirrored to the centre and enqueued onto the
     client toast Queue — first event is always the first toast shown.
     ====================================================================== */
  const TOAST_MAX = 4;
  const TOAST_TTL = 5600;
  let visibleToasts = 0;

  const T_ICON = { success: 'check-circle-2', info: 'info', warning: 'alert-triangle', error: 'x-circle', system: 'terminal' };

  function notify(type, title, msg, dsNote) {
    const n = { type, title, msg, dsNote: dsNote || '', at: nowMs() };
    state.toastQueue.enqueue(n);                  // QUEUE.enqueue — FIFO in
    state.notifications.unshift(n);
    if (state.notifications.length > 40) state.notifications.length = 40;
    state.unread++;
    updateBell();
    renderNotifList();
    pumpToasts();
  }

  function pumpToasts() {
    while (visibleToasts < TOAST_MAX && !state.toastQueue.isEmpty()) {
      showToast(state.toastQueue.dequeue());      // QUEUE.dequeue — FIFO out
    }
  }

  function showToast(n) {
    visibleToasts++;
    const host = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.type = n.type;
    el.innerHTML =
      `<span class="t-ico"><i data-lucide="${T_ICON[n.type] || 'info'}"></i></span>
       <div class="t-body">
         <h5>${esc(n.title)}</h5>
         <p>${esc(n.msg)}</p>
         ${n.dsNote ? `<span class="t-ds">${esc(n.dsNote)}</span>` : ''}
       </div>
       <button class="t-x" aria-label="Dismiss"><i data-lucide="x"></i></button>
       <span class="t-bar"></span>`;
    host.appendChild(el);
    refreshIcons();

    const bar = $('.t-bar', el);
    bar.style.transition = `transform ${TOAST_TTL}ms linear`;
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transform = 'scaleX(0)'; }));

    const kill = () => dismissToast(el);
    el._timer = setTimeout(kill, TOAST_TTL);
    $('.t-x', el).addEventListener('click', () => { clearTimeout(el._timer); dismissToast(el); });
  }

  function dismissToast(el) {
    if (el._gone) return;
    el._gone = true;
    el.classList.add('leaving');
    setTimeout(() => { el.remove(); visibleToasts--; pumpToasts(); }, 300);
  }

  function updateBell() {
    const b = $('#bellBadge');
    if (state.unread > 0) { b.textContent = state.unread > 99 ? '99+' : state.unread; b.classList.remove('hidden'); }
    else b.classList.add('hidden');
  }

  async function pollEvents() {
    try {
      const res = await fetch(`api/events.php?since_id=${state.lastNotifId}`, { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) return;
      (data.notifications || []).forEach(n => notify(n.type, n.title, n.msg, 'api/events.php · FIFO id order'));
      state.lastNotifId = data.lastNotifId ?? state.lastNotifId;
    } catch (e) { /* keep polling */ }
  }

  function renderNotifList() {
    const list = $('#npList');
    $('#npSub').textContent = `FIFO pipeline · ${state.notifications.length} event${state.notifications.length === 1 ? '' : 's'}`;
    if (!state.notifications.length) {
      list.innerHTML = `<div class="np-empty">No notifications yet — the Queue is empty.</div>`;
      return;
    }
    list.innerHTML = state.notifications.map(n =>
      `<div class="np-item" data-type="${n.type}">
         <i data-lucide="${T_ICON[n.type] || 'info'}"></i>
         <div><h6>${esc(n.title)}</h6><p>${esc(n.msg)}</p><time>${timeAgo(n.at)}</time></div>
       </div>`).join('');
    refreshIcons();
  }

  /* ------------------------------ router ------------------------------ */
  const VIEWS = ['catalog', 'loans', 'checkin', 'history', 'docs'];
  const TITLES = {
    catalog: 'Catalog & Availability',
    loans: 'Active Loans & Renewals',
    checkin: 'Check-In Desk',
    history: 'Borrowing History',
    docs: 'System & Data Structure Docs',
  };

  function go(view) {
    if (!VIEWS.includes(view)) return;
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
    $('#viewTitle').textContent = TITLES[view];
    history.replaceState(null, '', `#${view}`);
    renderAll();
  }

  /* ======================================================================
     FEATURE 4 · BOOKS AVAILABILITY MONITORING
     Rows: MySQL books.status · Index: client BST + HashTable
     ====================================================================== */
  const STATUS_LABEL = { available: 'Available', borrowed: 'On Loan', 'on-hold': 'On Hold' };

  const catalogBooks = () => state.books.inOrder();      // BST IN-ORDER TRAVERSAL

  function renderStats() {
    const all = catalogBooks();
    const avail = all.filter(b => b.status === 'available').length;
    const loan  = all.filter(b => b.status === 'borrowed').length;
    const hold  = all.filter(b => b.status === 'on-hold').length;
    const wait  = all.reduce((s, b) => s + b.waitlist.size, 0);
    const stats = [
      { label: 'Titles Indexed', value: state.books.count, sub: `BST height ${state.books.height()}`, tone: '' },
      { label: 'Available Now',  value: avail, sub: 'ready to borrow', tone: 't-green' },
      { label: 'On Loan',        value: loan,  sub: 'with patrons', tone: 't-red' },
      { label: 'On Hold',        value: hold,  sub: 'reserved · 48 h', tone: 't-blue' },
      { label: 'In Queues',      value: wait,  sub: 'patrons waiting', tone: 't-gold' },
    ];
    $('#statsRow').innerHTML = stats.map(s =>
      `<div class="stat ${s.tone}">
         <span class="st-label"><span class="dot"></span>${s.label}</span>
         <div class="st-value" data-countup="${s.value}">0</div>
         <div class="st-sub">${s.sub}</div>
       </div>`).join('');
    $$('#statsRow [data-countup]').forEach(el => countUp(el, +el.dataset.countup));
  }

  function countUp(el, target) {
    const t0 = performance.now(), dur = 650;
    (function step(t) {
      const p = Math.min((t - t0) / dur, 1);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  function renderGrid() {
    const grid = $('#bookGrid');
    let books = catalogBooks();
    if (state.filter !== 'all') books = books.filter(b => b.status === state.filter);
    if (state.searchIds) books = books.filter(b => state.searchIds.has(b.id));

    if (!books.length) {
      grid.innerHTML = `<div class="empty"><i data-lucide="book-x"></i><p>Nothing on this shelf.</p><span>adjust the search or the status filter</span></div>`;
      refreshIcons();
      return;
    }

    grid.innerHTML = books.map((b, i) => {
      const loan = b.loanCode ? state.loans.get(b.loanCode) : null;
      const canBorrow = b.status === 'available' && !state.dbOffline;
      const action = canBorrow
        ? `<button class="btn btn-primary block" data-action="borrow" data-id="${b.id}"><i data-lucide="book-open"></i>Borrow</button>`
        : `<button class="btn btn-ghost block" data-action="wait" data-id="${b.id}"><i data-lucide="list-ordered"></i>Join Waitlist${b.waitlist.size ? ` · ${b.waitlist.size}` : ''}</button>`;
      const queueLine = b.status === 'on-hold' && b.holdFor
        ? `<span class="queue-chip"><i data-lucide="bookmark"></i>held for ${esc(b.holdFor)} · ${b.holdUntil ? dueLabel(b.holdUntil) : '—'}</span>`
        : b.waitlist.size > 0
          ? `<span class="queue-chip"><i data-lucide="list-ordered"></i>queue · ${b.waitlist.size} patron${b.waitlist.size > 1 ? 's' : ''} waiting</span>`
          : '';
      return `
      <article class="book-card" data-book="${b.id}" style="animation-delay:${Math.min(i * 35, 420)}ms">
        <div class="cover" style="background:
             radial-gradient(120% 90% at 15% 0%, hsla(${b.hue},48%,42%,.85), transparent 55%),
             linear-gradient(160deg, hsl(${b.hue},32%,22%), hsl(${b.hue},42%,10%))">
          <span class="cover-genre">${esc(b.genre)}</span>
          <span class="status-ribbon" data-status="${b.status}"><span class="s-dot"></span>${STATUS_LABEL[b.status]}</span>
          <div>
            <h3 class="cover-title">${esc(b.title)}</h3>
            <p class="cover-author">${esc(b.author)}</p>
          </div>
          <span class="cover-year">${b.year}</span>
        </div>
        <div class="card-body">
          <span class="card-isbn"><span>ISBN ${b.isbn}</span><span class="bkt">bkt#${pad2(state.booksById.hash(b.isbn))}</span></span>
          ${queueLine}
          ${loan ? `<span class="queue-chip" style="border-color:rgba(226,96,63,.4);color:var(--red)"><i data-lucide="timer"></i>${esc(loan.borrower)} · ${dueLabel(loan.dueAt)}</span>` : ''}
          <div class="card-actions">${action}</div>
        </div>
      </article>`;
    }).join('');
    refreshIcons();
  }

  /* --------------------------- search (BST client-side) --------------------------- */
  function handleSearchSubmit(ev) {
    ev.preventDefault();
    const q = $('#searchInput').value.trim();
    const meta = $('#searchMeta');
    if (!q) { state.searchIds = null; meta.textContent = ''; renderGrid(); return; }

    const t0 = performance.now();
    const hit = state.books.search(q.toLowerCase());      // BST SEARCH over live rows
    const dt = (performance.now() - t0).toFixed(3);
    const comps = state.books.lastComparisons;

    if (hit) {
      state.searchIds = new Set([hit.id]);
      meta.innerHTML = `BST.search(“${esc(q)}”) → <b>found</b> after <b>${comps}</b> comparison${comps === 1 ? '' : 's'} (height ${state.books.height()}) · ${dt} ms`;
      notify('success', 'Catalog hit', `“${hit.title}” located in ${comps} BST comparisons.`, `BinarySearchTree.search → ${comps} comparisons`);
    } else {
      const close = catalogBooks().filter(b => `${b.title} ${b.author}`.toLowerCase().includes(q.toLowerCase()));
      state.searchIds = close.length ? new Set(close.map(b => b.id)) : new Set();
      meta.innerHTML = `BST.search(“${esc(q)}”) → <b>miss</b> after <b>${comps}</b> comparisons · showing ${close.length} substring match${close.length === 1 ? '' : 'es'}`;
      notify('warning', 'No exact title', `“${q}” is not in the BST. ${close.length || 'No'} partial matches shown.`, `BinarySearchTree.search → miss after ${comps}`);
    }
    renderGrid();
  }

  function handleSearchLive() {
    const q = $('#searchInput').value.trim().toLowerCase();
    if (!q) { state.searchIds = null; $('#searchMeta').textContent = ''; renderGrid(); return; }
    const close = catalogBooks().filter(b => `${b.title} ${b.author} ${b.isbn}`.toLowerCase().includes(q));
    state.searchIds = new Set(close.map(b => b.id));
    renderGrid();
  }

  /* --------------------------- borrow flow (API) --------------------------- */
  function openBorrowModal(book) {
    state.borrowTarget = book;
    $('#modalBook').innerHTML = `
      <div class="modal-book">
        <div class="loan-cover" style="background:linear-gradient(160deg,hsl(${book.hue},34%,26%),hsl(${book.hue},44%,12%))">${esc(book.title[0])}</div>
        <div>
          <h4>${esc(book.title)}</h4>
          <p>${esc(book.author)} · ${book.year}</p>
          <p>ISBN ${book.isbn}</p>
        </div>
      </div>`;
    $('#borrowerName').value = state.user === 'Guest Reader' ? '' : state.user;
    $('#borrowModal').classList.add('open');
    setTimeout(() => $('#borrowerName').focus(), 120);
    refreshIcons();
  }

  function closeBorrowModal() { $('#borrowModal').classList.remove('open'); state.borrowTarget = null; }

  async function confirmBorrow() {
    const book = state.borrowTarget;
    if (!book || book.status !== 'available') { closeBorrowModal(); return; }
    const name = $('#borrowerName').value.trim();
    if (!name) {
      notify('warning', 'Borrower required', 'Type the patron’s full name to check the book out.');
      $('#borrowerName').focus();
      return;
    }
    const days = +($('#periodGroup input:checked') || {}).value || 14;
    const btn = $('#borrowConfirm');
    btn.disabled = true;
    try {
      const d = await api('api/borrow.php', { bookId: book.id, borrower: name, days });   // → sp_borrow_book
      state.user = name; store.set('alexandria:user', name);
      closeBorrowModal();
      notify('success', 'Book checked out', `“${book.title}” is with ${name} until ${fmtDate(d.loan.dueAt)}. Loan ${d.loan.code}.`,
        'api/borrow.php → sp_borrow_book · trigger wrote BORROW node');
      await refresh();
    } catch (e) {
      notify('error', 'Checkout failed', e.message, 'MySQL SIGNAL 45000');
    } finally {
      btn.disabled = false;
    }
  }

  async function joinWaitlist(book) {
    try {
      const d = await api('api/waitlist.php', { bookId: book.id, patron: state.user });     // → sp_join_waitlist
      notify('info', 'Waitlist joined', `You are #${d.position} in line for “${book.title}”. We’ll hold it 48 h when it returns.`,
        `api/waitlist.php → sp_join_waitlist · position ${d.position}`);
      await refresh();
    } catch (e) {
      notify('warning', 'Queue join refused', e.message, 'MySQL SIGNAL 45000');
    }
  }

  /* ======================================================================
     FEATURE 1 · BOOK RENEWAL (API)
     ====================================================================== */
  function activeLoans() {
    return catalogBooks()
      .filter(b => b.status === 'borrowed' && b.loanCode)
      .map(b => ({ book: b, loan: state.loans.get(b.loanCode) }));
  }

  function renewalBlock(book, loan) {
    if (book.waitlist.size > 0) return `${book.waitlist.size} patron${book.waitlist.size > 1 ? 's' : ''} queued — Queue non-empty`;
    if (loan.renewals >= loan.maxRenewals) return 'renewal cap reached (2/2)';
    return null;
  }

  async function doRenew(bookId) {
    const book = state.booksById.get(bookId);               // HASHTABLE get — O(1)
    const loan = book && book.loanCode ? state.loans.get(book.loanCode) : null;
    if (!book || !loan) return;

    /* client hint only — MySQL enforces the same guards in sp_renew_loan */
    const blocked = renewalBlock(book, loan);
    if (blocked) {
      notify('warning', 'Renewal refused', `“${book.title}”: ${blocked}.`, 'guard: waitlist.size === 0 && renewals < 2');
      return;
    }
    try {
      const d = await api('api/renew.php', { code: loan.code });                          // → sp_renew_loan
      state.warnedDue.delete(`${loan.code}:${loan.renewals}`);
      notify('success', 'Loan renewed', `“${book.title}” extended — now due ${fmtDate(d.loan.dueAt)} (${d.loan.renewals}/2 renewals used).`,
        'api/renew.php → sp_renew_loan · +14 days');
      await refresh();
    } catch (e) {
      notify('warning', 'Renewal refused', e.message, 'MySQL SIGNAL 45000 · sp_renew_loan');
    }
  }

  function renderLoans() {
    const rows = activeLoans();
    $('#loanCount').textContent = rows.length;
    const host = $('#loanRows');

    if (!rows.length) {
      host.innerHTML = `<div class="no-loans"><i data-lucide="coffee"></i><p>The desk is clear — nothing is on loan.</p><span>borrowed titles will appear here with renewal controls</span></div>`;
      refreshIcons();
      return;
    }

    host.innerHTML = rows.map(({ book, loan }) => {
      const blocked = renewalBlock(book, loan);
      const pct = Math.max(0, Math.min(100, ((nowMs() - loan.borrowedAt) / (loan.dueAt - loan.borrowedAt)) * 100));
      const late = loan.dueAt < nowMs();
      const cls = late ? 'late' : pct >= 75 ? 'warn' : '';
      return `
      <div class="loan-row">
        <div class="loan-cover" style="background:linear-gradient(160deg,hsl(${book.hue},34%,26%),hsl(${book.hue},44%,12%))">${esc(book.title[0])}</div>
        <div class="loan-book">
          <h4>${esc(book.title)}</h4>
          <p>${esc(book.author)} · ISBN ${book.isbn} · ${loan.code}</p>
        </div>
        <div class="who"><span class="avatar">${initials(loan.borrower)}</span><div><b>${esc(loan.borrower)}</b><span>since ${fmtDate(loan.borrowedAt)}</span></div></div>
        <div class="due-cell">
          <span class="countdown ${late ? 'overdue' : pct >= 75 ? 'soon' : ''}" data-count data-due="${loan.dueAt}">${dueLabel(loan.dueAt)}</span>
          <small>due ${fmtDate(loan.dueAt)}</small>
          <div class="prog prog-wrap"><i class="${cls}" style="width:${pct.toFixed(1)}%"></i></div>
        </div>
        <div class="renew-note">${loan.renewals}/${loan.maxRenewals} renewals</div>
        <div class="loan-actions">
          <button class="btn ${blocked ? 'btn-ghost' : 'btn-primary'}" data-renew="${book.id}" ${blocked ? 'disabled' : ''} title="${blocked ? esc(blocked) : '+14 days'}">
            <i data-lucide="rotate-ccw"></i>Renew +14d
          </button>
          <button class="btn btn-ghost" data-gocheckin="${book.id}"><i data-lucide="log-in"></i>Check In</button>
          ${blocked ? `<span class="renew-note">${esc(blocked)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
    refreshIcons();
  }

  /* ======================================================================
     FEATURE 3 · BOOK CHECK-IN (API)
     ====================================================================== */
  function renderCheckin() {
    const rows = activeLoans();
    const sel = $('#loanSelect');

    const stillThere = rows.some(r => r.loan.code === state.selectedLoanCode);
    if (!stillThere) state.selectedLoanCode = null;

    sel.innerHTML = rows.length
      ? `<option value="">— choose a loan —</option>` + rows.map(({ book, loan }) =>
          `<option value="${loan.code}" ${state.selectedLoanCode === loan.code ? 'selected' : ''}>${esc(loan.borrower)} — “${esc(book.title)}” · ${loan.code} · due ${fmtDate(loan.dueAt)}</option>`).join('')
      : `<option value="">— no active loans —</option>`;

    renderTicket();
    renderStackView();
    renderQueueView();
    refreshIcons();
  }

  function selectedPair() {
    if (!state.selectedLoanCode) return null;
    const loan = state.loans.get(state.selectedLoanCode);
    if (!loan) return null;
    const book = state.booksById.get(loan.bookId);
    return book && book.status === 'borrowed' ? { book, loan } : null;
  }

  function renderTicket() {
    const host = $('#ticket');
    const pair = selectedPair();
    $('#checkinBtn').disabled = !pair;
    if (!pair) {
      host.innerHTML = `<div class="ticket-empty">Scan an ISBN / title or pick a loan —<br/>a return ticket will print here.</div>`;
      return;
    }
    const { book, loan } = pair;
    const lateDays = Math.max(0, Math.floor((nowMs() - loan.dueAt) / DAY));
    const fee = (lateDays * 0.5).toFixed(2);
    host.innerHTML = `
      <div class="ticket-inner">
        <div class="tk-head">Return Ticket</div>
        <div class="tk-row"><span>Loan</span><b>${loan.code}</b></div>
        <div class="tk-row"><span>Title</span><b>${esc(book.title)}</b></div>
        <div class="tk-row"><span>Borrower</span><b>${esc(loan.borrower)}</b></div>
        <div class="tk-row"><span>Due back</span><b class="${loan.dueAt < nowMs() ? 'bad' : 'good'}">${fmtDate(loan.dueAt)}</b></div>
        <div class="tk-row"><span>Status</span><b class="${loan.dueAt < nowMs() ? 'bad' : 'good'}">${dueLabel(loan.dueAt)}</b></div>
        ${lateDays ? `<div class="tk-row"><span>Late fee</span><b class="bad">${fee} (${lateDays} d × 0.50)</b></div>` : ''}
        <div class="tk-row"><span>Waitlist</span><b>${book.waitlist.size ? `${book.waitlist.size} queued → next: ${esc(book.waitlist.peek().name)}` : 'empty'}</b></div>
        <div class="barcode"></div>
        <div class="tk-isbn">${book.isbn}</div>
      </div>`;
  }

  async function doCheckIn() {
    const pair = selectedPair();
    if (!pair) return;
    const btn = $('#checkinBtn');
    btn.disabled = true;
    try {
      const d = await api('api/checkin.php', { code: pair.loan.code });                     // → sp_checkin_book
      const r = d.result;
      state.selectedLoanCode = null;
      notify('success', 'Check-in complete',
        `“${r.title}” — ${r.newStatus === 'on-hold' ? `reserved for ${r.servedPatron} (48-h hold)` : 'back on the shelf'}.`,
        'api/checkin.php → sp_checkin_book · Stack.push + Queue.dequeue');
      await refresh();
    } catch (e) {
      notify('error', 'Check-in failed', e.message, 'MySQL SIGNAL 45000');
      btn.disabled = false;
    }
  }

  async function doUndo() {
    const btn = $('#undoBtn');
    btn.disabled = true;
    try {
      const d = await api('api/undo.php', {});                                              // → sp_undo_checkin
      const r = d.result;
      const book = state.booksById.get(r.bookId);
      notify('info', 'Undo applied',
        `“${book ? book.title : r.bookId}” is back on loan.${r.restoredPatron ? ` ${r.restoredPatron} restored to queue front.` : ''}`,
        'api/undo.php → sp_undo_checkin · Stack.pop (LIFO)');
      await refresh();
    } catch (e) {
      notify('warning', 'Undo refused', e.message, 'MySQL SIGNAL 45000');
      btn.disabled = false;
    }
  }

  function renderStackView() {
    const host = $('#stackView');
    const items = state.undoStack.toArray();                // top → bottom (mirror of v_undo_stack)
    $('#stackDepth').textContent = state.undoStack.size;
    $('#undoBtn').disabled = items.length === 0;
    if (!items.length) {
      host.innerHTML = `<div class="view-empty">stack empty — check-ins will stack up here</div>`;
      return;
    }
    host.innerHTML = items.slice(0, 5).map((cp, i) =>
      `<div class="stack-item">
        <span class="idx ${i === 0 ? 'top' : ''}">${i === 0 ? 'TOP' : `#${i + 1}`}</span>
        <p>check-in · “${esc(cp.title)}” · ${cp.loanCode}</p>
        <time>${timeAgo(cp.at)}</time>
      </div>`).join('');
  }

  function renderQueueView() {
    const host = $('#queueView');
    const queued = catalogBooks().filter(b => b.waitlist.size > 0 || (b.status === 'on-hold' && b.holdFor));
    if (!queued.length) {
      host.innerHTML = `<div class="view-empty">all queues empty — no title is being waited on</div>`;
      return;
    }
    host.innerHTML = queued.map(b => {
      const people = b.waitlist.toArray().map((p, i) =>
        `<span class="q-person ${i === 0 ? 'next' : ''}">${i === 0 ? 'next · ' : `#${i + 1} · `}${esc(p.name)}</span>`).join('<span class="q-arrow">→</span>');
      const hold = b.status === 'on-hold' && b.holdFor
        ? `<span class="q-person next">holding · ${esc(b.holdFor)}</span><span class="q-arrow">→</span>` : '';
      return `<div class="queue-item"><span class="q-title">${esc(b.title)}</span><span class="q-people">${hold}${people || '<span class="q-person">queue empty</span>'}</span></div>`;
    }).join('');
  }

  /* scan/locate stays client-side: HashTable + BST over live rows */
  function locateReturn() {
    const raw = $('#scanInput').value.trim();
    if (!raw) { notify('warning', 'Scanner idle', 'Type an ISBN or an exact title first.'); return; }

    let book = state.booksById.get(raw);                    // HASHTABLE (isbn/id) — O(1)
    let via = book ? 'HashTable' : null;
    if (!book) { book = state.books.search(raw.toLowerCase()); via = book ? 'BinarySearchTree' : null; }
    if (!book) {
      const q = raw.toLowerCase();
      book = catalogBooks().find(b => b.title.toLowerCase().includes(q));
      via = book ? 'substring scan' : null;
    }

    if (!book) { notify('error', 'No catalog record', `“${raw}” matched no ISBN or title.`, 'HashTable miss · BST miss'); return; }
    if (book.status !== 'borrowed' || !book.loanCode) {
      notify('warning', 'Not on loan', `“${book.title}” is ${STATUS_LABEL[book.status].toLowerCase()} — nothing to check in.`);
      return;
    }
    state.selectedLoanCode = book.loanCode;
    $('#loanSelect').value = book.loanCode;
    renderTicket(); renderStackView(); renderQueueView(); refreshIcons();
    notify('info', 'Loan located', `“${book.title}” found via ${via}. Ticket ready.`,
      via === 'HashTable' ? 'lookup O(1)' : `BST · ${state.books.lastComparisons} comparisons`);
  }

  /* ======================================================================
     FEATURE 2 · BOOK BORROWING HISTORY (from history_events, written by triggers)
     ====================================================================== */
  const H_ICON = { BORROW: 'book-open', RENEW: 'rotate-ccw', RETURN: 'log-in', HOLD: 'list-ordered', SYSTEM: 'terminal', UNDO: 'undo-2' };

  function renderHistory() {
    $('#histCount').textContent = `size = ${state.history.size}`;
    const rows = state.history.toArray()
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => state.histFilter === 'all' || d.type === state.histFilter);

    const host = $('#historyList');
    if (!rows.length) {
      host.innerHTML = `<div class="view-empty">no ledger nodes match this filter</div>`;
      return;
    }
    host.innerHTML = rows.map(({ d, i }, k) =>
      `<div class="hist-row" data-type="${d.type}" style="animation-delay:${Math.min(k * 30, 360)}ms">
         <span class="h-ico"><i data-lucide="${H_ICON[d.type] || 'dot'}"></i></span>
         <div>
           <p class="h-msg">${esc(d.msg)}</p>
           ${d.sub ? `<p class="h-sub">${esc(d.sub)}</p>` : ''}
         </div>
         <div class="h-meta"><span class="h-time">${timeAgo(d.at)}</span><br/><span class="h-node">node[${i}] ${i === 0 ? '· head' : ''}</span></div>
       </div>`).join('');
    refreshIcons();
  }

  /* --------------------------- docs live metrics --------------------------- */
  function renderDocsMetrics() {
    const totalWaiters = catalogBooks().reduce((s, b) => s + b.waitlist.size, 0);
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#m-bst',   `nodes ${state.books.count} · height ${state.books.height()}`);
    set('#m-hash',  `${state.booksById.entries} entries / ${state.booksById.bucketCount} buckets · ${state.booksById.collisions()} collisions`);
    set('#m-list',  `${state.history.size} nodes · head = newest`);
    set('#m-stack', `depth ${state.undoStack.size} · top ${state.undoStack.peek() ? timeAgo(state.undoStack.peek().at) : '—'}`);
    set('#m-queue', `${totalWaiters} patron${totalWaiters === 1 ? '' : 's'} queued · toasts FIFO`);
  }

  /* --------------------------- master render --------------------------- */
  function renderAll() {
    renderStats();
    renderGrid();
    renderLoans();
    renderCheckin();
    renderHistory();
    renderDocsMetrics();
    refreshIcons();
  }

  /* ======================================================================
     REAL-TIME ENGINE — clock, countdowns, due scanner (over live DB rows)
     ====================================================================== */
  function scanDueDates() {
    const now = nowMs();
    activeLoans().forEach(({ book, loan }) => {
      const dueKey = `${loan.code}:${loan.renewals}`, overKey = `over:${dueKey}`;
      if (loan.dueAt < now && !state.warnedOver.has(overKey)) {
        state.warnedOver.add(overKey);
        notify('error', 'Overdue loan', `“${book.title}” — ${loan.borrower} is ${dueLabel(loan.dueAt).replace('Overdue · ', '')} past due. Late fee accruing.`, 'due scanner · live DB times');
      } else if (loan.dueAt > now && loan.dueAt - now < 2 * HOUR && !state.warnedDue.has(dueKey)) {
        state.warnedDue.add(dueKey);
        notify('warning', 'Due soon', `“${book.title}” is due in ${dueLabel(loan.dueAt)}. Consider a renewal.`, 'due scanner · live DB times');
      }
    });
  }

  function tick() {
    $('#clockTime').textContent = fmtClock(nowMs());
    $$('[data-count]').forEach(el => {
      const due = +el.dataset.due;
      el.textContent = dueLabel(due);
      el.classList.toggle('overdue', due < nowMs());
      el.classList.toggle('soon', due >= nowMs() && due - nowMs() < 2 * HOUR);
    });
  }

  /* ------------------------------ wiring ------------------------------ */
  function wire() {
    $$('.nav-item').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
    document.addEventListener('keydown', e => {
      if (e.target.matches('input, textarea, select')) return;
      const idx = ['1', '2', '3', '4', '5'].indexOf(e.key);
      if (idx > -1) go(VIEWS[idx]);
      if (e.key === 'Escape') { closeBorrowModal(); closePanel(); }
    });

    $('#searchForm').addEventListener('submit', handleSearchSubmit);
    $('#searchInput').addEventListener('input', handleSearchLive);
    $('#filterChips').addEventListener('click', e => {
      const chip = e.target.closest('[data-filter]');
      if (!chip) return;
      state.filter = chip.dataset.filter;
      $$('#filterChips .chip').forEach(c => c.classList.toggle('active', c === chip));
      renderGrid();
    });
    $('#bookGrid').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const book = state.booksById.get(btn.dataset.id);
      if (!book) return;
      if (btn.dataset.action === 'borrow') openBorrowModal(book);
      else joinWaitlist(book);
    });

    $('#loanRows').addEventListener('click', e => {
      const renew = e.target.closest('[data-renew]');
      if (renew && !renew.disabled) { doRenew(renew.dataset.renew); return; }
      const gc = e.target.closest('[data-gocheckin]');
      if (gc) {
        const book = state.booksById.get(gc.dataset.gocheckin);
        state.selectedLoanCode = book && book.loanCode ? book.loanCode : null;
        go('checkin');
      }
    });

    $('#scanBtn').addEventListener('click', locateReturn);
    $('#scanInput').addEventListener('keydown', e => { if (e.key === 'Enter') locateReturn(); });
    $('#loanSelect').addEventListener('change', e => {
      state.selectedLoanCode = e.target.value || null;
      renderTicket(); refreshIcons();
    });
    $('#checkinBtn').addEventListener('click', doCheckIn);
    $('#undoBtn').addEventListener('click', doUndo);

    $('#histChips').addEventListener('click', e => {
      const chip = e.target.closest('[data-hfilter]');
      if (!chip) return;
      state.histFilter = chip.dataset.hfilter;
      $$('#histChips .chip').forEach(c => c.classList.toggle('active', c === chip));
      renderHistory();
    });

    $('#bellBtn').addEventListener('click', openPanel);
    $('#npClose').addEventListener('click', closePanel);
    $('#notifOverlay').addEventListener('click', closePanel);
    $('#npClear').addEventListener('click', () => {
      state.notifications.length = 0;
      renderNotifList();
      notify('system', 'Centre cleared', 'Notification archive emptied. Live toasts are unaffected.');
    });

    $('#modalClose').addEventListener('click', closeBorrowModal);
    $('#borrowCancel').addEventListener('click', closeBorrowModal);
    $('#borrowConfirm').addEventListener('click', confirmBorrow);
    $('#borrowModal').addEventListener('click', e => { if (e.target.id === 'borrowModal') closeBorrowModal(); });
    $('#borrowerName').addEventListener('keydown', e => { if (e.key === 'Enter') confirmBorrow(); });
  }

  function openPanel() {
    $('#notifPanel').classList.add('open');
    $('#notifOverlay').classList.add('open');
    state.unread = 0;
    updateBell();
    renderNotifList();
  }
  function closePanel() {
    $('#notifPanel').classList.remove('open');
    $('#notifOverlay').classList.remove('open');
  }

  function showDbOfflineBanner() {
    const banner = document.createElement('div');
    banner.className = 'db-offline';
    banner.innerHTML = `<b>MySQL offline</b> — could not reach the database (${esc(BOOT.error || 'connection failed')}).
      Check <em>config.php</em> credentials and that MySQL is running, then reload.`;
    document.querySelector('.main').prepend(banner);
  }

  /* ------------------------------ boot ------------------------------ */
  wire();

  if (BOOT.ok && BOOT.state) {
    state.dbOffline = false;
    hydrate(BOOT.state);
    const startView = location.hash.replace('#', '');
    go(VIEWS.includes(startView) ? startView : 'catalog');
    scanDueDates();

    setTimeout(() => notify('system', 'Alexandria online',
      `Connected to MySQL — ${state.books.count} titles hydrated (BST height ${state.books.height()}, ${state.booksById.entries} hash records), ledger of ${state.history.size} nodes.`,
      'state from index.php ⇢ api/bootstrap.php'), 900);
    setTimeout(() => notify('info', 'Tip for the demo',
      'Press keys 1–5 to jump between modules. Open this system in two browsers and watch the FIFO toast feed propagate events.'), 2600);

    pollEvents();
    setInterval(pollEvents, 12000);                       // real-time feed
  } else {
    showDbOfflineBanner();
    go('catalog');
    notify('error', 'Database offline', 'MySQL connection failed — see the banner for how to fix it.');
  }

  setInterval(tick, 1000);
  tick();
})();

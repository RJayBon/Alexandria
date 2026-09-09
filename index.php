<?php
/* ==========================================================================
   ALEXANDRIA · index.php — Library Book Borrowing System (PHP + MySQL)
   The page embeds the live database state once at render time; every later
   action goes through the PHP API (api/*.php) and re-syncs via bootstrap.
   ========================================================================== */
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/api/db.php';

$dbError = null;
$bootState = null;
try {
    $bootState = build_state(get_pdo());
} catch (Throwable $e) {
    $dbError = $e->getMessage();
}
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Alexandria — Library Book Borrowing System · PHP + MySQL</title>
<meta name="description" content="Alexandria — a full-stack Library Book Borrowing System (PHP, MySQL) demonstrating Stack, Queue, Linked List, Binary Search Tree and Hash Table." />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230d0b08'/%3E%3Ctext x='32' y='46' font-family='Georgia,serif' font-size='40' fill='%23e8b84b' text-anchor='middle'%3EA%3C/text%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="css/style.css" />
<script defer src="https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js"></script>
</head>
<body>
<noscript><p style="padding:2rem;font-family:serif;color:#f2e9dc">Alexandria requires JavaScript for its data-structure instrumentation.</p></noscript>
<div class="grain" aria-hidden="true"></div>

<!-- ======================= SIDEBAR ======================= -->
<aside class="sidebar">
  <div class="brand">
    <div class="brand-mark">A</div>
    <div class="brand-text">
      <h1>Alexandria</h1>
      <p>Library Book Borrowing System</p>
    </div>
  </div>

  <nav class="nav" id="nav">
    <span class="nav-label">Circulation Desk</span>
    <button class="nav-item active" data-view="catalog"><i data-lucide="library"></i><span>Catalog &amp; Availability</span><kbd>1</kbd></button>
    <button class="nav-item" data-view="loans"><i data-lucide="timer"></i><span>Active Loans &amp; Renewals</span><kbd>2</kbd></button>
    <button class="nav-item" data-view="checkin"><i data-lucide="log-in"></i><span>Check-In Desk</span><kbd>3</kbd></button>
    <button class="nav-item" data-view="history"><i data-lucide="history"></i><span>Borrowing History</span><kbd>4</kbd></button>
    <button class="nav-item" data-view="docs"><i data-lucide="braces"></i><span>System &amp; DS Docs</span><kbd>5</kbd></button>
  </nav>

  <div class="sidebar-foot">
    <div class="ds-chips" title="Data structures implemented from scratch">
      <span>BST</span><span>HASH</span><span>LIST</span><span>STACK</span><span>QUEUE</span>
    </div>
    <a class="dl-btn" href="../library-system.zip" download="alexandria-library-system.zip">
      <i data-lucide="file-down"></i>
      <span>Download Source (.zip)</span>
    </a>
    <p class="foot-note">PHP + MySQL build · v3.0.0</p>
  </div>
</aside>

<!-- ======================= MAIN ======================= -->
<main class="main">
  <header class="topbar">
    <div class="crumb">
      <span class="crumb-root">Alexandria</span>
      <span class="crumb-sep">/</span>
      <span id="viewTitle">Catalog &amp; Availability</span>
    </div>
    <div class="top-right">
      <?php if ($bootState !== null): ?>
        <span class="db-chip ok"><span class="db-dot"></span>MySQL · connected</span>
      <?php else: ?>
        <span class="db-chip bad"><span class="db-dot"></span>MySQL · offline</span>
      <?php endif; ?>
      <div class="clock" title="Local time"><i data-lucide="clock"></i><span id="clockTime">--:--:--</span></div>
      <button class="bell" id="bellBtn" title="Notification center">
        <i data-lucide="bell"></i>
        <span class="badge hidden" id="bellBadge">0</span>
      </button>
    </div>
  </header>

  <!-- ----- VIEW 1 · CATALOG & AVAILABILITY (BST + HashTable) ----- -->
  <section class="view active" id="view-catalog" data-title="Catalog &amp; Availability">
    <p class="view-caption">AVAILABILITY MONITORING — BINARY SEARCH TREE (titles, in-order traversal = alphabetical) · HASHTABLE (ISBN → O(1) lookup) · data hydrated from MySQL</p>

    <div class="stats" id="statsRow"></div>

    <div class="controls">
      <form class="search" id="searchForm" autocomplete="off">
        <i data-lucide="search"></i>
        <input id="searchInput" type="text" spellcheck="false"
               placeholder='Exact title search → BinarySearchTree.search( ) — try "Dune" or "Clean Code"' />
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <div class="chips" id="filterChips">
        <button class="chip active" data-filter="all">All</button>
        <button class="chip" data-filter="available">Available</button>
        <button class="chip" data-filter="borrowed">On&nbsp;Loan</button>
        <button class="chip" data-filter="on-hold">On&nbsp;Hold</button>
      </div>
    </div>
    <p class="search-meta" id="searchMeta"></p>

    <div class="book-grid" id="bookGrid"></div>
  </section>

  <!-- ----- VIEW 2 · ACTIVE LOANS & RENEWAL ----- -->
  <section class="view" id="view-loans" data-title="Active Loans &amp; Renewals">
    <p class="view-caption">BOOK RENEWAL — api/renew.php → sp_renew_loan · MySQL refuses while the book's waitlist QUEUE is non-empty</p>
    <div class="loans-head">
      <h2 class="sec-title">Active Loans <span class="count-pill" id="loanCount">0</span></h2>
      <p class="sec-note">A loan may be renewed twice (+14 days each). Renewal is <em>refused</em> by the database when another patron is queued for the same title — fairness enforced by the waitlist Queue.</p>
    </div>
    <div class="loan-rows" id="loanRows"></div>
  </section>

  <!-- ----- VIEW 3 · CHECK-IN DESK (Stack + Queue) ----- -->
  <section class="view" id="view-checkin" data-title="Check-In Desk">
    <p class="view-caption">BOOK CHECK-IN — api/checkin.php → sp_checkin_book · STACK (LIFO undo checkpoints) · QUEUE (FIFO waitlist allocation)</p>
    <div class="checkin-grid">

      <div class="card">
        <h3 class="card-title"><i data-lucide="scan-line"></i>Locate the Return</h3>
        <label class="fld-label" for="scanInput">ISBN or exact title</label>
        <div class="scanrow">
          <input id="scanInput" type="text" spellcheck="false" placeholder='e.g. 9780262033848 or "Dune"' />
          <button class="btn btn-ghost" id="scanBtn" type="button">Locate</button>
        </div>
        <label class="fld-label" for="loanSelect">…or pick an active loan</label>
        <select id="loanSelect"></select>

        <div class="ticket" id="ticket"></div>

        <div class="row-actions">
          <button class="btn btn-primary" id="checkinBtn" disabled><i data-lucide="log-in"></i>Check In Book</button>
          <button class="btn btn-ghost" id="undoBtn"><i data-lucide="undo-2"></i>Undo <span class="mini-badge" id="stackDepth">0</span></button>
        </div>
        <p class="micro-note">Check-in pushes a checkpoint onto the Undo Stack (table <em>checkin_checkpoints</em>). Undo pops it — <em>LIFO</em>, last check-in restores first.</p>
      </div>

      <div class="card">
        <h3 class="card-title"><i data-lucide="layers"></i>Undo Stack — LIFO</h3>
        <p class="micro-note">Top of the stack is undone first. Live from MySQL view <em>v_undo_stack</em>.</p>
        <div class="stack-view" id="stackView"></div>

        <h3 class="card-title spaced"><i data-lucide="list-ordered"></i>Waitlist Queues — FIFO</h3>
        <p class="micro-note">When a checked-in book is waited for, <em>sp_checkin_book</em> dequeues the front patron into a 48-hour hold.</p>
        <div class="queue-view" id="queueView"></div>
      </div>

    </div>
  </section>

  <!-- ----- VIEW 4 · HISTORY (Singly Linked List) ----- -->
  <section class="view" id="view-history" data-title="Borrowing History">
    <p class="view-caption">BORROWING HISTORY — SINGLY LINKED LIST · insertAtHead( ) O(1) · written by MySQL triggers on table <em>history_events</em></p>
    <div class="loans-head">
      <h2 class="sec-title">Transaction Ledger <span class="count-pill" id="histCount">size = 0</span></h2>
      <div class="chips" id="histChips">
        <button class="chip active" data-hfilter="all">All</button>
        <button class="chip" data-hfilter="BORROW">Borrows</button>
        <button class="chip" data-hfilter="RENEW">Renewals</button>
        <button class="chip" data-hfilter="RETURN">Returns</button>
        <button class="chip" data-hfilter="HOLD">Holds</button>
        <button class="chip" data-hfilter="UNDO">Undos</button>
        <button class="chip" data-hfilter="SYSTEM">System</button>
      </div>
    </div>
    <div class="timeline" id="historyList"></div>
  </section>

  <!-- ----- VIEW 5 · DOCS ----- -->
  <section class="view" id="view-docs" data-title="System &amp; Data Structure Docs">
    <p class="view-caption">DOCUMENTATION — FOR THE DSA REVIEW · full stack: MySQL behind every screen</p>

    <div class="docs-grid">

      <article class="doc-hero card">
        <h2 class="doc-h2">Purpose of the System</h2>
        <p>Alexandria digitises the circulation desk of a lending library. It answers four questions instantly: <em>what is on the shelf, who has it, when is it due back,</em> and <em>who is next in line</em>.</p>
        <p>It solves the classic front-desk problems: slow manual availability checks, lost borrowing records, unfair "first-come" disputes on popular titles, and error-prone returns with no way to recover from mistakes — each problem mapped to a data structure, persisted in MySQL.</p>
      </article>

      <article class="doc-hero card">
        <h2 class="doc-h2">Main Functionalities</h2>
        <ul class="feat-list">
          <li><i data-lucide="library"></i><div><b>Books Availability Monitoring</b><span>Live shelf status from <code>books.status</code> + BST exact-title search.</span></div></li>
          <li><i data-lucide="history"></i><div><b>Book Borrowing History</b><span>Ledger written by triggers into <code>history_events</code>, newest first.</span></div></li>
          <li><i data-lucide="log-in"></i><div><b>Book Check-In</b><span><code>sp_checkin_book</code> — waitlist hand-off + reversible mistakes.</span></div></li>
          <li><i data-lucide="rotate-ccw"></i><div><b>Book Renewal</b><span><code>sp_renew_loan</code> — +14 days, capped, queue-aware.</span></div></li>
          <li><i data-lucide="bell"></i><div><b>Real-Time Notification Alerts</b><span><code>api/events.php</code> polled FIFO from <code>notifications</code>.</span></div></li>
        </ul>
      </article>

      <article class="card ds-card">
        <header><i data-lucide="share-2"></i><h3>Binary Search Tree</h3><span class="ds-metric" id="m-bst">—</span></header>
        <p class="ds-where">Client-side index over the <code>books</code> table, key = title. In-order traversal renders the shelf alphabetically.</p>
        <p class="ds-how">Searching "Dune" walks left/right by comparison — O(log n) — and reports its comparison count in the search bar.</p>
        <table class="ds-table"><tr><td>search</td><td>O(log n)</td></tr><tr><td>insert</td><td>O(log n)</td></tr><tr><td>in-order</td><td>O(n)</td></tr></table>
        <pre class="ds-code">search(key):
  node = root
  while node ≠ null:
    if key == node.key → return node.value
    key &lt; node.key ? node = node.left : node = node.right</pre>
      </article>

      <article class="card ds-card">
        <header><i data-lucide="hash"></i><h3>Hash Table</h3><span class="ds-metric" id="m-hash">—</span></header>
        <p class="ds-where">Client-side O(1) index: <code>id</code> / <code>isbn</code> → book, loan code → loan. Server-side, MySQL's UNIQUE indexes on <code>isbn</code> do the same job.</p>
        <p class="ds-how">djb2 string hash → 31 buckets with chaining. Every badge and the Check-In "Locate" box read from here in O(1).</p>
        <table class="ds-table"><tr><td>get / set</td><td>O(1) avg</td></tr><tr><td>worst case</td><td>O(n) chain</td></tr><tr><td>space</td><td>O(n)</td></tr></table>
        <pre class="ds-code">hash(key):              // djb2
  h = 5381
  for char in key: h = h*33 + char
  return h mod 31       // bucket index</pre>
      </article>

      <article class="card ds-card">
        <header><i data-lucide="list"></i><h3>Singly Linked List</h3><span class="ds-metric" id="m-list">—</span></header>
        <p class="ds-where">The ledger. Persisted in <code>history_events</code> by triggers; hydrated newest-first so <code>insertAtHead( )</code> keeps the head at the newest node.</p>
        <p class="ds-how">No sorting pass ever runs — chronological order falls out of the structure and the table's <code>ORDER BY created_at DESC</code>.</p>
        <table class="ds-table"><tr><td>insertAtHead</td><td>O(1)</td></tr><tr><td>traverse</td><td>O(n)</td></tr><tr><td>head access</td><td>O(1)</td></tr></table>
        <pre class="ds-code">insertAtHead(data):
  node.next = head
  head      = node      // newest first, O(1)</pre>
      </article>

      <article class="card ds-card">
        <header><i data-lucide="layers"></i><h3>Stack</h3><span class="ds-metric" id="m-stack">—</span></header>
        <p class="ds-where">Check-In undo. Backed by <code>checkin_checkpoints</code> — highest id = top. <code>sp_checkin_book</code> pushes; <code>sp_undo_checkin</code> pops.</p>
        <p class="ds-how">Undo restores the loan and re-queues the dequeued patron at the FRONT — LIFO mirrors how mistakes actually happen.</p>
        <table class="ds-table"><tr><td>push / pop</td><td>O(1)</td></tr><tr><td>peek</td><td>O(1)</td></tr></table>
        <pre class="ds-code">push(state)             // sp_checkin_book
undo():                 // sp_undo_checkin
  s = pop()               // ORDER BY id DESC LIMIT 1
  restoreLoan(s); restoreBook(s)
  if s.served → queue.enqueueFront(s.served)</pre>
      </article>

      <article class="card ds-card">
        <header><i data-lucide="list-ordered"></i><h3>Queue</h3><span class="ds-metric" id="m-queue">—</span></header>
        <p class="ds-where">Two flows: per-book waitlists (table <code>waitlist.position</code>) and the toast pipeline (<code>notifications.id</code> ASC via <code>api/events.php</code>).</p>
        <p class="ds-how">Patrons enqueue at the rear; check-in dequeues the front into a 48-h hold. Toasts arrive strictly in id order — the first alert is the first you see.</p>
        <table class="ds-table"><tr><td>enqueue / dequeue</td><td>O(1)</td></tr><tr><td>front peek</td><td>O(1)</td></tr></table>
        <pre class="ds-code">onCheckIn(book):        // sp_checkin_book
  next = book.waitlist.dequeue()
  if next → book.hold = next (48 h)
  else    → book.status = "available"</pre>
      </article>

      <article class="card backend-card">
        <h2 class="doc-h2">Full-Stack Architecture</h2>
        <p>The system is live on <b>PHP + MySQL</b>: <code>index.php</code> renders the shell with the state embedded, and six JSON endpoints drive every action through stored procedures — no hardcoded data anywhere.</p>
        <ul class="hook-list">
          <li><code>api/bootstrap.php</code> → full state (books, loans, queues, ledger, undo stack) — re-fetched after each action.</li>
          <li><code>api/borrow.php</code> → <code>sp_borrow_book</code> · <code>api/renew.php</code> → <code>sp_renew_loan</code> · <code>api/checkin.php</code> → <code>sp_checkin_book</code> · <code>api/undo.php</code> → <code>sp_undo_checkin</code> · <code>api/waitlist.php</code> → <code>sp_join_waitlist</code>.</li>
          <li><code>api/events.php?since_id=N</code> → FIFO toast feed from the <code>notifications</code> table (polled every 12 s — open two browsers to watch events propagate).</li>
          <li>Deploy: import <code>database.sql</code> → edit <code>config.php</code> → drop this folder in Apache's <code>htdocs</code>.</li>
        </ul>
        <a class="btn btn-primary wide" href="../library-system.zip" download="alexandria-library-system.zip"><i data-lucide="file-down"></i>Download full source (.zip)</a>
      </article>

    </div>
  </section>
</main>

<!-- ======================= TOASTS (Queue, FIFO) ======================= -->
<div id="toasts" aria-live="polite"></div>

<!-- ======================= NOTIFICATION CENTER ======================= -->
<div class="overlay" id="notifOverlay"></div>
<aside class="notif-panel" id="notifPanel" aria-label="Notification center">
  <div class="np-head">
    <h3>Notification Center</h3>
    <span class="np-sub" id="npSub">FIFO · newest shown first</span>
    <div class="np-actions">
      <button class="btn btn-ghost sm" id="npClear">Clear all</button>
      <button class="icon-x" id="npClose" aria-label="Close"><i data-lucide="x"></i></button>
    </div>
  </div>
  <div class="np-list" id="npList"></div>
</aside>

<!-- ======================= BORROW MODAL ======================= -->
<div class="modal-backdrop" id="borrowModal" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Check out book">
    <div class="modal-head">
      <h3>Check Out Book</h3>
      <button class="icon-x" id="modalClose" aria-label="Close"><i data-lucide="x"></i></button>
    </div>
    <div id="modalBook"></div>
    <label class="fld-label" for="borrowerName">Borrower name</label>
    <input id="borrowerName" type="text" spellcheck="false" placeholder="Full name" />
    <label class="fld-label">Loan period</label>
    <div class="period" id="periodGroup">
      <label><input type="radio" name="period" value="7" /><span>7 days</span></label>
      <label><input type="radio" name="period" value="14" checked /><span>14 days</span></label>
      <label><input type="radio" name="period" value="21" /><span>21 days</span></label>
    </div>
    <div class="row-actions">
      <button class="btn btn-primary" id="borrowConfirm"><i data-lucide="book-open"></i>Confirm Borrow</button>
      <button class="btn btn-ghost" id="borrowCancel">Cancel</button>
    </div>
    <p class="micro-note">POSTs to <em>api/borrow.php</em> → MySQL procedure <em>sp_borrow_book</em> creates the loan and the trigger writes the ledger node.</p>
  </div>
</div>

<script>
  window.__BOOT__ = <?php echo json_encode(
      ['ok' => $bootState !== null, 'error' => $dbError, 'state' => $bootState],
      JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP
  ); ?>;
</script>
<script src="js/data-structures.js"></script>
<script src="js/app.js"></script>
</body>
</html>

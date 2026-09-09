# Alexandria — Library Book Borrowing System (PHP + MySQL)

Full-stack library circulation system. **PHP** serves the app and a JSON API,
**MySQL** stores everything and enforces the business rules via stored
procedures, and the front-end hydrates five hand-written data structures
(BST, Hash Table, Linked List, Stack, Queue) from live database rows.

No hardcoded data anywhere — delete a book row in MySQL and it vanishes from
the UI on the next sync.

---

## 1 · Deploy (XAMPP / any Apache + PHP + MySQL)

```bash
# 1. Database
mysql -u root -p < database.sql          # creates alexandria_library + demo data + procedures

# 2. Credentials (XAMPP defaults already work: root / no password)
nano config.php

# 3. Files — put this folder into Apache's web root
cp -r library-system /opt/lampp/htdocs/  # or C:\xampp\htdocs\

# 4. Open
http://localhost/library-system/
```

The topbar shows **MySQL · connected / offline**. If offline, a banner tells
you exactly what to fix (credentials / server down).

## 2 · Architecture

```
index.php ── renders shell + embeds live state (build_state)
   │
js/app.js ── re-syncs state after every action
   │
api/        ── JSON endpoints (PDO, prepared statements)
   │
MySQL       ── stored procedures hold the rules; triggers write the ledger
```

| Endpoint | Method · Body | Calls | Feature |
|---|---|---|---|
| `api/bootstrap.php` | GET | `build_state()` | full state sync |
| `api/borrow.php` | POST `{bookId, borrower, days}` | `sp_borrow_book` | Borrow |
| `api/renew.php` | POST `{code}` | `sp_renew_loan` | **Feature 1 · Renewal** |
| `api/checkin.php` | POST `{code}` | `sp_checkin_book` | **Feature 3 · Check-In** |
| `api/undo.php` | POST `{}` | `sp_undo_checkin` | Undo (Stack LIFO) |
| `api/waitlist.php` | POST `{bookId, patron}` | `sp_join_waitlist` | Join queue |
| `api/events.php?since_id=N` | GET | `notifications` table | **Feature 5 · real-time toasts (FIFO)** |

Procedure refusals (e.g. *"Renewal refused — patrons are queued"*) are raised
as SQLSTATE 45000 and travel straight to the UI as toast messages.

## 3 · Purpose

Digitises a library circulation desk: what is on the shelf, who has it, when
it is due back, and who is next in line — instantly, fairly, and reversibly.

## 4 · Main Functionalities

| # | Feature | How it works |
|---|---|---|
| 1 | **Book Renewal** | `sp_renew_loan`: +14 days, max 2, refused while a queue exists |
| 2 | **Book Borrowing History** | Triggers on `loans` auto-write `history_events`; UI renders newest-first |
| 3 | **Book Check-In** | `sp_checkin_book`: closes loan, pushes undo checkpoint, dequeues front patron → 48-h hold |
| 4 | **Books Availability Monitoring** | `books.status` ENUM + live counters; BST/HashTable client indexes for instant search |
| 5 | **Real-Time Notification Alerts** | `notifications` table polled every 12 s (`since_id`), delivered FIFO |

Plus: LIFO check-in undo, overdue / due-soon scanner, 48-h hold expiry via a
MySQL EVENT (`sp_expire_holds`, every minute).

## 5 · Data Structures (and how they are implemented)

| Structure | Client side (js/data-structures.js) | Server side (database.sql) |
|---|---|---|
| **Binary Search Tree** | Index over live rows, key = title; search reports comparison count | `ORDER BY title` + index feeds it alphabetically |
| **Hash Table** | djb2 → 31 buckets; `id`/`isbn` → O(1) lookups | UNIQUE index on `isbn` |
| **Singly Linked List** | Ledger mirror; `insertAtHead` keeps head = newest | `history_events` written by triggers, `v_history_recent` orders DESC |
| **Stack** | Undo checkpoint mirror (top-first) | `checkin_checkpoints`: highest `id` = top; `sp_undo_checkin` pops |
| **Queue** | Waitlists + toast pipeline | `waitlist.position` FIFO; `notifications.id ASC` FIFO feed |

Open the in-app **System & DS Docs** view (key 5) for live metrics — BST
height, hash collisions, ledger size, stack depth, queue length.

## 6 · File map

```
library-system/
├── index.php              # app shell — PHP embeds live state once
├── config.php             # ← YOUR MySQL credentials
├── api/
│   ├── db.php             # PDO + JSON helpers + build_state()
│   ├── bootstrap.php      # GET  — full state
│   ├── events.php         # GET  — FIFO notification feed
│   ├── borrow.php         # POST → sp_borrow_book
│   ├── renew.php          # POST → sp_renew_loan
│   ├── checkin.php        # POST → sp_checkin_book
│   ├── undo.php           # POST → sp_undo_checkin
│   └── waitlist.php       # POST → sp_join_waitlist
├── css/style.css
├── js/
│   ├── data-structures.js # BST · HashTable · LinkedList · Stack · Queue
│   └── app.js             # API-driven controller — zero hardcoded data
├── database.sql           # schema + demo seed + views + triggers + procedures
└── README.md
```

## 7 · Multi-user real-time demo

Open the system in **two browsers**. Every mutation inserts into
`notifications` (procedures do this for queue joins, hold assignments, hold
expiries) — the other browser receives them within 12 seconds as FIFO toasts.
The `DEL`/`SIGNAL` logic stays identical; only the transport differs.

> Hold expiry needs `SET GLOBAL event_scheduler = ON;` — if your host forbids
> it, call `CALL sp_expire_holds();` from a cron job each minute instead.

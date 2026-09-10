-- ============================================================================
-- ALEXANDRIA — Library Book Borrowing System
-- database.sql · MySQL 8.0+ (works on 5.7+, but 8.0 recommended)
--
-- IMPORT INTO THE EXISTING DATABASE:
--   Select if0_42877310_alexandria_library in phpMyAdmin, then import this file.
--   Or run: mysql -h HOST -P 3306 -u USER -p if0_42877310_alexandria_library < database_tables.sql
--
-- WHAT YOU GET:
--   1. Database ``if0_42877310_alexandria_library`` (utf8mb4, InnoDB)
--   2. Tables: patrons, books, loans, waitlist, checkin_checkpoints,
--      history_events, notifications
--   3. Demo seed data — identical to the front-end demo (same titles,
--      same patrons, one overdue loan, one due-in-95-minutes loan, queues)
--   4. Views for the availability monitor & history ledger
--   5. Triggers that auto-log BORROW / RETURN / UNDO / RENEW events
--   6. Stored procedures mirroring every front-end BACKEND HOOK:
--        sp_borrow_book        → POST /api/loans
--        sp_renew_loan         → POST /api/loans/:code/renew
--        sp_checkin_book       → POST /api/returns
--        sp_undo_checkin       → POST /api/returns/:id/undo
--        sp_join_waitlist      → POST /api/books/:id/waitlist
--        sp_expire_holds       → called during state refreshes
-- ============================================================================

USE if0_42877310_alexandria_library;

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS history_events;
DROP TABLE IF EXISTS checkin_checkpoints;
DROP TABLE IF EXISTS waitlist;
DROP TABLE IF EXISTS loans;
DROP TABLE IF EXISTS books;
DROP TABLE IF EXISTS patrons;
SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- 1 · TABLES
-- ============================================================================

-- Patrons (library users). The front-end sends plain names; procedures
-- find-or-create patrons by name, so no auth layer is required to demo.
CREATE TABLE patrons (
  id         VARCHAR(8)  PRIMARY KEY,                 -- 'P01', 'P02', ...
  full_name  VARCHAR(120) NOT NULL UNIQUE,
  email      VARCHAR(190) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Books. ``status`` is the availability flag the UI badges read from.
-- ``hue`` is cosmetic (cover tint) so the web UI stays pixel-identical.
CREATE TABLE books (
  id             VARCHAR(8)  PRIMARY KEY,             -- 'B01', 'B02', ...
  isbn           VARCHAR(20)  NOT NULL UNIQUE,        -- O(1) scan target
  title          VARCHAR(255) NOT NULL,
  author         VARCHAR(255) NOT NULL,
  genre          VARCHAR(60)  NOT NULL,
  pub_year       SMALLINT     NOT NULL,
  hue            SMALLINT     NOT NULL DEFAULT 30,
  status         ENUM('available','borrowed','on-hold') NOT NULL DEFAULT 'available',
  active_loan_id INT UNSIGNED NULL,                   -- loan currently attached
  hold_patron_id VARCHAR(8)   NULL,                   -- active 48-h reservation
  hold_until     DATETIME     NULL,                   -- reservation expiry
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_books_status (status),
  INDEX idx_books_title  (title(191))
) ENGINE=InnoDB;

-- Loans. ``code`` is GENERATED so seeded loan id=1 ⇢ LN-1001 — exactly
-- what the front-end displays. Next generated id after seeds: LN-1007.
CREATE TABLE loans (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code         VARCHAR(10) GENERATED ALWAYS AS
               (CONCAT('LN-', LPAD(id + 1000, 4, '0'))) STORED UNIQUE,
  book_id      VARCHAR(8)  NOT NULL,
  patron_id    VARCHAR(8)  NOT NULL,
  borrowed_at  DATETIME    NOT NULL,
  due_at       DATETIME    NOT NULL,
  renewals     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_renewals TINYINT UNSIGNED NOT NULL DEFAULT 2,
  returned     TINYINT(1)  NOT NULL DEFAULT 0,
  returned_at  DATETIME    NULL,
  CONSTRAINT fk_loans_book   FOREIGN KEY (book_id)   REFERENCES books(id),
  CONSTRAINT fk_loans_patron FOREIGN KEY (patron_id) REFERENCES patrons(id),
  INDEX idx_loans_book (book_id, returned),
  INDEX idx_loans_due  (due_at)
) ENGINE=InnoDB;

-- Waitlists — FIFO per book. ``position`` is the queue order
-- (1 = front, served first). Uniqueness stops duplicate queue joins.
CREATE TABLE waitlist (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  book_id   VARCHAR(8) NOT NULL,
  patron_id VARCHAR(8) NOT NULL,
  position  INT UNSIGNED NOT NULL,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_wait_book   FOREIGN KEY (book_id)   REFERENCES books(id),
  CONSTRAINT fk_wait_patron FOREIGN KEY (patron_id) REFERENCES patrons(id),
  UNIQUE KEY uq_waitlist (book_id, patron_id),
  INDEX idx_waitlist_fifo (book_id, position)
) ENGINE=InnoDB;

-- Undo Stack. Highest id = TOP of stack (LIFO). A row with popped = 0 is
-- still undoable. Mirrors the front-end Stack of check-in checkpoints.
CREATE TABLE checkin_checkpoints (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  loan_id             INT UNSIGNED NOT NULL,
  book_id             VARCHAR(8)   NOT NULL,
  served_patron_id    VARCHAR(8)   NULL,   -- who was dequeued (if anyone)
  served_position     INT UNSIGNED NULL,   -- their queue position (to restore)
  prev_hold_patron_id VARCHAR(8)   NULL,   -- hold state before check-in
  prev_hold_until     DATETIME     NULL,
  popped              TINYINT(1) NOT NULL DEFAULT 0,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cp_loan FOREIGN KEY (loan_id) REFERENCES loans(id),
  CONSTRAINT fk_cp_book FOREIGN KEY (book_id) REFERENCES books(id),
  INDEX idx_cp_stack (popped, id)
) ENGINE=InnoDB;

-- History ledger = the Singly Linked List, persisted.
-- Newest row = MAX(created_at, id) = list head.
CREATE TABLE history_events (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type       ENUM('BORROW','RENEW','RETURN','HOLD','SYSTEM','UNDO') NOT NULL,
  message    VARCHAR(500) NOT NULL,
  detail     VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_history_time (created_at)
) ENGINE=InnoDB;

-- Notifications = the toast Queue, persisted.
-- delivered = 0 ⇢ still waiting in the FIFO pipeline.
CREATE TABLE notifications (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type       ENUM('success','info','warning','error','system') NOT NULL DEFAULT 'info',
  title      VARCHAR(160) NOT NULL,
  message    VARCHAR(500) NOT NULL,
  delivered  TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notif_queue (delivered, id)
) ENGINE=InnoDB;

-- circular convenience pointer (books.active_loan_id → loans.id)
ALTER TABLE books
  ADD CONSTRAINT fk_books_active_loan
  FOREIGN KEY (active_loan_id) REFERENCES loans(id);

-- ============================================================================
-- 2 · TRIGGERS — the ledger logs itself
-- ============================================================================

DELIMITER $$

-- Every new loan instantly becomes a BORROW node in the history list,
-- backdated to the loan's borrowed_at so seeds read like real events.
CREATE TRIGGER trg_loans_after_insert
AFTER INSERT ON loans
FOR EACH ROW
BEGIN
  INSERT INTO history_events (type, message, detail, created_at)
  SELECT 'BORROW',
         CONCAT(p.full_name, ' borrowed "', b.title, '"'),
         CONCAT('Loan ', NEW.code, ' · due ', DATE_FORMAT(NEW.due_at, '%b %e, %Y')),
         NEW.borrowed_at
  FROM patrons p JOIN books b ON b.id = NEW.book_id
  WHERE p.id = NEW.patron_id;
END$$

-- RETURN (0→1) and UNDO (1→0) transitions + RENEW increments.
CREATE TRIGGER trg_loans_after_update
AFTER UPDATE ON loans
FOR EACH ROW
BEGIN
  IF NEW.returned = 1 AND OLD.returned = 0 THEN
    INSERT INTO history_events (type, message, detail, created_at)
    SELECT 'RETURN',
           CONCAT(p.full_name, ' returned "', b.title, '"'),
           CONCAT('Loan ', NEW.code, ' closed'),
           NOW()
    FROM patrons p JOIN books b ON b.id = NEW.book_id
    WHERE p.id = NEW.patron_id;
  ELSEIF NEW.returned = 0 AND OLD.returned = 1 THEN
    INSERT INTO history_events (type, message, detail, created_at)
    SELECT 'UNDO',
           CONCAT('Check-in reversed for "', b.title, '"'),
           CONCAT('Stack.pop() → loan ', NEW.code, ' re-opened'),
           NOW()
    FROM books b WHERE b.id = NEW.book_id;
  END IF;

  IF NEW.renewals > OLD.renewals THEN
    INSERT INTO history_events (type, message, detail, created_at)
    SELECT 'RENEW',
           CONCAT(p.full_name, ' renewed "', b.title, '"'),
           CONCAT('+14 days → due ', DATE_FORMAT(NEW.due_at, '%b %e, %Y'),
                  ' · renewal ', NEW.renewals, ' of ', NEW.max_renewals),
           NOW()
    FROM patrons p JOIN books b ON b.id = NEW.book_id
    WHERE p.id = NEW.patron_id;
  END IF;
END$$

DELIMITER ;

-- ============================================================================
-- 3 · SEED DATA — the same demo the front-end ships with
-- ============================================================================

INSERT INTO patrons (id, full_name) VALUES
  ('P01', 'Amara Chen'),
  ('P02', 'Jonas Weber'),
  ('P03', 'Omar Haddad'),
  ('P04', 'Diego Ramos'),
  ('P05', 'Priya Nair'),
  ('P06', 'Lena Fischer'),
  ('P07', 'M. Okafor'),
  ('P08', 'T. Alvarez');

INSERT INTO books (id, isbn, title, author, genre, pub_year, hue, status) VALUES
  ('B01', '9780262033848', 'Introduction to Algorithms',                     'Cormen, Leiserson, Rivest & Stein', 'Computer Science', 2009, 160, 'borrowed'),
  ('B02', '9780201896831', 'The Art of Computer Programming',                'Donald E. Knuth',                   'Computer Science', 1968,  42, 'borrowed'),
  ('B03', '9780262510875', 'Structure and Interpretation of Computer Programs', 'Abelson & Sussman',              'Computer Science', 1996, 190, 'available'),
  ('B04', '9780132350884', 'Clean Code',                                     'Robert C. Martin',                  'Computer Science', 2008, 140, 'available'),
  ('B05', '9780135957059', 'The Pragmatic Programmer',                       'Hunt & Thomas',                     'Computer Science', 1999, 120, 'on-hold'),
  ('B06', '9780465026562', 'Gödel, Escher, Bach',                            'Douglas Hofstadter',                'Philosophy',       1979,  30, 'available'),
  ('B07', '9780812968255', 'Meditations',                                    'Marcus Aurelius',                   'Philosophy',        180,  20, 'available'),
  ('B08', '9780140441185', 'Thus Spoke Zarathustra',                         'Friedrich Nietzsche',               'Philosophy',       1883, 350, 'borrowed'),
  ('B09', '9780441172719', 'Dune',                                           'Frank Herbert',                     'Science Fiction',  1965, 210, 'borrowed'),
  ('B10', '9780553293357', 'Foundation',                                     'Isaac Asimov',                      'Science Fiction',  1951, 230, 'available'),
  ('B11', '9780441569595', 'Neuromancer',                                    'William Gibson',                    'Science Fiction',  1984, 262, 'available'),
  ('B12', '9780441478125', 'The Left Hand of Darkness',                      'Ursula K. Le Guin',                 'Science Fiction',  1969, 284, 'borrowed'),
  ('B13', '9780062316097', 'Sapiens',                                        'Yuval Noah Harari',                 'History',          2011,  14, 'available'),
  ('B14', '9780345476098', 'The Guns of August',                             'Barbara W. Tuchman',                'History',          1962,   6, 'available'),
  ('B15', '9780756404741', 'The Name of the Wind',                           'Patrick Rothfuss',                  'Literature',       2007, 300, 'borrowed'),
  ('B16', '9780060883287', 'One Hundred Years of Solitude',                  'Gabriel García Márquez',            'Literature',       1967, 322, 'available'),
  ('B17', '9780679720201', 'The Stranger',                                   'Albert Camus',                      'Literature',       1942, 342, 'available'),
  ('B18', '9780553380163', 'A Brief History of Time',                        'Stephen Hawking',                    'Science',          1988, 200, 'available');

-- Active loans (relative to NOW() so the demo is always alive).
-- Trigger ``trg_loans_after_insert`` auto-writes the BORROW ledger entries.
INSERT INTO loans (id, book_id, patron_id, borrowed_at, due_at, renewals) VALUES
  (1, 'B01', 'P01', NOW() - INTERVAL 8 DAY,                                  NOW() + INTERVAL 6 DAY,     0),  -- LN-1001 · CLRS
  (2, 'B02', 'P02', NOW() - INTERVAL 12 DAY,                                 NOW() + INTERVAL 2 DAY,     1),  -- LN-1002 · Knuth (queue-proof renewal)
  (3, 'B08', 'P03', NOW() - INTERVAL 18 DAY,                                 NOW() - INTERVAL 3 HOUR,    2),  -- LN-1003 · OVERDUE demo
  (4, 'B09', 'P04', NOW() - INTERVAL 12 DAY - INTERVAL 22 HOUR,              NOW() + INTERVAL 95 MINUTE, 0),  -- LN-1004 · DUE-SOON demo
  (5, 'B12', 'P05', NOW() - INTERVAL 10 DAY,                                 NOW() + INTERVAL 4 DAY,     0),  -- LN-1005 · Le Guin
  (6, 'B15', 'P06', NOW() - INTERVAL 5 DAY,                                  NOW() + INTERVAL 9 DAY,     1);  -- LN-1006 · Rothfuss

ALTER TABLE loans AUTO_INCREMENT = 7;   -- next loan will be LN-1007 ✔

-- Wire each borrowed book to its loan.
UPDATE books SET active_loan_id = 1 WHERE id = 'B01';
UPDATE books SET active_loan_id = 2 WHERE id = 'B02';
UPDATE books SET active_loan_id = 3 WHERE id = 'B08';
UPDATE books SET active_loan_id = 4 WHERE id = 'B09';
UPDATE books SET active_loan_id = 5 WHERE id = 'B12';
UPDATE books SET active_loan_id = 6 WHERE id = 'B15';

-- Waitlist queues (FIFO by ``position``).
INSERT INTO waitlist (book_id, patron_id, position, joined_at) VALUES
  ('B02', 'P05', 1, NOW() - INTERVAL 5 HOUR),   -- Knuth: Priya waiting → blocks Jonas's renewal
  ('B12', 'P02', 1, NOW() - INTERVAL 9 HOUR),   -- Le Guin: Jonas front
  ('B12', 'P06', 2, NOW() - INTERVAL 6 HOUR),   -- Le Guin: Lena rear
  ('B05', 'P04', 1, NOW() - INTERVAL 2 HOUR);   -- Pragmatic: Diego behind the hold

-- Active 48-h hold: The Pragmatic Programmer is reserved for Lena.
UPDATE books SET hold_patron_id = 'P06',
                 hold_until     = NOW() + INTERVAL 36 HOUR
WHERE id = 'B05';

-- Hand-written ledger entries (returns/holds/system from the demo's past;
-- borrow/renew/renew rows that come from seeded loans are already logged
-- by the triggers + the row below).
INSERT INTO history_events (type, message, detail, created_at) VALUES
  ('SYSTEM', 'Nightly catalogue sync completed — 18 titles indexed',
             'BST rebuilt · HashTable re-balanced', NOW() - INTERVAL 6 DAY),
  ('RETURN', 'T. Alvarez returned "Brave New World"',
             'Checked in at Terminal 2 · shelf A-4', NOW() - INTERVAL 4 DAY - INTERVAL 5 HOUR),
  ('HOLD',   'Diego Ramos joined the waitlist for "The Pragmatic Programmer"',
             'Queue.enqueue() → position 1', NOW() - INTERVAL 4 DAY),
  ('HOLD',   'Lena Fischer joined the waitlist for "The Left Hand of Darkness"',
             'Queue.enqueue() → position 2', NOW() - INTERVAL 6 HOUR),
  ('RENEW',  'Lena Fischer renewed "The Name of the Wind"',
             '+14 days · renewal 1 of 2', NOW() - INTERVAL 2 DAY - INTERVAL 3 HOUR),
  ('HOLD',   'Jonas Weber joined the waitlist for "The Left Hand of Darkness"',
             'Queue.enqueue() → position 1', NOW() - INTERVAL 9 HOUR),
  ('HOLD',   'Priya Nair joined the waitlist for "The Art of Computer Programming"',
             'Queue.enqueue() → position 1', NOW() - INTERVAL 5 HOUR),
  ('SYSTEM', 'RFID gates re-calibrated across 3 terminals',
             'Availability lookups now served in O(1)', NOW() - INTERVAL 2 HOUR);

INSERT INTO notifications (type, title, message) VALUES
  ('system', 'Alexandria online', 'Front desk live · 18 titles indexed, ledger and queues restored from MySQL.');

-- ============================================================================
-- 4 · VIEWS — what the front-end (or your API) reads
-- ============================================================================

-- Availability counters  ⇢  catalog stat strip
CREATE OR REPLACE VIEW v_availability_summary AS
SELECT
  (SELECT COUNT(*) FROM books)                          AS total_titles,
  (SELECT COUNT(*) FROM books WHERE status='available') AS available_now,
  (SELECT COUNT(*) FROM books WHERE status='borrowed')  AS on_loan,
  (SELECT COUNT(*) FROM books WHERE status='on-hold')   AS on_hold,
  (SELECT COUNT(*) FROM waitlist)                       AS patrons_queued;

-- Full catalog with live state  ⇢  book grid
CREATE OR REPLACE VIEW v_catalog AS
SELECT
  b.id, b.isbn, b.title, b.author, b.genre, b.pub_year, b.hue, b.status,
  l.code               AS loan_code,
  l.due_at             AS loan_due_at,
  p.full_name          AS borrower,
  hp.full_name         AS hold_for,
  b.hold_until,
  (SELECT COUNT(*) FROM waitlist w WHERE w.book_id = b.id) AS waitlist_size
FROM books b
LEFT JOIN loans   l  ON l.id = b.active_loan_id
LEFT JOIN patrons p  ON p.id = l.patron_id
LEFT JOIN patrons hp ON hp.id = b.hold_patron_id
ORDER BY b.title;

-- Active loans  ⇢  Active Loans & Renewals view
CREATE OR REPLACE VIEW v_active_loans AS
SELECT
  l.code AS loan_code, b.id AS book_id, b.title, b.isbn,
  p.full_name AS borrower, l.borrowed_at, l.due_at,
  l.renewals, l.max_renewals,
  (l.due_at < NOW())                          AS is_overdue,
  TIMESTAMPDIFF(MINUTE, NOW(), l.due_at)      AS minutes_left,
  (SELECT COUNT(*) FROM waitlist w WHERE w.book_id = b.id) AS waitlist_size
FROM loans l
JOIN books   b ON b.id = l.book_id
JOIN patrons p ON p.id = l.patron_id
WHERE l.returned = 0
ORDER BY l.due_at ASC;

-- Waitlists in FIFO order  ⇢  Check-In Desk queue panel
CREATE OR REPLACE VIEW v_waitlists AS
SELECT b.id AS book_id, b.title, w.position, p.full_name AS patron, w.joined_at
FROM waitlist w
JOIN books   b ON b.id = w.book_id
JOIN patrons p ON p.id = w.patron_id
ORDER BY b.title, w.position;

-- Undo stack, TOP first  ⇢  Check-In Desk stack panel
CREATE OR REPLACE VIEW v_undo_stack AS
SELECT c.id AS stack_pos, l.code AS loan_code, b.title,
       p.full_name AS served_patron, c.created_at
FROM checkin_checkpoints c
JOIN loans   l ON l.id = c.loan_id
JOIN books   b ON b.id = c.book_id
LEFT JOIN patrons p ON p.id = c.served_patron_id
WHERE c.popped = 0
ORDER BY c.id DESC;               -- highest id = TOP of stack (LIFO)

-- History ledger, newest first  ⇢  Borrowing History view
CREATE OR REPLACE VIEW v_history_recent AS
SELECT id, type, message, detail, created_at
FROM history_events
ORDER BY created_at DESC, id DESC
LIMIT 50;

-- Undelivered toasts in FIFO order  ⇢  notification polling endpoint
CREATE OR REPLACE VIEW v_toast_queue AS
SELECT id, type, title, message, created_at
FROM notifications
WHERE delivered = 0
ORDER BY id ASC;                  -- front of queue first (FIFO)

-- ============================================================================
-- 5 · STORED PROCEDURES — one per BACKEND HOOK
-- ============================================================================

DELIMITER $$

-- ---------------------------------------------------------------- borrow --
-- CALL sp_borrow_book('B04', 'Jane Doe', 14);
CREATE PROCEDURE sp_borrow_book (
  IN p_book_id  VARCHAR(8),
  IN p_borrower VARCHAR(120),
  IN p_days     INT
)
BEGIN
  DECLARE v_status  VARCHAR(10) DEFAULT NULL;
  DECLARE v_patron  VARCHAR(8)  DEFAULT NULL;
  DECLARE v_loan_id INT UNSIGNED DEFAULT 0;
  DECLARE v_code    VARCHAR(10) DEFAULT NULL;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  SELECT status INTO v_status FROM books WHERE id = p_book_id FOR UPDATE;
  IF v_status IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Book not found';
  END IF;
  IF v_status <> 'available' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Book is not available';
  END IF;

  -- find-or-create the patron by full name
  SELECT id INTO v_patron FROM patrons WHERE full_name = p_borrower LIMIT 1;
  IF v_patron IS NULL THEN
    SET v_patron = (
      SELECT CONCAT('P', LPAD(COALESCE(MAX(CAST(SUBSTRING(id, 2) AS UNSIGNED)), 0) + 1, 2, '0'))
      FROM patrons
    );
    INSERT INTO patrons (id, full_name) VALUES (v_patron, p_borrower);
  END IF;

  INSERT INTO loans (book_id, patron_id, borrowed_at, due_at)
  VALUES (p_book_id, v_patron, NOW(), NOW() + INTERVAL p_days DAY);
  SET v_loan_id = LAST_INSERT_ID();
  SELECT code INTO v_code FROM loans WHERE id = v_loan_id;

  UPDATE books SET status = 'borrowed', active_loan_id = v_loan_id
  WHERE id = p_book_id;

  COMMIT;
  SELECT v_code AS loan_code, v_patron AS patron_id,
         (SELECT due_at FROM loans WHERE id = v_loan_id) AS due_at;
END$$

-- ---------------------------------------------------------------- renew ---
-- CALL sp_renew_loan('LN-1001');
-- Refused automatically when renewals hit the cap OR the FIFO queue is
-- non-empty — the exact guard the front-end enforces.
CREATE PROCEDURE sp_renew_loan (IN p_code VARCHAR(10))
BEGIN
  DECLARE v_loan INT UNSIGNED DEFAULT NULL;
  DECLARE v_book VARCHAR(8)   DEFAULT NULL;
  DECLARE v_ren  INT DEFAULT 0;
  DECLARE v_max  INT DEFAULT 2;
  DECLARE v_q    INT DEFAULT 0;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  BEGIN
    DECLARE EXIT HANDLER FOR NOT FOUND
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Active loan not found';
    SELECT id, book_id, renewals, max_renewals
      INTO v_loan, v_book, v_ren, v_max
    FROM loans WHERE code = p_code AND returned = 0 FOR UPDATE;
  END;

  SELECT COUNT(*) INTO v_q FROM waitlist WHERE book_id = v_book;
  IF v_q > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Renewal refused — patrons are queued for this title (FIFO waitlist non-empty)';
  END IF;
  IF v_ren >= v_max THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Renewal cap reached (2/2)';
  END IF;

  UPDATE loans SET renewals = renewals + 1,
                   due_at   = due_at + INTERVAL 14 DAY
  WHERE id = v_loan;                        -- trigger logs the RENEW event

  COMMIT;
  SELECT renewals, due_at FROM loans WHERE id = v_loan;
END$$

-- ------------------------------------------------------ join waitlist -----
-- CALL sp_join_waitlist('B02', 'M. Okafor');
CREATE PROCEDURE sp_join_waitlist (
  IN p_book_id VARCHAR(8),
  IN p_patron  VARCHAR(120)
)
BEGIN
  DECLARE v_status VARCHAR(10) DEFAULT NULL;
  DECLARE v_pid    VARCHAR(8)  DEFAULT NULL;
  DECLARE v_pos    INT DEFAULT 0;
  DECLARE v_title  VARCHAR(255) DEFAULT '';

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  SELECT status, title INTO v_status, v_title
  FROM books WHERE id = p_book_id FOR UPDATE;
  IF v_status IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Book not found';
  END IF;
  IF v_status = 'available' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Title is available — borrow it instead of queueing';
  END IF;

  SELECT id INTO v_pid FROM patrons WHERE full_name = p_patron LIMIT 1;
  IF v_pid IS NULL THEN
    SET v_pid = (
      SELECT CONCAT('P', LPAD(COALESCE(MAX(CAST(SUBSTRING(id, 2) AS UNSIGNED)), 0) + 1, 2, '0'))
      FROM patrons
    );
    INSERT INTO patrons (id, full_name) VALUES (v_pid, p_patron);
  END IF;

  IF EXISTS (SELECT 1 FROM waitlist WHERE book_id = p_book_id AND patron_id = v_pid) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Patron is already in this queue';
  END IF;

  SET v_pos = COALESCE((SELECT MAX(position) FROM waitlist WHERE book_id = p_book_id), 0) + 1;
  INSERT INTO waitlist (book_id, patron_id, position) VALUES (p_book_id, v_pid, v_pos);

  INSERT INTO history_events (type, message, detail, created_at)
  VALUES ('HOLD', CONCAT(p_patron, ' joined the waitlist for "', v_title, '"'),
          CONCAT('Queue.enqueue() → position ', v_pos), NOW());

  -- broadcast to the real-time toast feed (api/events.php picks this up)
  INSERT INTO notifications (type, title, message)
  VALUES ('info', 'Waitlist activity',
          CONCAT(p_patron, ' is now #', v_pos, ' in line for "', v_title, '".'));

  COMMIT;
  SELECT v_pos AS position;
END$$

-- -------------------------------------------------------------- check-in --
-- CALL sp_checkin_book('LN-1004');
-- Closes the loan, pushes an undo checkpoint (Stack.push), then serves the
-- front of the waitlist queue (Queue.dequeue → 48-h hold) or frees the book.
CREATE PROCEDURE sp_checkin_book (IN p_code VARCHAR(10))
BEGIN
  DECLARE v_loan      INT UNSIGNED DEFAULT NULL;
  DECLARE v_book      VARCHAR(8)   DEFAULT NULL;
  DECLARE v_title     VARCHAR(255) DEFAULT '';
  DECLARE v_wid       INT UNSIGNED DEFAULT NULL;
  DECLARE v_wpatron   VARCHAR(8)   DEFAULT NULL;
  DECLARE v_wpos      INT UNSIGNED DEFAULT NULL;
  DECLARE v_wname     VARCHAR(120) DEFAULT NULL;
  DECLARE v_prev_hp   VARCHAR(8)   DEFAULT NULL;
  DECLARE v_prev_hu   DATETIME     DEFAULT NULL;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  BEGIN
    DECLARE EXIT HANDLER FOR NOT FOUND
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Active loan not found';
    SELECT l.id, l.book_id INTO v_loan, v_book
    FROM loans l WHERE l.code = p_code AND l.returned = 0 FOR UPDATE;
  END;

  SELECT title, hold_patron_id, hold_until
    INTO v_title, v_prev_hp, v_prev_hu
  FROM books WHERE id = v_book;

  -- peek the FRONT of the FIFO queue
  SET v_wid = NULL;
  BEGIN
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_wid = NULL;
    SELECT id, patron_id, position INTO v_wid, v_wpatron, v_wpos
    FROM waitlist WHERE book_id = v_book ORDER BY position ASC LIMIT 1 FOR UPDATE;
  END;

  -- Stack.push(checkpoint)
  INSERT INTO checkin_checkpoints
    (loan_id, book_id, served_patron_id, served_position, prev_hold_patron_id, prev_hold_until)
  VALUES
    (v_loan, v_book, v_wpatron, v_wpos, v_prev_hp, v_prev_hu);

  UPDATE loans SET returned = 1, returned_at = NOW()
  WHERE id = v_loan;                        -- trigger logs the RETURN event

  IF v_wid IS NOT NULL THEN
    -- Queue.dequeue() → 48-hour hold for the front patron
    DELETE FROM waitlist WHERE id = v_wid;
    SELECT full_name INTO v_wname FROM patrons WHERE id = v_wpatron;

    UPDATE books SET status = 'on-hold',
                     active_loan_id = NULL,
                     hold_patron_id = v_wpatron,
                     hold_until = NOW() + INTERVAL 48 HOUR
    WHERE id = v_book;

    INSERT INTO history_events (type, message, detail, created_at)
    VALUES ('HOLD', CONCAT(v_wname, ' was dequeued for "', v_title, '"'),
            CONCAT('Queue.dequeue() → held until ',
                   DATE_FORMAT(NOW() + INTERVAL 48 HOUR, '%b %e, %Y')), NOW());

    -- broadcast to the real-time toast feed
    INSERT INTO notifications (type, title, message)
    VALUES ('info', 'Hold assigned',
            CONCAT('"', v_title, '" is reserved for ', v_wname, ' for 48 hours.'));
  ELSE
    UPDATE books SET status = 'available',
                     active_loan_id = NULL,
                     hold_patron_id = NULL,
                     hold_until = NULL
    WHERE id = v_book;
  END IF;

  COMMIT;
  SELECT v_book AS book_id, v_title AS title,
         IF(v_wid IS NULL, 'available', 'on-hold') AS new_status,
         v_wname AS served_patron,
         IF(v_wid IS NULL, NULL, NOW() + INTERVAL 48 HOUR) AS hold_until;
END$$

-- ----------------------------------------------------------------- undo ---
-- CALL sp_undo_checkin();
-- Stack.pop(): re-opens the most recent check-in and restores the dequeued
-- patron to the FRONT of the queue — LIFO, exactly like the front-end.
CREATE PROCEDURE sp_undo_checkin ()
BEGIN
  DECLARE v_cp      INT UNSIGNED DEFAULT NULL;
  DECLARE v_loan    INT UNSIGNED DEFAULT NULL;
  DECLARE v_book    VARCHAR(8)   DEFAULT NULL;
  DECLARE v_spatron VARCHAR(8)   DEFAULT NULL;
  DECLARE v_spos    INT UNSIGNED DEFAULT NULL;
  DECLARE v_php     VARCHAR(8)   DEFAULT NULL;
  DECLARE v_phu     DATETIME     DEFAULT NULL;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  BEGIN
    DECLARE EXIT HANDLER FOR NOT FOUND
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Undo stack empty — LIFO, nothing to restore';
    SELECT id, loan_id, book_id, served_patron_id, served_position,
           prev_hold_patron_id, prev_hold_until
      INTO v_cp, v_loan, v_book, v_spatron, v_spos, v_php, v_phu
    FROM checkin_checkpoints
    WHERE popped = 0
    ORDER BY id DESC                        -- TOP of stack first
    LIMIT 1 FOR UPDATE;
  END;

  UPDATE checkin_checkpoints SET popped = 1 WHERE id = v_cp;

  UPDATE loans SET returned = 0, returned_at = NULL
  WHERE id = v_loan;                        -- trigger logs the UNDO event

  UPDATE books SET status = 'borrowed',
                   active_loan_id = v_loan,
                   hold_patron_id = v_php,
                   hold_until = v_phu
  WHERE id = v_book;

  IF v_spatron IS NOT NULL THEN
    -- restore the dequeued patron to the FRONT of the queue
    UPDATE waitlist SET position = position + 1 WHERE book_id = v_book;
    INSERT INTO waitlist (book_id, patron_id, position, joined_at)
    VALUES (v_book, v_spatron, COALESCE(v_spos, 1), NOW());
  END IF;

  COMMIT;
  SELECT v_book AS book_id, v_loan AS loan_id, v_spatron AS restored_patron;
END$$

-- ----------------------------------------------------------- hold expiry --
-- Called once per minute by the scheduled EVENT below: releases expired
-- 48-h holds back to the shelf (mirrors the front-end ambient behaviour).
CREATE PROCEDURE sp_expire_holds ()
BEGIN
  DECLARE v_n INT DEFAULT 0;

  SELECT COUNT(*) INTO v_n
  FROM books
  WHERE status = 'on-hold' AND hold_until IS NOT NULL AND hold_until < NOW();

  IF v_n > 0 THEN
    UPDATE books SET status = 'available', hold_patron_id = NULL, hold_until = NULL
    WHERE status = 'on-hold' AND hold_until < NOW();

    INSERT INTO history_events (type, message, detail, created_at)
    VALUES ('SYSTEM', CONCAT(v_n, ' hold(s) lapsed after 48 h — released to shelf'),
            'hold_until < NOW() → status = available', NOW());

    -- broadcast to the real-time toast feed
    INSERT INTO notifications (type, title, message)
    VALUES ('warning', 'Hold expired',
            CONCAT(v_n, ' 48-hour hold(s) lapsed — book(s) released back to the shelf.'));
  END IF;
END$$

DELIMITER ;

-- ============================================================================
-- 6 · APP DATABASE USER  (uncomment and change the password before deploy)
-- ============================================================================
-- CREATE USER IF NOT EXISTS 'alexandria_app'@'%'
--   IDENTIFIED BY 'CHANGE_THIS_STRONG_PASSWORD';
-- GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE
--   ON if0_42877310_alexandria_library.* TO 'alexandria_app'@'%';
-- FLUSH PRIVILEGES;

-- ============================================================================
-- 7 · SMOKE TEST  (run these after import to confirm everything works)
-- ============================================================================
--   SELECT * FROM v_availability_summary;      -- 18 titles, 11 available, 6 on loan, 1 on hold, 4 queued
--   SELECT * FROM v_active_loans;              -- overdue Zarathustra first, Dune due in ~95 min
--   SELECT * FROM v_waitlists;
--   SELECT * FROM v_history_recent;
--   CALL sp_renew_loan('LN-1002');             -- → ERROR: patrons queued (correct!)
--   CALL sp_renew_loan('LN-1001');             -- → OK, due_at +14 days, RENEW appears in ledger
--   CALL sp_checkin_book('LN-1004');           -- → Dune returns (its queue is empty → available)
--   CALL sp_join_waitlist('B01', 'M. Okafor'); -- → position 2… then CALL sp_checkin_book('LN-1001');
--                                              -- → CLRS goes on-hold for Priya (Queue.dequeue)
--   CALL sp_undo_checkin();                    -- → Amara keeps CLRS, Priya restored to queue front
--   SELECT * FROM v_undo_stack;
-- ============================================================================
-- SCRIPT COMPLETE — the library is open.
-- ============================================================================

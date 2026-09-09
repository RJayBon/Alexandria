<?php
/* ==========================================================================
   ALEXANDRIA · api/db.php
   Shared PDO connection, JSON helpers and the full-state assembler used by
   index.php (first paint) and api/bootstrap.php (refreshes).
   ========================================================================== */

require_once __DIR__ . '/../config.php';

function get_pdo(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $dsn = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=%s',
                       DB_HOST, DB_PORT, DB_NAME, DB_CHARSET);
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    }
    return $pdo;
}

/* ------------------------------- responses ------------------------------- */
function json_ok(array $data = []): void {
    http_response_code(200);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => true] + $data, JSON_UNESCAPED_UNICODE);
    exit;
}

function json_err(int $code, string $message): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

/** SQLSTATE 45000 messages raised by the stored procedures surface here —
    e.g. "Renewal refused — patrons are queued for this title". */
function sql_message(PDOException $e): string {
    return $e->errorInfo[2] ?? $e->getMessage();
}

function body(): array {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : $_POST;
}

function ms(?string $dt): ?int {          // 'Y-m-d H:i:s' → epoch ms
    return $dt === null ? null : (int)(strtotime($dt) * 1000);
}

/* ------------------------------ state builder ---------------------------- */
function build_state(PDO $pdo): array {
    /* books + attached loan + hold patron */
    $rows = $pdo->query(
        "SELECT b.id, b.isbn, b.title, b.author, b.genre, b.pub_year, b.hue, b.status,
                l.code AS loan_code, l.borrowed_at, l.due_at, l.renewals, l.max_renewals,
                pb.full_name AS borrower,
                hp.full_name AS hold_for, b.hold_until
         FROM books b
         LEFT JOIN loans   l  ON l.id = b.active_loan_id
         LEFT JOIN patrons pb ON pb.id = l.patron_id
         LEFT JOIN patrons hp ON hp.id = b.hold_patron_id
         ORDER BY b.title"
    )->fetchAll();

    /* waitlists (Queue rows, front → rear) */
    $queues = [];
    foreach ($pdo->query(
        "SELECT w.book_id, p.full_name AS name, w.joined_at
         FROM waitlist w JOIN patrons p ON p.id = w.patron_id
         ORDER BY w.book_id, w.position"
    ) as $q) {
        $queues[$q['book_id']][] = ['name' => $q['name'], 'at' => ms($q['joined_at'])];
    }

    $books = [];
    foreach ($rows as $r) {
        $books[] = [
            'id'        => $r['id'],
            'isbn'      => $r['isbn'],
            'title'     => $r['title'],
            'author'    => $r['author'],
            'genre'     => $r['genre'],
            'year'      => (int)$r['pub_year'],
            'hue'       => (int)$r['hue'],
            'status'    => $r['status'],
            'holdFor'   => $r['hold_for'],
            'holdUntil' => ms($r['hold_until']),
            'waitlist'  => $queues[$r['id']] ?? [],
            'loan'      => $r['loan_code'] !== null ? [
                'code'        => $r['loan_code'],
                'borrower'    => $r['borrower'],
                'borrowedAt'  => ms($r['borrowed_at']),
                'dueAt'       => ms($r['due_at']),
                'renewals'    => (int)$r['renewals'],
                'maxRenewals' => (int)$r['max_renewals'],
            ] : null,
        ];
    }

    /* history ledger — newest first (linked-list head) */
    $history = [];
    foreach ($pdo->query(
        "SELECT type, message, detail, created_at
         FROM history_events ORDER BY created_at DESC, id DESC LIMIT 60"
    ) as $h) {
        $history[] = [
            'type' => $h['type'], 'msg' => $h['message'],
            'sub' => $h['detail'], 'at' => ms($h['created_at']),
        ];
    }

    /* undo stack — TOP first */
    $undo = [];
    foreach ($pdo->query(
        "SELECT c.id, l.code, b.title, p.full_name AS served, c.created_at
         FROM checkin_checkpoints c
         JOIN loans l ON l.id = c.loan_id
         JOIN books b ON b.id = c.book_id
         LEFT JOIN patrons p ON p.id = c.served_patron_id
         WHERE c.popped = 0 ORDER BY c.id DESC LIMIT 25"
    ) as $c) {
        $undo[] = [
            'loanCode' => $c['code'], 'title' => $c['title'],
            'served' => $c['served'], 'at' => ms($c['created_at']),
        ];
    }

    $lastId = (int)$pdo->query("SELECT COALESCE(MAX(id),0) FROM notifications")->fetchColumn();

    return [
        'serverNow'   => (int)round(microtime(true) * 1000),
        'books'       => $books,
        'history'     => $history,
        'undoStack'   => $undo,
        'lastNotifId' => $lastId,
    ];
}

<?php
/* POST api/waitlist.php  { bookId, patron }
   → CALL sp_join_waitlist — Queue.enqueue at the rear; returns the position. */
require __DIR__ . '/db.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err(405, 'POST required');

$b = body();
$bookId = trim((string)($b['bookId'] ?? ''));
$patron = trim((string)($b['patron'] ?? ''));

if ($bookId === '' || $patron === '') json_err(422, 'bookId and patron are required');

try {
    $st = get_pdo()->prepare("CALL sp_join_waitlist(?, ?)");
    $st->execute([$bookId, $patron]);
    $row = $st->fetch();
    $st->closeCursor();
    json_ok(['position' => (int)$row['position']]);
} catch (PDOException $e) {
    json_err(400, sql_message($e));          // "already in this queue", etc.
}

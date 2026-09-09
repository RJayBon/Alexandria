<?php
/* POST api/checkin.php  { code }
   → CALL sp_checkin_book — closes the loan, pushes the undo checkpoint onto
     the Stack, then Queue.dequeue()s the front patron into a 48-h hold. */
require __DIR__ . '/db.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err(405, 'POST required');

$b = body();
$code = trim((string)($b['code'] ?? ''));
if ($code === '') json_err(422, 'code is required');

try {
    $st = get_pdo()->prepare("CALL sp_checkin_book(?)");
    $st->execute([$code]);
    $row = $st->fetch();
    $st->closeCursor();
    json_ok(['result' => [
        'bookId'       => $row['book_id'],
        'title'        => $row['title'],
        'newStatus'    => $row['new_status'],
        'servedPatron' => $row['served_patron'],
        'holdUntil'    => ms($row['hold_until']),
    ]]);
} catch (PDOException $e) {
    json_err(400, sql_message($e));
}

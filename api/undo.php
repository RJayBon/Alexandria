<?php
/* POST api/undo.php  {}
   → CALL sp_undo_checkin — Stack.pop(): re-opens the last check-in and
     restores the dequeued patron to the FRONT of the queue. */
require __DIR__ . '/db.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err(405, 'POST required');

try {
    $st = get_pdo()->query("CALL sp_undo_checkin()");
    $row = $st->fetch();
    $st->closeCursor();
    json_ok(['result' => [
        'bookId'         => $row['book_id'],
        'loanId'         => (int)$row['loan_id'],
        'restoredPatron' => $row['restored_patron'],
    ]]);
} catch (PDOException $e) {
    json_err(400, sql_message($e));          // "Undo stack empty", etc.
}

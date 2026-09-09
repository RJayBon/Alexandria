<?php
/* POST api/borrow.php  { bookId, borrower, days }
   → CALL sp_borrow_book — availability check happens inside MySQL. */
require __DIR__ . '/db.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err(405, 'POST required');

$b = body();
$bookId   = trim((string)($b['bookId'] ?? ''));
$borrower = trim((string)($b['borrower'] ?? ''));
$days     = (int)($b['days'] ?? 14);

if ($bookId === '' || $borrower === '') json_err(422, 'bookId and borrower are required');
if ($days < 1 || $days > 90) json_err(422, 'Loan period must be between 1 and 90 days');

try {
    $st = get_pdo()->prepare("CALL sp_borrow_book(?, ?, ?)");
    $st->execute([$bookId, $borrower, $days]);
    $row = $st->fetch();
    $st->closeCursor();
    json_ok(['loan' => [
        'code'      => $row['loan_code'],
        'patron_id' => $row['patron_id'],
        'dueAt'     => ms($row['due_at']),
    ]]);
} catch (PDOException $e) {
    json_err(400, sql_message($e));          // "Book is not available", etc.
}

<?php
/* POST api/renew.php  { code }
   → CALL sp_renew_loan — MySQL refuses when the waitlist queue is non-empty
     or the renewal cap is hit; the refusal text comes straight from SQL. */
require __DIR__ . '/db.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err(405, 'POST required');

$b = body();
$code = trim((string)($b['code'] ?? ''));
if ($code === '') json_err(422, 'code is required');

try {
    $st = get_pdo()->prepare("CALL sp_renew_loan(?)");
    $st->execute([$code]);
    $row = $st->fetch();
    $st->closeCursor();
    json_ok(['loan' => [
        'renewals' => (int)$row['renewals'],
        'dueAt'    => ms($row['due_at']),
    ]]);
} catch (PDOException $e) {
    json_err(400, sql_message($e));
}

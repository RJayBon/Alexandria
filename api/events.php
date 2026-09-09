<?php
/* GET api/events.php?since_id=N
   Notification feed — returns every row newer than since_id, ordered by id
   ASC so the client Queue.dequeue()s them strictly FIFO (real-time toasts). */
require __DIR__ . '/db.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') json_err(405, 'GET required');

$since = isset($_GET['since_id']) ? (int)$_GET['since_id'] : 0;

try {
    $pdo = get_pdo();
    $st = $pdo->prepare(
        "SELECT id, type, title, message, created_at
         FROM notifications WHERE id > ? ORDER BY id ASC LIMIT 25"
    );
    $st->execute([$since]);
    $notifications = [];
    $last = $since;
    foreach ($st->fetchAll() as $n) {
        $notifications[] = [
            'type' => $n['type'],
            'title' => $n['title'],
            'msg' => $n['message'],
            'at' => ms($n['created_at']),
        ];
        $last = (int)$n['id'];
    }
    json_ok(['notifications' => $notifications, 'lastNotifId' => $last]);
} catch (Throwable $e) {
    json_err(500, 'Database error: ' . $e->getMessage());
}

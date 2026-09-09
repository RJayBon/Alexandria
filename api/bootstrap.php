<?php
/* GET api/bootstrap.php → full live state (used after every mutation) */
require __DIR__ . '/db.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') json_err(405, 'GET required');

try {
    json_ok(['state' => build_state(get_pdo())]);
} catch (Throwable $e) {
    json_err(500, 'Database error: ' . $e->getMessage());
}

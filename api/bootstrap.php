<?php
/* GET api/bootstrap.php → full live state (used after every mutation) */
require __DIR__ . '/db.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') json_err(405, 'GET required');

try {
    json_ok(['state' => build_state(get_pdo())]);
} catch (Throwable $e) {
    error_log('Alexandria bootstrap database error: ' . $e->getMessage());
    json_err(500, 'Database unavailable');
}

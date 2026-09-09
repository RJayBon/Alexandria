# Alexandria Library Borrowing System: Deployment-Readiness Audit

**Audit date:** 2026-09-10  
**Repository:** [RJayBon/Alexandria][1]  
**Scope:** Entire repository, including PHP entry points and APIs, JavaScript controller and data structures, CSS assets, MySQL schema, stored procedures, triggers, views, and deployment documentation.

## Executive conclusion

Alexandria is **not ready for unrestricted public deployment**. The core application wiring is coherent, and the repository now passes PHP and JavaScript syntax validation. The frontend, PHP APIs, and MySQL routines form a complete request path. However, the system still has two **critical production blockers**: it has no authentication or authorization, and it has no Cross-Site Request Forgery (CSRF) protection for state-changing endpoints. The database credential is also stored in a public GitHub repository and must be rotated immediately.

The remote database connection could not be verified from this audit environment because `sql202.infinityfree.com` does not resolve here. This is a network/DNS limitation rather than a credential rejection. The hosted application must be tested from InfinityFree after the database schema is imported.

| Area | Result | Meaning |
|---|---|---|
| Repository completeness | Pass | All referenced core PHP, JavaScript, CSS, and SQL files exist. |
| Frontend-to-API wiring | Pass with caveats | All primary UI actions map to PHP endpoints and stored procedures. |
| API-to-database wiring | Pass by inspection | PDO calls map to procedures, tables, triggers, and views in the schema. |
| PHP syntax | Pass | Every PHP file passed `php -l`. |
| JavaScript syntax | Pass | Both JavaScript files passed `node --check`. |
| Local HTTP offline behavior | Pass | The page and APIs return controlled offline responses when MySQL is unavailable. |
| Live database connectivity | Not verified | The supplied hostname cannot be resolved from this sandbox. |
| Authentication and authorization | Fail | Any visitor can invoke borrowing, check-in, undo, renewal, and waitlist operations. |
| CSRF protection | Fail | State-changing POST endpoints accept requests without a CSRF token. |
| Credential handling | Critical fail | The database password is committed to a public repository. |
| Shared-host schema compatibility | Improved | Privileged scheduled-event creation was removed; expiry now runs during refreshes. |

## System connection trace

The application has the following intended end-to-end path:

```text
Browser
  ├─ initial GET /
  │    └─ index.php
  │         └─ api/db.php → PDO → MySQL
  │              └─ build_state() → books, loans, waitlist,
  │                 history_events, checkin_checkpoints, notifications
  │
  ├─ POST api/borrow.php
  │    └─ CALL sp_borrow_book()
  │         └─ patrons, loans, books
  │              └─ loan trigger → history_events
  │
  ├─ POST api/renew.php
  │    └─ CALL sp_renew_loan()
  │         └─ loans and renewal trigger → history_events
  │
  ├─ POST api/checkin.php
  │    └─ CALL sp_checkin_book()
  │         └─ loans, books, checkin_checkpoints, waitlist,
  │            history_events, notifications
  │
  ├─ POST api/undo.php
  │    └─ CALL sp_undo_checkin()
  │         └─ checkpoint, loan, book, and waitlist restoration
  │
  ├─ POST api/waitlist.php
  │    └─ CALL sp_join_waitlist()
  │         └─ patrons, waitlist, history_events, notifications
  │
  └─ GET api/bootstrap.php and api/events.php
       └─ PDO queries → JSON → app.js hydration and FIFO notifications
```

The JavaScript controller calls the expected routes: `api/bootstrap.php`, `api/events.php`, `api/borrow.php`, `api/renew.php`, `api/checkin.php`, `api/undo.php`, and `api/waitlist.php`. The server-side procedures with those responsibilities exist in `database.sql`.

## Findings and risk assessment

### Critical: public database credential exposure

`config.php` contains the live database password, and the repository is public. The password is also present in Git history. Editing the current file is not sufficient because the historical commit remains accessible.

**Required action:** Rotate the InfinityFree database password immediately. Then remove credentials from tracked source, use hosting-panel environment variables or a server-local configuration file, and rewrite repository history if the public repository must remain secure. Do not reuse the exposed password.

### Critical: no authentication or authorization

The application documentation explicitly describes a demo without an authentication layer. Every visitor who can reach the site can submit mutation requests. The following operations are therefore publicly callable: borrow, renew, check-in, undo, and waitlist enrollment.

**Required action:** Add authenticated user or staff sessions and authorize each operation. At minimum, circulation mutations should require a staff role. Patron identity should come from the authenticated session rather than an arbitrary browser-supplied name.

### Critical: no CSRF protection

The mutation endpoints accept JSON POST requests without a CSRF token and without a same-origin verification step. If authentication is added without CSRF protection, an attacker could cause an authenticated staff member’s browser to perform circulation actions.

**Required action:** Add session-bound CSRF tokens to every mutation endpoint, verify the `Origin` or `Referer` header as a secondary defense, and set secure session-cookie attributes.

### High: destructive database import

`database.sql` disables foreign-key checks, drops all application tables, and reseeds demo data. This is suitable for a fresh demo database but unsafe as a general production deployment or upgrade script.

**Required action:** Use a separate first-install script and versioned migrations. Never run the current seed script against a live database containing real circulation records.

### High: live database connection is unverified

The configured host, port, database, and username match the supplied hosting details. A local PDO smoke test reached the connection code but failed at DNS resolution with `php_network_getaddresses: getaddrinfo for sql202.infinityfree.com failed`. The sandbox cannot validate whether the remote host is reachable from InfinityFree or whether the credentials are accepted.

**Required action:** Import the schema in the hosting provider’s phpMyAdmin, deploy the PHP files, and open the hosted URL. Confirm that the page reports `MySQL · connected`, then exercise the smoke-test calls listed in `database.sql`.

### High: third-party frontend dependencies are external

Fonts load from Google Fonts and icons load from an unpkg CDN. A CDN outage, content-security policy, or restrictive network can affect presentation and icons. The application’s core logic does not depend on the fonts, but the icons do affect the interface.

**Recommended action:** Pin and self-host production assets where feasible, or add a documented content-security policy that explicitly permits the selected origins.

### Medium: input and abuse controls are incomplete

The stored procedures use prepared calls, which reduces SQL injection risk. However, the public endpoints have no rate limiting, no request-size limit, no authentication, and only limited semantic validation. Patron names can be submitted repeatedly and the application can be abused to create arbitrary records.

**Recommended action:** Add authentication, rate limiting, maximum request-body size, field-length validation, normalized patron identity, and audit logging that includes the authenticated operator.

### Medium: notification feed has no access boundary

`api/events.php` returns notification records newer than a caller-supplied ID. In an unauthenticated deployment, any visitor can observe circulation activity and patron names.

**Required action:** Protect the endpoint with the same staff authorization as the application, and minimize personally identifying information in notification messages.

### Medium: error handling is now safer but should be operationalized

The public bootstrap and notification APIs now return the generic message `Database unavailable` while logging details server-side. This prevents direct database-error leakage. The server must have a writable and monitored PHP error log; otherwise operators will lose diagnostic information.

### Medium: stored-procedure patron ID generation has a concurrency risk

New patron IDs are generated by taking the current maximum numeric suffix and adding one. Concurrent transactions for different books can calculate the same next ID and collide on the primary key.

**Recommended action:** Replace the computed string identifier with an auto-increment numeric patron key, or serialize ID allocation with a dedicated counter row and lock.

### Low: source-download links were broken

Both source-download links pointed to `../library-system.zip`, which is not present in the repository. They now point to the GitHub repository instead.

## Safe changes applied during this audit

The following changes were made because they are deterministic, low-risk, and directly improve deployment behavior:

| File | Change |
|---|---|
| `api/bootstrap.php` | Replaced raw database exception output with a generic response and server-side logging. |
| `api/events.php` | Replaced raw database exception output with a generic response and server-side logging. |
| `api/db.php` | Added opportunistic `sp_expire_holds()` execution during state refresh, with logging if expiry cannot run. |
| `index.php` | Hid raw database errors from the page and replaced both broken source links with GitHub links. |
| `js/app.js` | Added explicit `dbOffline` state tracking for initial load and refresh failures. |
| `database.sql` | Removed scheduled-event creation that can fail on shared hosting because it requires event privileges. |
| `README.md` | Documented refresh-based hold expiry and the updated deployment behavior. |

## Validation evidence

The following checks passed after the changes:

- Every PHP file passed `php -l` with no syntax errors.
- `js/app.js` passed `node --check`.
- `js/data-structures.js` passed `node --check`.
- `git diff --check` passed.
- All expected API and static asset files exist and are non-empty.
- A local PHP server rendered the offline page successfully.
- `api/bootstrap.php` returned `{"ok":false,"message":"Database unavailable"}` when MySQL was unreachable.
- `api/events.php` returned the same controlled error shape when MySQL was unreachable.
- The corrected source links no longer reference the missing `library-system.zip` file.

The following checks could not be completed from this environment:

- Remote DNS resolution and TCP connectivity to `sql202.infinityfree.com:3306`.
- Authentication against the hosted MySQL database.
- Import of `database.sql` into the hosted database.
- Browser-level testing of all successful borrow, renew, check-in, undo, waitlist, and notification flows against live data.

## Required deployment sequence

1. Rotate the exposed database password in InfinityFree.
2. Remove the password from `config.php` and provide it through a server-local configuration mechanism that is not committed to Git.
3. Add authentication, authorization, CSRF protection, rate limiting, and secure session cookies before opening the site to the public.
4. Back up the existing hosted database before any schema operation.
5. Import the schema only into the intended database and understand that the current script drops and reseeds application tables.
6. Deploy PHP files with PHP PDO MySQL support enabled.
7. Confirm that the hosted environment resolves the MySQL hostname and that the user has access to the selected database.
8. Open the site and confirm the top bar reports `MySQL · connected`.
9. Execute the non-destructive smoke tests in the SQL file and verify that each mutation causes the expected state refresh, ledger entry, queue update, and notification.
10. Enable HTTPS and configure security headers before handling real patron information.

## Final readiness decision

**Decision: Not approved for public production deployment.**

The application is structurally connected and technically close to a working hosted demo. It is suitable for controlled testing after the schema is imported and the database password is rotated. It is not suitable for an unrestricted online deployment until credential handling, authentication, authorization, CSRF protection, and production-safe migration procedures are implemented.

## References

[1]: https://github.com/RJayBon/Alexandria "Alexandria Library Book Borrowing System repository"

*Prepared by Manus AI.*


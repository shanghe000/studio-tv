# Private library

ROLE/SCENE gallery aggregates use the existing Service + RegisterRoutes. Iteration03 adds separate folder/node/entry aggregates: postgres.NewEntries(pool), application.NewEntries(repo), HTTP RegisterEntryRoutes. Product root must compose both registrations.

Real folders, ordered thumbnails, bounded native node content plus authoritative READY asset joins, union paging, revisioned batch creation/move/delete, complete parent reachability/owner checks and UUID receipts. Gallery identity/type remains immutable; actual image add/order/main/delete operations advance the existing aggregate.

Current contract is library-extension v2 (21 IMPLEMENTED operations). [Resources API](../../../../../docs/resources-api.md) supersedes the historical minimal-slice status list in docs/library-api.md. No public publishing, team transfers, URLs-as-assets or simulated data. Domain/application do not read environment; integration uses only explicit TEST_DATABASE_URL via isolated testdb.

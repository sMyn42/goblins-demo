# Vendored pgmq (official SQL-only installation)

Unmodified upstream `pgmq-extension/sql/pgmq.sql`, pinned to **v1.13.1**:
https://github.com/pgmq/pgmq/blob/v1.13.1/pgmq-extension/sql/pgmq.sql

SHA-256: `e861fcbd8c602df70a00eb9d230b1a2f591860a2230b9a6084172e3eff463642`

License: PostgreSQL License; included in `LICENSE`.

This is the real pgmq implementation, not an application-written queue emulator. The upstream-supported SQL-only install lets local PostgreSQL and PGlite integration tests exercise the same enqueue/lease/archive SQL APIs as Supabase Queues without requiring Docker or a host-installed extension.

Use `PGMQ_INSTALL_MODE=sql npm run db:migrate` on a fresh local database. On Supabase, enable Queues/pgmq and use `PGMQ_INSTALL_MODE=existing`. Existing schemas are never overwritten/upgraded by setup. SQL-only upgrades require an explicitly reviewed migration; this file is not reapplied to existing installations.

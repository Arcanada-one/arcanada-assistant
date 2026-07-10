-- ARCA-0039: assistant_app must not run with SUPERUSER/CREATEROLE/CREATEDB.
-- The official postgres image grants SUPERUSER to POSTGRES_USER on initdb;
-- this script strips it back down to the least privilege the app needs
-- (owns + can CRUD its own database, nothing cluster-wide).
--
-- Runs ONLY via docker-entrypoint-initdb.d, i.e. only on first boot against
-- an empty data volume. It has no effect on an already-initialized volume
-- (PROD) — see README.md § Security for the manual runbook step.
ALTER ROLE assistant_app WITH NOSUPERUSER NOCREATEROLE NOCREATEDB;

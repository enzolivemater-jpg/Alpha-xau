-- ALPHA-XAU — public schema creation hardening
-- Removes application-role DDL authority while preserving schema usage and
-- all existing object privileges. Independent of migrations 0029-0033.

BEGIN;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM anon, authenticated, service_role;

COMMIT;


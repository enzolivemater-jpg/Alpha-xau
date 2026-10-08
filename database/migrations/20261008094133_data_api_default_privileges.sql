-- XAU V2 / SB-3 — opt-in Data API privileges for future public objects.
--
-- Existing object ACLs are intentionally unchanged. Every future table,
-- function, and sequence exposed to an application role must be granted
-- explicitly in the migration that creates it.

BEGIN;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES
  FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS
  FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES
  FROM anon, authenticated, service_role;

-- PostgreSQL's built-in PUBLIC function grant is global. A schema-scoped
-- REVOKE cannot override it, so this one revocation must be global too.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS
  FROM PUBLIC;

COMMIT;

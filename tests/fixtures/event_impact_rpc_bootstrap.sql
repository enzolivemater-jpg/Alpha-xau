-- Disposable test database only. This is a narrow fixture for the sole
-- upstream relation read by 0023/0024, not a fresh-install schema test.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE TABLE public.event_versions (
  id UUID PRIMARY KEY,
  knowledge_cutoff TIMESTAMPTZ NOT NULL
);
INSERT INTO public.event_versions VALUES
  ('00000000-0000-0000-0000-000000000001', '2026-09-22T00:00:00.123456Z');
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT ON public.event_versions TO service_role;

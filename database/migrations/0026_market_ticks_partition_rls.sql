-- Close direct-partition RLS bypasses while preserving the parent-table API.
-- Existing policies remain owned by public.market_ticks; direct child-table
-- access intentionally fails closed because child partitions have no policy.
BEGIN;

DO $$
DECLARE
  v_partition RECORD;
BEGIN
  FOR v_partition IN
    SELECT n.nspname, c.relname
      FROM pg_catalog.pg_inherits AS i
      JOIN pg_catalog.pg_class AS c ON c.oid = i.inhrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE i.inhparent = 'public.market_ticks'::pg_catalog.regclass
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      v_partition.nspname,
      v_partition.relname
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_create_market_ticks_partition(p_month DATE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_start DATE := pg_catalog.date_trunc('month', p_month)::DATE;
  v_end   DATE := (pg_catalog.date_trunc('month', p_month) + INTERVAL '1 month')::DATE;
  v_name  TEXT := pg_catalog.format('market_ticks_%s', pg_catalog.to_char(v_start, 'YYYY_MM'));
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = v_name
  ) THEN
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      v_name
    );
    RETURN v_name || ' (already exists)';
  END IF;

  EXECUTE pg_catalog.format(
    'CREATE TABLE public.%I PARTITION OF public.market_ticks FOR VALUES FROM (%L) TO (%L)',
    v_name,
    v_start,
    v_end
  );
  EXECUTE pg_catalog.format(
    'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
    v_name
  );
  RETURN v_name || ' (created)';
END;
$$;

COMMIT;

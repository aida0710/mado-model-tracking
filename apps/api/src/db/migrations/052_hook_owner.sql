-- The owner a hook runs as. created_by stays the record of who made the hook; a Project admin
-- may move run_as_user_id to a Service Account so the hook survives its creator leaving.
-- The hook configuration stays immutable apart from enabled and the owner.
CREATE OR REPLACE FUNCTION reject_hook_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'enabled' - 'run_as_user_id')
    IS DISTINCT FROM (to_jsonb(OLD) - 'enabled' - 'run_as_user_id') THEN
    RAISE EXCEPTION 'Hook configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

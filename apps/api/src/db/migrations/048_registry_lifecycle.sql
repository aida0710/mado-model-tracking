-- A Dataset is archived instead of deleted: its versions stay immutable and existing Runs keep
-- referring to them, while new Runs refuse them as inputs. NULL means the Dataset is in use.
ALTER TABLE datasets ADD COLUMN archived_at timestamptz;

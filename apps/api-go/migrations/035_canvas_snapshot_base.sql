-- Only an observed /ready base or authoritative full-save receipt can back a
-- final v1 write. Historical rows deliberately start without a proved base.
ALTER TABLE collaboration.canvas_account_pages ADD COLUMN snapshot_base bigint CHECK(snapshot_base > 0);

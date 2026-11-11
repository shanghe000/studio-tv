-- Only a live holder handling an unfinished gesture can extend a self-handoff.
ALTER TABLE collaboration.canvas_edit_requests ADD COLUMN deferred_until timestamptz;

# Internal retained-content maintenance

This directory is excluded from the Web public assets. Do not serve it or link it from the product UI.

`export-open-page.js` is a maintenance-only exporter for an already authenticated, open canvas. It captures retained edits without submitting a task or writing the server, removes credentials and signed query strings, and marks incomplete local media. Its output may contain project content and must remain private.

The regular product shows only an interrupted-sync status and a safe retry. It does not expose revisions, compare current and server copies, import/export backups, or ask users to resolve versions. Existing journal data and authenticated internal recovery methods remain available to authorized maintenance work. A real overlapping edit is retained; retries do not choose a winner or claim it has been saved.

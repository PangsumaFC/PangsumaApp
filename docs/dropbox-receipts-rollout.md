# Dropbox receipt rollout and recovery

## Approved behavior

Only future owner-initiated photo uploads can create Dropbox files and public viewer links. The folder `/Pengajuan Pangsuma` itself is never shared publicly. Existing D1 receipt blobs and existing demo receipts are not backfilled, copied, linked, or changed by migration 0009. The uploader sees the public-link disclosure before explicitly choosing “Setuju & unggah foto”.

New receipts retain the existing immutable D1 image safety copy. The receipt and pending Dropbox metadata are inserted in one D1 batch. Dropbox upload uses a deterministic per-receipt filename with add-only/no-autorename semantics. A public viewer link is requested only after the uploaded file is verified. Metadata becomes ready only after the explicit public/viewer permission response is checked. Failures remain pending and resumable; they do not modify finance records. Replays use the same file and metadata record. PDF attachment links are drawn only from ready metadata within the report snapshot.

## Deployment gate

The normal deployment workflow runs all unit/offline schema tests, then `scripts/check-dropbox-deploy.py` in read-only mode. Migration 0009 must already be tracked, all six metadata guards must exist, the three Dropbox credentials must be encrypted Pages environment secrets, and `DROPBOX_RECEIPTS_ENABLED` must be `true`. The deployment workflow does not apply migrations.

## Recovery preparation completed for this rollout

A private D1 SQL export was downloaded outside the repository and restored into local SQLite. Integrity was `ok`. Applying migration 0009 to that restored data preserved all 19 existing tables and all 33 pre-existing trigger definitions; the metadata table remained empty. Backup SHA-256: `088e0e0b995065b2dac5a982dfb404a4192401321a7b23e1e11371f65c4474c7`.

Pre-migration D1 recovery bookmark: `0000007b-00000000-00005108-7fb1bd699f697ee538d639472c9c108a`. Migration SHA-256: `5920bf24ae4e416802e7617c96ebdf43bb4d933d5f5948581b159e9ad451b55c`.

Migration 0009 only created metadata schema/index/guards and its migration-tracking row. Immediately after migration, the original 22 receipt blobs still contained 2,247,740 bytes; user/submission/ledger/receipt/audit row counts were unchanged, and there were zero metadata rows. No production test receipt or public link was created.

## Safe rollback

1. Set the production `DROPBOX_RECEIPTS_ENABLED` variable to `false` and deploy the previous known-good application using the existing release flow. Do not change credentials, financial data, or old receipt blobs.
2. Leave migration 0009 and its data in place. Do not drop the table or delete pending/ready rows; this preserves resumability and historical evidence. Public links already created by real users remain public until separately revoked with authorization.
3. For a data incident, first export the current state and pause writes through an approved maintenance procedure. Inspect the private pre-migration dump and restore it to a separate local/disposable database to compare row/blob counts and trigger definitions.
4. Production D1 Time Travel restore must be a separate, explicitly approved recovery operation. Restoring an old bookmark discards later legitimate changes; never restore automatically as part of deployment rollback. Confirm the target database/account/bookmark and reconcile subsequent legitimate transactions before proceeding.

OAuth credentials and private database dumps must never be committed, served as site assets, included in PDF URLs, or printed in logs. No physical Android validation is implied by the browser/PWA history unit tests.

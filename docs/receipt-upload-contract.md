# Receipt upload byte contract

## Fixed contract defects

The browser produces JPEG/PNG blobs with sides at most 2048 and encoded size at most 512 KiB. The previous receipt validator could reject such a valid 2048-square JPEG depending on sampling: public `jpeg-js.decode()` allocates two full RGB buffers that receipt validation never uses. In a synthetic 2048-square 4:4:4 case the entropy/IDCT stage accounts for 62,915,484 bytes, inside the existing 64 MiB budget, but public RGB output exceeds it. Removing unused RGB output, not raising the budget or changing persisted draft bytes, repairs this contract.

`functions/_vendor/receipt-jpeg-decoder.js` is generated from pinned jpeg-js 0.4.4. Its entropy decoder, strict decoding option, component reconstruction, IDCT, and allocation accounting are unchanged byte-for-byte. Only the public RGB-output wrapper is replaced. It validates supported color modes and reconstructed plane dimensions. The same 64 MiB decoder allocation accounting and 16 MP limit remain. This accounting is **not a total process/RSS limit**. `scripts/vendor-receipt-jpeg.mjs --check` detects upstream changes; retain both included licenses.

The structural walker now supports legal progressive/multi-scan JPEG and restart markers, instead of mistaking the first non-EOI entropy marker for corruption. It validates SOI/SOF/SOS/EOI, frame/scan lengths and selectors, precision, sampling/table bounds, full component/coefficient initial-scan coverage, and refinement order before strict pixel decoding. Truncation, trailing data, unsupported color modes, type confusion, oversized images and resource-heavy payloads still fail closed. APP1/APP13 privacy metadata is removed even between scans without altering compressed image data.

Client filenames now reserve room for the final extension within 180 characters and strip DEL consistently with server validation. No other image dimensions or format allowlists are widened.

## Retry and identity

No retry payload migration or re-encoding is introduced. Existing saved `submissionId`, submission idempotency key, receipt upload key, filename and image bytes stay unchanged. A same-key/same-payload replay remains one receipt and one audit event; changed payloads still conflict. The existing Dropbox immutable path, hash/size checks and pending-job recovery are unchanged. The browser preview and receipt POST use identical draft bytes; canonical stored bytes may differ only through documented privacy sanitization, and response SHA/size describe stored bytes.

## Repeatable offline evidence

```sh
npm test
python3 -B tests/profile_schema_unit.py
python3 -B tests/manager_submission_schema_unit.py
python3 -B tests/request_numbers_sqlite_test.py
python3 -B tests/request_numbers_migration_unit.py
python3 tests/receipt_byte_contract_browser_local.py
node tests/receipt_byte_contract_verify_local.mjs
python3 tests/new_request_evidence_e2e.py
```

Browser tests require local Playwright, Pillow and Chrome. Their API writes are mocked/loopback only. `receipt_byte_contract_verify_local.mjs` compares six synthetic failures against original commit `c39266648c4af5fd56e372eba3e449ed3aa94ac4`, then validates 22 browser outputs using an in-memory SQLite endpoint and idempotent replay. The deployed public JavaScript can be fetched read-only and supplied with `RECEIPT_SCRIPT_FILE` or `PANGSUMA_QA_EVIDENCE_ASSET`; no production upload is needed.

## Incident evidence boundary

These are reproduced general defects, not proof of the encoding of any particular private user photo. Read-only Cloudflare telemetry aggregates around 18:32 WIB on 20 October 2026 returned no matching event groups; application `ApiError` responses were not logged. The exact incident error cannot be assigned retrospectively from the available telemetry. No user image was opened, copied, uploaded or analyzed. No production submission/status/balance, Dropbox object, or database migration is part of this fix.

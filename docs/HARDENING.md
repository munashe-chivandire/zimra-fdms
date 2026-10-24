# Hardening backlog

Concrete gaps found by auditing `src/core`, `src/node`, the tests and the
vectors at 0.4.1. Ordered by risk to receipt correctness: the top items can
make FDMS reject or mis-record a receipt today. Each item is sized as one
small PR (ideally under ~300 lines) with a test that fails before the change
and passes after.

Tick an item (`- [x]`) in the PR that does it.

## Receipt arithmetic and signing

- [ ] **Tax-exclusive tax is computed with a float multiply.**
  `buildReceiptTaxes` does `Math.round(totalCents * rate)`. At 14.5%, a
  $1.00 line gives `100 * 0.145 = 14.499999999999998`, so 14 cents instead of
  15. A brute-force check over totals 1..3,000,000 cents finds 3,951 wrong
  results at 14.5% (none at 15%, 15.5%, 5%, 0.5%). Compute both the inclusive
  and exclusive tax from an integer rate in hundredths of a percent, rounding
  half away from zero with integer arithmetic only. Add a property test
  against exact rational rounding over many totals, rates and signs, and a
  vector for the $1.00 at 14.5% exclusive case.

- [ ] **Receipt currency case is not normalised before counters.** The
  signing strings uppercase the currency, but `accumulateCounters` keys on
  `receiptCurrency` as given, so `"usd"` and `"USD"` receipts on one day make
  two counter sets that both sign as `USD`. `fiscalDaySigningString` also
  sorts currencies with `localeCompare`, which depends on the runtime locale
  (the same class of bug 0.4.1 fixed for tax codes). Uppercase the currency
  in `signReceipt`, sort counters by code point, and add tests for both.

- [ ] **Property tests for the signing strings and counters.** No test checks
  invariants across random inputs. Add seeded property tests: tax order in
  `concatenateReceiptTaxes` does not depend on input order;
  `toCents(centsToAmount(c)) === c` across the full safe range;
  `accumulateCounters` over N random receipts sums to the receipt totals,
  taxes and payments; zero counters never reach the CloseDay string.
  Tests only.

- [ ] **`signReceipt` does almost no input validation.** Nothing stops an
  empty `lines` or `payments` array, a zero, negative or `NaN` quantity, a
  negative or `NaN` tax percent, a currency that is not three letters, an
  empty `invoiceNo`, or an explicit `receiptDate` that is not after the
  previous receipt (FDMS answers RCPT030, Red, and the day can no longer be
  closed by the device). Validate before signing and throw one typed error
  naming the field, so nothing is numbered or signed for a bad input.

- [ ] **Credit and debit notes are not checked.** The `ReceiptInput` doc says
  `creditDebitNote` is required for CreditNote and DebitNote, but
  `signReceipt` accepts a credit note without one. Enforce it, with tests.
  Separately, the vectors sign credit notes with positive amounts; confirm
  the sign convention FDMS v7.2 expects for credit note lines, taxes and
  payments against the spec PDF or a live test before changing any vector.
  If it has to change, that is a breaking change: write it up, do not merge
  without Shaun.

## Submission, retries and the offline queue

- [ ] **A 5xx answer to SubmitReceipt is treated as a definite rejection.**
  `submitPrepared` deletes the pending marker on any `FdmsApiError`. A 502 or
  504 from a proxy, or a 500 after FDMS committed, means the outcome is
  unknown; the next receipt then reuses the same global number (RCPT012,
  Red) if FDMS did take it. Keep the marker for 5xx, 408 and 429 so
  `reconcile()` settles it, and make the offline queue treat those like a
  network failure. Test with the simulator accepting a receipt and answering
  502.

- [ ] **Concurrent calls on one `FiscalDevice` race.** `signReceipt`,
  `submitReceipt`, `submitPrepared`, `closeDay` and the queue's
  `enqueue`/`flush` read and write day state across awaits with no
  serialisation. Two `submitReceipt` calls in the same tick both sign global
  number N+1 from the same previous hash (RCPT011/RCPT012, broken chain).
  Serialise state-changing calls inside the device with a promise chain, and
  test `Promise.all` of several submits gives consecutive numbers and a valid
  chain.

- [ ] **A rejected journaled receipt blocks the offline queue forever.** When
  FDMS refuses a receipt in the journal, `flush()` stops, and every later
  receipt is already chained behind it, so each flush fails the same way.
  Return a typed error that names the receipt and the FDMS code, expose it
  from the queue, and document the recovery path (ZIMRA closes the day; the
  queue cannot skip a signed receipt without breaking the chain). No
  automatic skipping.

- [ ] **`oldestPendingAgeMs` uses the device clock.** It reads `Date.now()`,
  not the server-corrected clock the receipt dates came from, so a drifted
  terminal misjudges the 72-hour window. Use the `FiscalDevice`'s
  server-corrected clock instead and test with a skewed clock.

## Durability (Node file storage and journal)

- [ ] **`FileJournal.compact()` can skip unsubmitted receipts after a
  crash.** It rewrites the log without the committed lines, then resets the
  cursor to 0. A crash between the two leaves the old cursor applied to the
  shortened log, so that many unsubmitted receipts are silently skipped.
  Make compaction one atomic step (for example, record the base offset in the
  log file itself or write the cursor and log in an order that can only
  resubmit, never skip), and add a crash test that kills it between writes.

- [ ] **A torn last line breaks the journal on the next append.**
  `readFrom` drops a partial last line, but `append` writes straight after
  it, so the next record joins the partial bytes into one corrupt line that
  is no longer last, and `readFrom` then throws on every start. Repair the
  tail (truncate to the last newline) before appending, with a test.

- [ ] **Writes are not fsynced.** `atomicWrite` renames without fsyncing the
  temp file or the directory, and `FileJournal.append` does not fsync. On a
  power cut, a write the SDK already acted on can vanish or leave an empty
  file. Power cuts are routine for POS terminals in Zimbabwe. fsync the file
  before rename and the directory after, and the journal after append.

- [ ] **Nothing stops two processes using one profile.** Two POS processes on
  one `FileStorage` directory each keep their own counters and break the
  chain (RCPT011). Take an exclusive lock file in the Node adapter, refuse a
  second holder with a clear error, and test it.

## Clock, dates and certificates

- [ ] **Dates use the host's local time zone.** `fdmsDateTime`, `fdmsDate`
  and the QR date read local time from the `Date`. A Node host set to UTC
  stamps receipts two hours behind Harare and puts receipts between 22:00
  and 00:00 on the wrong fiscal date. Add an opt-in fixed UTC offset to the
  device options (Zimbabwe is UTC+2 with no DST), take the QR date from the
  receipt's own `receiptDate` string so it can never disagree with the
  signed date, and test both under a non-Harare `TZ`.

- [ ] **No certificate expiry check.** `renewCertificate` exists, but nothing
  tells a caller the certificate is close to `certificateValidTill`. Add a
  small helper that compares it to the server-corrected clock, use it in the
  CLI `status` output, and test the boundary.

## Errors, secrets and parity

- [ ] **Secrets in errors and logs are not tested.** Add tests that private
  key PEMs, activation keys and certificate bodies never appear in thrown
  error messages, `FdmsApiError` text, CLI output or MCP tool results, using
  sentinel values through the failure paths.

- [ ] **No shared contract test for `Storage` and `Journal`.** React Native
  and other platforms must implement both, and the crash-safety argument
  rests on their semantics (atomic `set`, append-only journal, monotonic
  cursor). Export a small contract test helper from core, run it against
  `MemoryStorage`, `MemoryJournal`, `FileStorage` and `FileJournal`, and
  document it in the React Native README.

## Docs

- [ ] **Write `docs/RELIABILITY.md`.** One page on what the SDK guarantees
  across crashes, network loss, clock drift and power cuts, what the caller
  must still do (call `reconcile()` on start, one process per device, persist
  storage atomically), and how the offline queue recovers. Link it from the
  README.

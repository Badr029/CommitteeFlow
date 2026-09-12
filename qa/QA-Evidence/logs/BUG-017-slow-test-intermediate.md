# BUG-017 slow-SMTP test — retained intermediate failure

Date: 2026-09-12

After the first successful 45-test focused run, the full server suite exposed a
race in the newly added test assertion:

```text
FAIL BUG-017 outbox fairness > starts an independent parent while a large parent SMTP batch is still slow
AssertionError: expected [ Array(1) ] to include '<large-parent-message-id>'
Test Files  1 failed | 14 passed (15)
Tests  1 failed | 334 passed | 4 skipped (339)
```

The test waited only for independent parent B and then incorrectly required
large parent A to have started first. With two bounded lanes, B may validly start
before A; exact ordering between independent parents is intentionally not
guaranteed. This was a test-design failure, not duplicate delivery, starvation
or a production-code exception.

Correction: wait until both A and B have started while A's first SMTP call stays
blocked, independent of which lane starts first. Then release A and verify both
parents finish. The failed run is retained here rather than omitted; final gate
results are in `BUG-017-verification.md`.

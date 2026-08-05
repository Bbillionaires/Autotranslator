-- NEW-5 fix (docs/test-report.md "Final Verification"): additive intermediate MessageStatus
-- used to make the PENDING -> SENT/QUEUED send transition atomic at the database level (a
-- conditional `UPDATE ... WHERE status = 'PENDING'` claims the row immediately before the
-- adapter call, closing the confirmAndSend/retryMessage concurrent-double-send race). Purely
-- additive: no existing row's status changes, no data migration needed.
ALTER TYPE "MessageStatus" ADD VALUE 'SENDING';

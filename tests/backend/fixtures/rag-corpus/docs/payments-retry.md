# Payment gateway timeouts and retries

When the payment gateway times out, the orders service retries the capture call up to three
times with exponential backoff. Every capture carries an idempotency key, so a retried capture
never charges the customer twice. Marker: RAG-CANARY-PAYMENTS-4C1E.

A gateway timeout that persists after the third retry is surfaced as HTTP 502 to the checkout
client and must be investigated as a payment provider incident, not as a flaky test.

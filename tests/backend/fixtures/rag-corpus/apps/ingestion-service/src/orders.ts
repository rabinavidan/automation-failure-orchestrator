// Orders client: capture with an idempotency key so gateway retries are safe.
export async function capturePayment(orderId: string, idempotencyKey: string): Promise<void> {
  await fetch(`/payments/${orderId}/capture`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
  });
}

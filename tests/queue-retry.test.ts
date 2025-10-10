import { Database } from "bun:sqlite";
import { Queue } from "../src/queue";
import { describe, test, expect, beforeEach } from "bun:test";

describe("Queue - Max Retry Logic", () => {
  let queue: Queue;
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new Queue(db, { mergeExistingAccounts: false });
  });

  test("should mark items as stalled when retry count exceeds maxRetries", () => {
    // Push a transfer
    const id = queue.push({
      receiver_account_id: "test.near",
      amount: "100",
    });

    const maxRetries = 5;

    // Fail 6 times (retry_count will be 1, 2, 3, 4, 5, 6)
    for (let i = 0; i <= maxRetries; i++) {
      // Create a batch
      const batchId = queue.createSignedTransaction(
        `fake-hash-${i}`,
        new Uint8Array([1, 2, 3]),
        [id],
      );

      // Fail the batch, which increments retry_count and checks against maxRetries
      queue.recoverFailedBatch(batchId, "Test error", maxRetries);
    }

    // After 6 retries (exceeding maxRetries of 5), item should be stalled
    const item = queue.getById(id);
    expect(item?.retry_count).toBe(6);
    expect(item?.is_stalled).toBe(1); // Stalled because retry_count (6) > maxRetries (5)
  });

  test("should not stall items if maxRetries is not specified", () => {
    const id = queue.push({
      receiver_account_id: "test.near",
      amount: "100",
    });

    // Fail 10 times without maxRetries parameter
    for (let i = 0; i < 10; i++) {
      const batchId = queue.createSignedTransaction(
        `fake-hash-${i}`,
        new Uint8Array([1, 2, 3]),
        [id],
      );
      queue.recoverFailedBatch(batchId, "Test error"); // No maxRetries parameter
    }

    const item = queue.getById(id);
    expect(item?.retry_count).toBe(10);
    expect(item?.is_stalled).toBe(0); // Should not be stalled
  });

  test("should filter out stalled items in peek()", () => {
    // Push 3 transfers
    const id1 = queue.push({
      receiver_account_id: "test1.near",
      amount: "100",
    });
    const id2 = queue.push({
      receiver_account_id: "test2.near",
      amount: "200",
    });
    const id3 = queue.push({
      receiver_account_id: "test3.near",
      amount: "300",
    });

    // Mark the second item as stalled
    queue.markItemStalled(id2, "Test error");

    // Peek should only return non-stalled items
    const items = queue.peek(10);
    expect(items.length).toBe(2);
    expect(items[0]?.id).toBe(id1);
    expect(items[1]?.id).toBe(id3);
  });

  test("is_stalled index should exist for performance", () => {
    // Query the sqlite_master table to check for our index
    const indexes = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_is_stalled'",
      )
      .all();

    expect(indexes.length).toBe(1);
  });
});

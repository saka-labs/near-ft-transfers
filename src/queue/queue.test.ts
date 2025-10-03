import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Queue } from ".";
import { QueueStatus } from "../types";
import type { TransferRequest } from "../types";

describe("Queue", () => {
  let db: Database;
  let queue: Queue;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new Queue(db);
  });

  describe("push", () => {
    test("should add a new transfer to the queue", () => {
      const transfer: TransferRequest = {
        receiver_account_id: "alice.testnet",
        amount: "1000000",
      };

      queue.push(transfer);

      const items = queue.pull(10);
      expect(items).toHaveLength(1);
      expect(items[0]!.receiver_account_id).toBe("alice.testnet");
      expect(items[0]!.amount).toBe("1000000");
      expect(items[0]!.status).toBe(QueueStatus.PENDING);
    });

    test("should aggregate amounts for same receiver_account_id with pending status", () => {
      const transfer1: TransferRequest = {
        receiver_account_id: "alice.testnet",
        amount: "1000000",
      };
      const transfer2: TransferRequest = {
        receiver_account_id: "alice.testnet",
        amount: "2000000",
      };

      queue.push(transfer1);
      queue.push(transfer2);

      const items = queue.pull(10);
      expect(items).toHaveLength(1);
      expect(items[0]!.receiver_account_id).toBe("alice.testnet");
      expect(items[0]!.amount).toBe("3000000"); // 1000000 + 2000000
    });

    test("should create separate entries for different receiver_account_ids", () => {
      const transfer1: TransferRequest = {
        receiver_account_id: "alice.testnet",
        amount: "1000000",
      };
      const transfer2: TransferRequest = {
        receiver_account_id: "bob.testnet",
        amount: "2000000",
      };

      queue.push(transfer1);
      queue.push(transfer2);

      const items = queue.pull(10);
      expect(items).toHaveLength(2);
      expect(items[0]!.receiver_account_id).toBe("alice.testnet");
      expect(items[1]!.receiver_account_id).toBe("bob.testnet");
    });

    test("should handle BigInt amounts correctly", () => {
      const transfer1: TransferRequest = {
        receiver_account_id: "alice.testnet",
        amount: "1000000000000000000000000",
      };
      const transfer2: TransferRequest = {
        receiver_account_id: "alice.testnet",
        amount: "2000000000000000000000000",
      };

      queue.push(transfer1);
      queue.push(transfer2);

      const items = queue.pull(10);
      expect(items).toHaveLength(1);
      expect(items[0]!.amount).toBe("3000000000000000000000000");
    });
  });

  describe("pull", () => {
    test("should return empty array when queue is empty", () => {
      const items = queue.pull(10);
      expect(items).toHaveLength(0);
    });

    test("should pull items with pending status and mark as processing", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });

      const items = queue.pull(10);
      expect(items).toHaveLength(1);
      expect(items[0]!.status).toBe(QueueStatus.PENDING);

      // Pull again - should get nothing since it's now processing
      const items2 = queue.pull(10);
      expect(items2).toHaveLength(0);
    });

    test("should respect the limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        queue.push({
          receiver_account_id: `user${i}.testnet`,
          amount: "1000000",
        });
      }

      const items = queue.pull(5);
      expect(items).toHaveLength(5);
    });

    test("should pull items in FIFO order", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });
      queue.push({ receiver_account_id: "charlie.testnet", amount: "3000000" });

      const items = queue.pull(10);
      expect(items[0]!.receiver_account_id).toBe("alice.testnet");
      expect(items[1]!.receiver_account_id).toBe("bob.testnet");
      expect(items[2]!.receiver_account_id).toBe("charlie.testnet");
    });

    test("should only pull pending items, not processing items", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });

      const batch1 = queue.pull(1);
      expect(batch1).toHaveLength(1);

      const batch2 = queue.pull(10);
      expect(batch2).toHaveLength(1);
      expect(batch2[0]!.receiver_account_id).toBe("bob.testnet");
    });
  });

  describe("markSuccess", () => {
    test("should mark item as success", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(10);

      queue.markSuccess(items[0]!.id);

      const result = db
        .query("SELECT * FROM queue WHERE id = ?")
        .get(items[0]!.id) as any;
      expect(result.status).toBe(QueueStatus.SUCCESS);
    });

    test("should update updated_at timestamp", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(10);
      const originalUpdatedAt = items[0]!.updated_at;

      // Wait a bit to ensure timestamp changes
      const start = Date.now();
      while (Date.now() - start < 5) {} // 5ms wait

      queue.markSuccess(items[0]!.id);

      const result = db
        .query("SELECT * FROM queue WHERE id = ?")
        .get(items[0]!.id) as any;
      expect(result.updated_at).toBeGreaterThan(originalUpdatedAt);
    });
  });

  describe("markFailed", () => {
    test("should mark item as failed with error message", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(10);

      queue.markFailed(items[0]!.id, "Network error");

      const result = db
        .query("SELECT * FROM queue WHERE id = ?")
        .get(items[0]!.id) as any;
      expect(result.status).toBe(QueueStatus.FAILED);
      expect(result.error_message).toBe("Network error");
    });

    test("should increment retry_count", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(10);

      queue.markFailed(items[0]!.id, "Error 1");
      let result = db
        .query("SELECT * FROM queue WHERE id = ?")
        .get(items[0]!.id) as any;
      expect(result.retry_count).toBe(1);

      queue.markFailed(items[0]!.id, "Error 2");
      result = db
        .query("SELECT * FROM queue WHERE id = ?")
        .get(items[0]!.id) as any;
      expect(result.retry_count).toBe(2);
    });

    test("should update updated_at timestamp", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(10);
      const originalUpdatedAt = items[0]!.updated_at;

      // Wait a bit to ensure timestamp changes
      const start = Date.now();
      while (Date.now() - start < 5) {} // 5ms wait

      queue.markFailed(items[0]!.id, "Test error");

      const result = db
        .query("SELECT * FROM queue WHERE id = ?")
        .get(items[0]!.id) as any;
      expect(result.updated_at).toBeGreaterThan(originalUpdatedAt);
    });
  });

  describe("deduplication edge cases", () => {
    test("should create new entry when existing transfer is marked as processing", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.pull(1); // Mark as processing

      queue.push({ receiver_account_id: "alice.testnet", amount: "2000000" });

      const allItems = db.query("SELECT * FROM queue").all() as any[];
      expect(allItems).toHaveLength(2);
      expect(allItems[0]!.amount).toBe("1000000");
      expect(allItems[0]!.status).toBe(QueueStatus.PROCESSING);
      expect(allItems[1]!.amount).toBe("2000000");
      expect(allItems[1]!.status).toBe(QueueStatus.PENDING);
    });

    test("should create new entry when existing transfer is marked as success", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(1);
      queue.markSuccess(items[0]!.id);

      queue.push({ receiver_account_id: "alice.testnet", amount: "2000000" });

      const allItems = db.query("SELECT * FROM queue").all() as any[];
      expect(allItems).toHaveLength(2);
      expect(allItems[0]!.status).toBe(QueueStatus.SUCCESS);
      expect(allItems[1]!.status).toBe(QueueStatus.PENDING);
    });

    test("should create new entry when existing transfer is marked as failed", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(1);
      queue.markFailed(items[0]!.id, "Error");

      queue.push({ receiver_account_id: "alice.testnet", amount: "2000000" });

      const allItems = db.query("SELECT * FROM queue").all() as any[];
      expect(allItems).toHaveLength(2);
      expect(allItems[0]!.status).toBe(QueueStatus.FAILED);
      expect(allItems[1]!.status).toBe(QueueStatus.PENDING);
    });
  });

  describe("concurrent operations", () => {
    test("should handle multiple pushes to same account atomically", () => {
      // Simulate concurrent pushes
      const transfers = Array.from({ length: 100 }, (_, i) => ({
        receiver_account_id: "alice.testnet",
        amount: "1000000",
      }));

      transfers.forEach((t) => queue.push(t));

      const items = queue.pull(10);
      expect(items).toHaveLength(1);
      expect(items[0]!.amount).toBe("100000000"); // 1000000 * 100
    });

    test("should handle pull operations atomically", () => {
      for (let i = 0; i < 10; i++) {
        queue.push({
          receiver_account_id: `user${i}.testnet`,
          amount: "1000000",
        });
      }

      const batch1 = queue.pull(5);
      const batch2 = queue.pull(5);

      expect(batch1).toHaveLength(5);
      expect(batch2).toHaveLength(5);

      // Ensure no overlap
      const ids1 = batch1.map((i) => i.id);
      const ids2 = batch2.map((i) => i.id);
      const overlap = ids1.filter((id) => ids2.includes(id));
      expect(overlap).toHaveLength(0);
    });
  });

  describe("data integrity", () => {
    test("should preserve all fields correctly", () => {
      const transfer: TransferRequest = {
        receiver_account_id: "alice.testnet",
        amount: "1234567890",
      };

      queue.push(transfer);
      const items = queue.pull(10);

      expect(items[0]!).toMatchObject({
        receiver_account_id: "alice.testnet",
        amount: "1234567890",
        status: QueueStatus.PENDING,
        retry_count: 0,
        error_message: null,
      });
      expect(items[0]!.id).toBeGreaterThan(0);
      expect(items[0]!.created_at).toBeGreaterThan(0);
      expect(items[0]!.updated_at).toBeGreaterThan(0);
    });
  });
});

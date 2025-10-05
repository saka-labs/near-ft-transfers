import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Queue } from "../src/queue";
import { QueueStatus } from "../src/types";
import type { TransferRequest } from "../src/types";

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
      expect(items[0]!.batch_id).toBeNull();
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

    test("should pull items with pending status (batch_id is null)", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });

      const items = queue.pull(10);
      expect(items).toHaveLength(1);
      expect(items[0]!.batch_id).toBeNull();

      // Pull again - should get same items since they haven't been assigned to a batch yet
      const items2 = queue.pull(10);
      expect(items2).toHaveLength(1);
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

    test("should only pull pending items (batch_id is null)", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });

      const items = queue.pull(10);
      expect(items).toHaveLength(2);

      // Assign to batch
      const batchId = queue.createSignedTransaction("hash1", new Uint8Array([1, 2, 3]), items.map(i => i.id));

      // Pull again - should get nothing since items are assigned to batch
      const items2 = queue.pull(10);
      expect(items2).toHaveLength(0);
    });
  });

  describe("batch transactions", () => {
    test("should create signed transaction and assign batch_id to queue items", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });

      const items = queue.pull(10);
      const signedTx = new Uint8Array([1, 2, 3, 4, 5]);
      const batchId = queue.createSignedTransaction("txhash123", signedTx, items.map(i => i.id));

      expect(batchId).toBeGreaterThan(0);

      // Verify batch_id is set on queue items
      const updatedItem1 = queue.getById(items[0]!.id);
      const updatedItem2 = queue.getById(items[1]!.id);
      expect(updatedItem1!.batch_id).toBe(batchId);
      expect(updatedItem2!.batch_id).toBe(batchId);

      // Verify batch transaction record
      const batchTx = db.query("SELECT * FROM batch_transactions WHERE id = ?").get(batchId) as any;
      expect(batchTx.tx_hash).toBe("txhash123");
      expect(batchTx.status).toBe(QueueStatus.PROCESSING);
      expect(batchTx.signed_tx).toEqual(signedTx);
    });

    test("should mark batch as success and update tx_hash", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(10);
      const batchId = queue.createSignedTransaction("signedHash", new Uint8Array([1, 2, 3]), items.map(i => i.id));

      queue.markBatchSuccess(batchId, "actualTxHash");

      const batchTx = db.query("SELECT * FROM batch_transactions WHERE id = ?").get(batchId) as any;
      expect(batchTx.status).toBe(QueueStatus.SUCCESS);
      expect(batchTx.tx_hash).toBe("actualTxHash");
      expect(batchTx.signed_tx).toBeNull();
    });

    test("should recover failed batch and increment retry_count on queue items", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });

      const items = queue.pull(10);
      const batchId = queue.createSignedTransaction("hash", new Uint8Array([1, 2, 3]), items.map(i => i.id));

      queue.recoverFailedBatch(batchId, "Network error");

      // Verify batch transaction is deleted
      const batchTx = db.query("SELECT * FROM batch_transactions WHERE id = ?").get(batchId);
      expect(batchTx).toBeNull();

      // Verify queue items are reset to pending
      const updatedItem1 = queue.getById(items[0]!.id);
      const updatedItem2 = queue.getById(items[1]!.id);
      expect(updatedItem1!.batch_id).toBeNull();
      expect(updatedItem2!.batch_id).toBeNull();

      // Verify retry_count is incremented
      expect(updatedItem1!.retry_count).toBe(1);
      expect(updatedItem2!.retry_count).toBe(1);

      // Verify error_message is stored
      expect(updatedItem1!.error_message).toBe("Network error");
      expect(updatedItem2!.error_message).toBe("Network error");

      // Items should be pullable again
      const retriedItems = queue.pull(10);
      expect(retriedItems).toHaveLength(2);
    });

    test("should get pending signed transactions", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });

      const items = queue.pull(10);
      const signedTx = new Uint8Array([1, 2, 3, 4, 5]);
      const batchId = queue.createSignedTransaction("txhash123", signedTx, items.map(i => i.id));

      const pending = queue.getPendingBatchTransactions();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe(batchId);
      expect(pending[0]!.tx_hash).toBe("txhash123");
      expect(pending[0]!.signed_tx).toEqual(signedTx);
      expect(pending[0]!.queue_ids).toEqual(items.map(i => i.id));
    });
  });

  describe("recover", () => {
    test("should reset processing items back to pending", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(10);
      const batchId = queue.createSignedTransaction("hash", new Uint8Array([1, 2, 3]), items.map(i => i.id));

      queue.recover();

      // Verify batch transaction is deleted
      const batchTx = db.query("SELECT * FROM batch_transactions WHERE id = ?").get(batchId);
      expect(batchTx).toBeNull();

      // Verify items are reset to pending
      const updatedItem = queue.getById(items[0]!.id);
      expect(updatedItem!.batch_id).toBeNull();

      // Items should be pullable again
      const retriedItems = queue.pull(10);
      expect(retriedItems).toHaveLength(1);
    });
  });

  describe("deduplication edge cases", () => {
    test("should create new entry when existing transfer has batch_id assigned", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(1);
      queue.createSignedTransaction("hash", new Uint8Array([1, 2, 3]), [items[0]!.id]);

      queue.push({ receiver_account_id: "alice.testnet", amount: "2000000" });

      const allItems = db.query("SELECT * FROM queue").all() as any[];
      expect(allItems).toHaveLength(2);
      expect(allItems[0]!.amount).toBe("1000000");
      expect(allItems[0]!.batch_id).not.toBeNull();
      expect(allItems[1]!.amount).toBe("2000000");
      expect(allItems[1]!.batch_id).toBeNull();
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

      // No overlap since pull doesn't change status, but items are the same
      const ids1 = batch1.map((i) => i.id);
      const ids2 = batch2.map((i) => i.id);
      // All 10 items should be returned in both pulls
      expect(ids1).toEqual(ids2);
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
        retry_count: 0,
        error_message: null,
        batch_id: null,
      });
      expect(items[0]!.id).toBeGreaterThan(0);
      expect(items[0]!.created_at).toBeGreaterThan(0);
      expect(items[0]!.updated_at).toBeGreaterThan(0);
    });
  });

  describe("getStats", () => {
    test("should return correct queue statistics", () => {
      // Add pending items
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });

      // Create a processing batch
      const items = queue.pull(1);
      queue.createSignedTransaction("hash1", new Uint8Array([1, 2, 3]), [items[0]!.id]);

      // Mark one as success
      const successItems = queue.pull(1);
      const successBatchId = queue.createSignedTransaction("hash2", new Uint8Array([4, 5, 6]), [successItems[0]!.id]);
      queue.markBatchSuccess(successBatchId, "txhash");

      const stats = queue.getStats();
      expect(stats.total).toBe(2);
      expect(stats.pending).toBe(0);
      expect(stats.processing).toBe(1);
      expect(stats.success).toBe(1);
    });
  });

  describe("hasPendingOrProcessing", () => {
    test("should return true when there are pending items", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      expect(queue.hasPendingOrProcessing()).toBe(true);
    });

    test("should return true when there are processing items", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(1);
      queue.createSignedTransaction("hash", new Uint8Array([1, 2, 3]), [items[0]!.id]);
      expect(queue.hasPendingOrProcessing()).toBe(true);
    });

    test("should return false when queue is empty", () => {
      expect(queue.hasPendingOrProcessing()).toBe(false);
    });

    test("should return false when all items are successful", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(1);
      const batchId = queue.createSignedTransaction("hash", new Uint8Array([1, 2, 3]), [items[0]!.id]);
      queue.markBatchSuccess(batchId, "txhash");
      expect(queue.hasPendingOrProcessing()).toBe(false);
    });
  });

  describe("getAll", () => {
    test("should return all items without filters", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });
      queue.push({ receiver_account_id: "charlie.testnet", amount: "3000000" });

      const items = queue.getAll();
      expect(items).toHaveLength(3);
    });

    test("should filter by receiver_account_id", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });
      queue.push({ receiver_account_id: "alice.testnet", amount: "3000000" });

      const items = queue.getAll({ receiver_account_id: "alice.testnet" });
      expect(items).toHaveLength(1); // Merged into one due to mergeExistingAccounts
      expect(items[0]!.receiver_account_id).toBe("alice.testnet");
    });

    test("should filter by is_stalled", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });

      const items = queue.pull(2);
      queue.markItemStalled(items[0]!.id, "Test error");

      const stalledItems = queue.getAll({ is_stalled: true });
      expect(stalledItems).toHaveLength(1);
      expect(stalledItems[0]!.receiver_account_id).toBe("alice.testnet");

      const notStalledItems = queue.getAll({ is_stalled: false });
      expect(notStalledItems).toHaveLength(1);
      expect(notStalledItems[0]!.receiver_account_id).toBe("bob.testnet");
    });

    test("should filter by both receiver_account_id and is_stalled", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });
      queue.push({ receiver_account_id: "alice.testnet", amount: "3000000" });

      const items = queue.pull(3);
      queue.markItemStalled(items[0]!.id, "Test error");

      const filtered = queue.getAll({
        receiver_account_id: "alice.testnet",
        is_stalled: true
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.receiver_account_id).toBe("alice.testnet");
      expect(filtered[0]!.is_stalled).toBe(1);
    });

    test("should return items in FIFO order", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });
      queue.push({ receiver_account_id: "charlie.testnet", amount: "3000000" });

      const items = queue.getAll();
      expect(items[0]!.receiver_account_id).toBe("alice.testnet");
      expect(items[1]!.receiver_account_id).toBe("bob.testnet");
      expect(items[2]!.receiver_account_id).toBe("charlie.testnet");
    });

    test("should return empty array when no items match filters", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });

      const items = queue.getAll({ receiver_account_id: "bob.testnet" });
      expect(items).toHaveLength(0);
    });
  });

  describe("unstall operations", () => {
    test("should unstall a single item", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(1);
      queue.markItemStalled(items[0]!.id, "Test error");

      const success = queue.unstallItem(items[0]!.id);
      expect(success).toBe(true);

      const item = queue.getById(items[0]!.id);
      expect(item!.is_stalled).toBe(0);
      expect(item!.batch_id).toBeNull();
    });

    test("should return false when unstalling non-existent item", () => {
      const success = queue.unstallItem(999);
      expect(success).toBe(false);
    });

    test("should return false when unstalling non-stalled item", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const items = queue.pull(1);

      const success = queue.unstallItem(items[0]!.id);
      expect(success).toBe(false);
    });

    test("should unstall multiple items by ids", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });
      queue.push({ receiver_account_id: "charlie.testnet", amount: "3000000" });

      const items = queue.pull(3);
      queue.markItemStalled(items[0]!.id, "Error 1");
      queue.markItemStalled(items[1]!.id, "Error 2");

      const count = queue.unstallItems([items[0]!.id, items[1]!.id]);
      expect(count).toBe(2);

      const item1 = queue.getById(items[0]!.id);
      const item2 = queue.getById(items[1]!.id);
      expect(item1!.is_stalled).toBe(0);
      expect(item2!.is_stalled).toBe(0);
    });

    test("should only unstall stalled items when using unstallItems", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });

      const items = queue.pull(2);
      queue.markItemStalled(items[0]!.id, "Error");

      // Try to unstall both, but only one is stalled
      const count = queue.unstallItems([items[0]!.id, items[1]!.id]);
      expect(count).toBe(1);
    });

    test("should unstall all stalled items", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      queue.push({ receiver_account_id: "bob.testnet", amount: "2000000" });
      queue.push({ receiver_account_id: "charlie.testnet", amount: "3000000" });

      const items = queue.pull(3);
      queue.markItemStalled(items[0]!.id, "Error 1");
      queue.markItemStalled(items[1]!.id, "Error 2");
      queue.markItemStalled(items[2]!.id, "Error 3");

      const count = queue.unstallAll();
      expect(count).toBe(3);

      const stalledItems = queue.getAll({ is_stalled: true });
      expect(stalledItems).toHaveLength(0);

      const notStalledItems = queue.getAll({ is_stalled: false });
      expect(notStalledItems).toHaveLength(3);
    });

    test("should return 0 when unstalling empty array", () => {
      const count = queue.unstallItems([]);
      expect(count).toBe(0);
    });

    test("should return 0 when no stalled items exist for unstallAll", () => {
      queue.push({ receiver_account_id: "alice.testnet", amount: "1000000" });
      const count = queue.unstallAll();
      expect(count).toBe(0);
    });
  });
});

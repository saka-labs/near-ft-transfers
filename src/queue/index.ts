import type { Database } from "bun:sqlite";
import type { TransferRequest, QueueItem } from "../types";
import { QueueStatus } from "../types";
import { EventEmitter } from "events";

export type QueueOptions = {
  mergeExistingAccounts?: boolean;
  defaultHasStorageDeposit?: boolean;
};

export type QueueStats = {
  pending: number;
  processing: number;
  success: number;
  failed: number;
  total: number;
};

export class Queue extends EventEmitter {
  private db: Database;
  private options: QueueOptions;

  constructor(db: Database, options: QueueOptions = {}) {
    super();
    this.db = db;
    this.options = {
      mergeExistingAccounts: options.mergeExistingAccounts ?? true,
      defaultHasStorageDeposit: options.defaultHasStorageDeposit ?? false,
    };
    this.initSchema();
  }

  private initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receiver_account_id TEXT NOT NULL,
        amount TEXT NOT NULL,
        memo TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        retry_count INTEGER DEFAULT 0,
        error_message TEXT,
        batch_id INTEGER,
        is_stalled INTEGER DEFAULT 0,
        has_storage_deposit INTEGER DEFAULT 0
      )
    `);
    // Index for efficient lookup by batch_id
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_batch_id ON queue(batch_id)`);
    // Index for efficient lookup by account_id and batch_id (for deduplication)
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_account_batch ON queue(receiver_account_id, batch_id)`,
    );
    // Index for efficient lookup by is_stalled status
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_is_stalled ON queue(is_stalled)`);

    // Table for storing batch transactions
    this.db.run(`
      CREATE TABLE IF NOT EXISTS batch_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_hash TEXT NOT NULL,
        signed_tx string,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_batch_tx_status ON batch_transactions(status)`,
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_batch_tx_hash ON batch_transactions(tx_hash)`,
    );
  }

  push(transfer: TransferRequest & { has_storage_deposit?: boolean; memo?: string }): number {
    const now = Date.now();
    const hasStorageDeposit = transfer.has_storage_deposit ?? this.options.defaultHasStorageDeposit ?? false;

    const tx = this.db.transaction(() => {
      if (this.options.mergeExistingAccounts) {
        // Check if there's a pending transaction for the same account (batch_id is NULL means pending)
        const existing = this.db
          .query(
            "SELECT id, amount FROM queue WHERE receiver_account_id = ? AND batch_id IS NULL LIMIT 1",
          )
          .get(transfer.receiver_account_id) as {
            id: number;
            amount: string;
          } | null;

        if (existing) {
          // Add amounts together (both are string numbers)
          const newAmount = (
            BigInt(existing.amount) + BigInt(transfer.amount)
          ).toString();
          this.db.run(
            "UPDATE queue SET amount = ?, memo = ?, has_storage_deposit = ?, updated_at = ? WHERE id = ?",
            [newAmount, transfer.memo || null, hasStorageDeposit ? 1 : 0, now, existing.id],
          );
          return existing.id;
        }
      }

      // Create new entry (either merging is disabled or no existing entry found)
      this.db.run(
        "INSERT INTO queue (receiver_account_id, amount, memo, has_storage_deposit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          transfer.receiver_account_id,
          transfer.amount,
          transfer.memo || null,
          hasStorageDeposit ? 1 : 0,
          now,
          now,
        ],
      );
      return this.db.query("SELECT last_insert_rowid() as id").get() as {
        id: number;
      };
    });

    const result = tx();
    const id = typeof result === "number" ? result : result.id;
    this.emit("pushed", id, transfer);
    return id;
  }

  peek(limit: number = 10): QueueItem[] {
    // Get pending items (batch_id is NULL means pending, exclude stalled items)
    const items = this.db
      .query(
        "SELECT * FROM queue WHERE batch_id IS NULL AND is_stalled = 0 ORDER BY id ASC LIMIT ?",
      )
      .all(limit) as QueueItem[];

    if (items.length > 0) {
      this.emit("peeked", items);
    }
    return items;
  }

  createSignedTransaction(
    txHash: string,
    signedTx: string,
    queueIds: number[],
  ): number {
    const now = Date.now();

    const tx = this.db.transaction(() => {
      // Create batch transaction record
      this.db.run(
        "INSERT INTO batch_transactions (tx_hash, signed_tx, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [txHash, signedTx, QueueStatus.PROCESSING, now, now],
      );
      const result = this.db
        .query("SELECT last_insert_rowid() as id")
        .get() as { id: number };
      const batchId = result.id;

      // Associate queue items with this batch
      const placeholders = queueIds.map(() => "?").join(",");
      this.db.run(
        `UPDATE queue SET batch_id = ?, updated_at = ? WHERE id IN (${placeholders})`,
        [batchId, now, ...queueIds],
      );

      return batchId;
    });

    return tx();
  }

  markBatchSuccess(batchId: number, txHash: string) {
    const now = Date.now();
    const items = this.db
      .query("SELECT * FROM queue WHERE batch_id = ?")
      .all(batchId) as QueueItem[];

    const tx = this.db.transaction(() => {
      // Update batch transaction status, store actual tx_hash, and clean up blob
      this.db.run(
        "UPDATE batch_transactions SET status = ?, tx_hash = ?, signed_tx = NULL, updated_at = ? WHERE id = ?",
        [QueueStatus.SUCCESS, txHash, now, batchId],
      );

      // Mark all items in the batch as having storage deposit (since we just successfully processed them)
      this.db.run(
        "UPDATE queue SET has_storage_deposit = 1 WHERE batch_id = ?",
        [batchId],
      );
    });

    tx();
    items.forEach((item) => this.emit("success", item, txHash));
  }

  markItemStalled(itemId: number, errorMessage: string) {
    const now = Date.now();
    this.db.run(
      "UPDATE queue SET is_stalled = 1, error_message = ?, updated_at = ? WHERE id = ?",
      [errorMessage, now, itemId],
    );
  }

  unstallItem(itemId: number): boolean {
    const now = Date.now();
    const item = this.getById(itemId);

    if (!item || !item.is_stalled) {
      return false;
    }

    this.db.run(
      "UPDATE queue SET is_stalled = 0, batch_id = NULL, updated_at = ? WHERE id = ?",
      [now, itemId],
    );
    return true;
  }

  unstallItems(itemIds: number[]): number {
    if (itemIds.length === 0) return 0;

    const now = Date.now();
    const placeholders = itemIds.map(() => "?").join(",");

    const result = this.db.run(
      `UPDATE queue SET is_stalled = 0, batch_id = NULL, updated_at = ? WHERE id IN (${placeholders}) AND is_stalled = 1`,
      [now, ...itemIds],
    );

    return result.changes;
  }

  unstallAll(): number {
    const now = Date.now();
    const result = this.db.run(
      "UPDATE queue SET is_stalled = 0, batch_id = NULL, updated_at = ? WHERE is_stalled = 1",
      [now],
    );

    return result.changes;
  }

  recoverFailedBatch(batchId: number, errorMessage?: string, maxRetries?: number) {
    const now = Date.now();
    const items = this.db
      .query("SELECT * FROM queue WHERE batch_id = ?")
      .all(batchId) as QueueItem[];

    const tx = this.db.transaction(() => {
      // Delete the failed batch transaction record
      this.db.run("DELETE FROM batch_transactions WHERE id = ?", [batchId]);

      if (errorMessage) {
        this.db.run(
          "UPDATE queue SET error_message = ?, updated_at = ? WHERE batch_id = ?",
          [errorMessage, now, batchId],
        );
      }

      // Reset queue items to pending by clearing batch_id and incrementing retry_count
      this.db.run(
        "UPDATE queue SET batch_id = NULL, retry_count = retry_count + 1, updated_at = ? WHERE batch_id = ?",
        [now, batchId],
      );

      // If maxRetries is specified, mark items that exceed retry limit as stalled
      if (maxRetries !== undefined) {
        this.db.run(
          "UPDATE queue SET is_stalled = 1 WHERE batch_id IS NULL AND retry_count > ?",
          [maxRetries],
        );
      }
    });

    tx();
    items.forEach((item) =>
      this.emit("failed", item, errorMessage || "Batch processing failed"),
    );
  }

  getById(id: number): QueueItem | null {
    return this.db
      .query("SELECT * FROM queue WHERE id = ?")
      .get(id) as QueueItem | null;
  }

  getAll(filters?: {
    receiver_account_id?: string;
    is_stalled?: boolean;
  }): QueueItem[] {
    let query = "SELECT * FROM queue WHERE 1=1";
    const params: any[] = [];

    if (filters?.receiver_account_id) {
      query += " AND receiver_account_id = ?";
      params.push(filters.receiver_account_id);
    }

    if (filters?.is_stalled !== undefined) {
      query += " AND is_stalled = ?";
      params.push(filters.is_stalled ? 1 : 0);
    }

    query += " ORDER BY id ASC";

    return this.db.query(query).all(...params) as QueueItem[];
  }

  getBatchTransactionById(batchId: number): { status: string; tx_hash: string } | null {
    return this.db
      .query("SELECT status, tx_hash FROM batch_transactions WHERE id = ?")
      .get(batchId) as { status: string; tx_hash: string } | null;
  }

  getPendingBatchTransactions(): Array<{
    id: number;
    tx_hash: string;
    signed_tx: string;
    queue_ids: number[];
  }> {
    // Get all pending/processing batch transactions
    const batchTxs = this.db
      .query(
        "SELECT id, tx_hash, signed_tx FROM batch_transactions WHERE status = ? AND signed_tx IS NOT NULL",
      )
      .all(QueueStatus.PROCESSING) as Array<{
        id: number;
        tx_hash: string;
        signed_tx: string;
      }>;

    // For each batch transaction, get the associated queue item IDs
    return batchTxs.map((tx) => {
      const queueItems = this.db
        .query("SELECT id FROM queue WHERE batch_id = ?")
        .all(tx.id) as Array<{ id: number }>;

      return {
        ...tx,
        queue_ids: queueItems.map((item) => item.id),
      };
    });
  }

  recover() {
    // Reset any items with pending/processing batches back to pending (recovery mechanism)
    const now = Date.now();
    const tx = this.db.transaction(() => {
      // Reset queue items by clearing batch_id
      this.db.run(
        "UPDATE queue SET batch_id = NULL, updated_at = ? WHERE batch_id IS NOT NULL AND batch_id IN (SELECT id FROM batch_transactions WHERE status IN (?, ?))",
        [now, QueueStatus.PENDING, QueueStatus.PROCESSING],
      );

      // Delete all non-successful batch transactions (we'll recreate them on retry)
      this.db.run("DELETE FROM batch_transactions WHERE status != ?", [
        QueueStatus.SUCCESS,
      ]);
    });

    tx();
  }

  getStats(): QueueStats {
    const stats = this.db
      .query(
        `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN q.batch_id IS NULL THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN bt.status = ? THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN bt.status = ? THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN bt.status = ? THEN 1 ELSE 0 END) as failed
      FROM queue q
      LEFT JOIN batch_transactions bt ON q.batch_id = bt.id
    `,
      )
      .get(
        QueueStatus.PROCESSING,
        QueueStatus.SUCCESS,
        QueueStatus.FAILED,
      ) as QueueStats;

    return stats;
  }

  hasPendingOrProcessing(): boolean {
    const result = this.db
      .query(
        `
      SELECT COUNT(*) as count
      FROM queue q
      LEFT JOIN batch_transactions bt ON q.batch_id = bt.id
      WHERE q.batch_id IS NULL OR bt.status = ?
    `,
      )
      .get(QueueStatus.PROCESSING) as { count: number };

    return result.count > 0;
  }
}

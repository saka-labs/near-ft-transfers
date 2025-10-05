import type { Database } from "bun:sqlite";
import type { TransferRequest, QueueItem } from "../types";
import { QueueStatus } from "../types";
import { EventEmitter } from "events";

export type QueueOptions = {
  mergeExistingAccounts?: boolean;
};

export type QueueStats = {
  pending: number;
  processing: number;
  success: number;
  failed: number;
  total: number;
};

export type QueueEvents = {
  pushed: (id: number, transfer: TransferRequest) => void;
  pulled: (items: QueueItem[]) => void;
  success: (item: QueueItem, txHash: string) => void;
  failed: (item: QueueItem, error: string) => void;
};

export class Queue extends EventEmitter {
  private db: Database;
  private options: QueueOptions;

  constructor(db: Database, options: QueueOptions = {}) {
    super();
    this.db = db;
    this.options = {
      mergeExistingAccounts: options.mergeExistingAccounts ?? true,
    };
    this.initSchema();
  }

  private initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receiver_account_id TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        retry_count INTEGER DEFAULT 0,
        error_message TEXT,
        tx_hash TEXT,
        signed_tx BLOB
      )
    `);
    // Index for efficient pending queries by status
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_status ON queue(status)`);
    // Index for efficient lookup by account_id and status (for deduplication)
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_account_status ON queue(receiver_account_id, status)`,
    );
  }

  push(transfer: TransferRequest): number {
    const now = Date.now();

    const tx = this.db.transaction(() => {
      if (this.options.mergeExistingAccounts) {
        // Check if there's a pending transaction for the same account
        const existing = this.db
          .query(
            "SELECT id, amount FROM queue WHERE receiver_account_id = ? AND status = ? LIMIT 1",
          )
          .get(transfer.receiver_account_id, QueueStatus.PENDING) as {
            id: number;
            amount: string;
          } | null;

        if (existing) {
          // Add amounts together (both are string numbers)
          const newAmount = (
            BigInt(existing.amount) + BigInt(transfer.amount)
          ).toString();
          this.db.run(
            "UPDATE queue SET amount = ?, updated_at = ? WHERE id = ?",
            [newAmount, now, existing.id],
          );
          return existing.id;
        }
      }

      // Create new entry (either merging is disabled or no existing entry found)
      this.db.run(
        "INSERT INTO queue (receiver_account_id, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [
          transfer.receiver_account_id,
          transfer.amount,
          QueueStatus.PENDING,
          now,
          now,
        ],
      );
      return this.db.query("SELECT last_insert_rowid() as id").get() as { id: number };
    });

    const result = tx();
    const id = typeof result === 'number' ? result : result.id;
    this.emit('pushed', id, transfer);
    return id;
  }

  pull(limit: number = 10): QueueItem[] {
    // Atomically get and mark as processing
    const tx = this.db.transaction(() => {
      const rows = this.db
        .query("SELECT * FROM queue WHERE status = ? ORDER BY id ASC LIMIT ?")
        .all(QueueStatus.PENDING, limit) as QueueItem[];

      if (rows.length > 0) {
        const ids = rows.map((r) => r.id).join(",");
        this.db.run(
          `UPDATE queue SET status = ?, updated_at = ? WHERE id IN (${ids})`,
          [QueueStatus.PROCESSING, Date.now()],
        );
      }
      return rows;
    });

    const items = tx();
    if (items.length > 0) {
      this.emit('pulled', items);
    }
    return items;
  }

  markProcessing(id: number, txHash: string, signedTx: Uint8Array) {
    this.db.run("UPDATE queue SET status = ?, tx_hash = ?, signed_tx = ?, updated_at = ? WHERE id = ?", [
      QueueStatus.PROCESSING,
      txHash,
      signedTx,
      Date.now(),
      id,
    ]);
  }

  markBatchProcessing(ids: number[], txHash: string, signedTx: Uint8Array) {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE queue SET status = ?, tx_hash = ?, signed_tx = ?, updated_at = ? WHERE id IN (${placeholders})`,
      [QueueStatus.PROCESSING, txHash, signedTx, Date.now(), ...ids],
    );
  }

  markSuccess(id: number, txHash: string) {
    const item = this.getById(id);
    this.db.run("UPDATE queue SET status = ?, tx_hash = ?, signed_tx = NULL, updated_at = ? WHERE id = ?", [
      QueueStatus.SUCCESS,
      txHash,
      Date.now(),
      id,
    ]);
    if (item) {
      this.emit('success', item, txHash);
    }
  }

  markBatchSuccess(ids: number[], txHash: string) {
    if (ids.length === 0) return;
    const items = this.getByIds(ids);
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE queue SET status = ?, tx_hash = ?, signed_tx = NULL, updated_at = ? WHERE id IN (${placeholders})`,
      [QueueStatus.SUCCESS, txHash, Date.now(), ...ids],
    );
    items.forEach(item => this.emit('success', item, txHash));
  }

  markFailed(id: number, error: string) {
    const item = this.getById(id);
    this.db.run(
      "UPDATE queue SET status = ?, retry_count = retry_count + 1, error_message = ?, signed_tx = NULL, updated_at = ? WHERE id = ?",
      [QueueStatus.FAILED, error, Date.now(), id],
    );
    if (item) {
      this.emit('failed', item, error);
    }
  }

  markBatchFailed(ids: number[], error: string) {
    if (ids.length === 0) return;
    const items = this.getByIds(ids);
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE queue SET status = ?, retry_count = retry_count + 1, error_message = ?, signed_tx = NULL, updated_at = ? WHERE id IN (${placeholders})`,
      [QueueStatus.FAILED, error, Date.now(), ...ids],
    );
    items.forEach(item => this.emit('failed', item, error));
  }

  getById(id: number): QueueItem | null {
    return this.db
      .query("SELECT * FROM queue WHERE id = ?")
      .get(id) as QueueItem | null;
  }

  getByIds(ids: number[]): QueueItem[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .query(`SELECT * FROM queue WHERE id IN (${placeholders})`)
      .all(...ids) as QueueItem[];
  }

  recover() {
    // Reset any PROCESSING and FAILED items back to PENDING on startup (recovery mechanism)
    const now = Date.now();
    this.db.run(
      "UPDATE queue SET status = ?, updated_at = ? WHERE status IN (?, ?)",
      [QueueStatus.PENDING, now, QueueStatus.PROCESSING, QueueStatus.FAILED],
    );
  }

  getStats(): QueueStats {
    const stats = this.db.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as failed
      FROM queue
    `).get(
      QueueStatus.PENDING,
      QueueStatus.PROCESSING,
      QueueStatus.SUCCESS,
      QueueStatus.FAILED
    ) as QueueStats;

    return stats;
  }

  hasPendingOrProcessing(): boolean {
    const result = this.db.query(`
      SELECT COUNT(*) as count
      FROM queue
      WHERE status IN (?, ?)
    `).get(QueueStatus.PENDING, QueueStatus.PROCESSING) as { count: number };

    return result.count > 0;
  }
}

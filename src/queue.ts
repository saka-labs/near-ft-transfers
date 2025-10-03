import type { Database } from "bun:sqlite";
import type { TransferRequest, QueueItem } from "./types";
import { QueueStatus } from "./types";

export class Queue {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
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
        error_message TEXT
      )
    `);
    // Index for efficient pending queries by status
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_status ON queue(status)`);
    // Index for efficient lookup by account_id and status (for deduplication)
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_account_status ON queue(receiver_account_id, status)`,
    );
  }

  push(transfer: TransferRequest) {
    const now = Date.now();

    const tx = this.db.transaction(() => {
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
      } else {
        // Create new entry
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
      }
    });

    tx();
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

    return tx();
  }

  markSuccess(id: number) {
    this.db.run("UPDATE queue SET status = ?, updated_at = ? WHERE id = ?", [
      QueueStatus.SUCCESS,
      Date.now(),
      id,
    ]);
  }

  markFailed(id: number, error: string) {
    this.db.run(
      "UPDATE queue SET status = ?, retry_count = retry_count + 1, error_message = ?, updated_at = ? WHERE id = ?",
      [QueueStatus.FAILED, error, Date.now(), id],
    );
  }
}

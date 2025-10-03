import type { Queue } from "./queue";
import type { QueueItem } from "./types";
import { sleep } from "./utils";

export class Executor {
  private queue: Queue;
  private isRunning = false;
  private batchSize = 100;
  private pollInterval = 1000; // 1 second
  private concurrency = 10; // Process 10 items in parallel

  constructor(queue: Queue) {
    this.queue = queue;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.run();
  }

  stop() {
    this.isRunning = false;
  }

  private async run() {
    while (this.isRunning) {
      try {
        const items = this.queue.pull(this.batchSize);

        if (items.length > 0) {
          await this.processBatch(items);
        }

        // Wait before next poll
        await sleep(this.pollInterval);
      } catch (error) {
        console.error("Executor error:", error);
        await sleep(this.pollInterval);
      }
    }
  }

  private async processBatch(items: QueueItem[]) {
    // Process with controlled concurrency
    const chunks = this.chunk(items, this.concurrency);

    for (const chunk of chunks) {
      await Promise.all(chunk.map((item) => this.processItem(item)));
    }
  }

  private async processItem(item: QueueItem) {
    try {
      // TODO: Actual transfer logic here
      await this.executeTransfer(item);
      this.queue.markSuccess(item.id);
    } catch (error) {
      this.queue.markFailed(item.id, String(error));
    }
  }

  private async executeTransfer(item: QueueItem) {
    // Placeholder for actual NEAR transfer
    console.log(`Transferring ${item.amount} to ${item.receiver_account_id}`);
  }

  private chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

import { Account } from "@near-js/accounts";
import type { Queue } from "../queue";
import type { QueueItem } from "../types";
import { JsonRpcProvider, type Provider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { actionCreators } from "@near-js/transactions";
import { sleep } from "bun";

export type ExecutorOptions = {
  rpcUrl: string;
  accountId: string;
  contractId: string;
  privateKey: string;
  batchSize?: number;
  interval?: number;
};

export class Executor {
  private queue: Queue;
  private isRunning = false;
  private idleResolvers: (() => void)[] = [];

  private options: ExecutorOptions;

  private account: Account;

  constructor(
    queue: Queue,
    { batchSize = 100, interval = 1000, ...options }: ExecutorOptions,
  ) {
    if (batchSize < 1 || batchSize > 100) {
      throw new Error("batchSize must be between 1 and 100");
    }

    this.queue = queue;
    this.options = {
      ...options,
      batchSize,
      interval,
    };

    this.account = new Account(
      this.options.accountId,
      new JsonRpcProvider({ url: this.options.rpcUrl }) as Provider,
      new KeyPairSigner(
        KeyPair.fromString(this.options.privateKey as KeyPairString),
      ),
    );
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.run();
  }

  stop() {
    this.isRunning = false;
  }

  async waitUntilIdle(): Promise<void> {
    // If already idle, resolve immediately
    if (!this.queue.hasPendingOrProcessing()) {
      return Promise.resolve();
    }

    // Wait for queue to become idle
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private async run() {
    while (this.isRunning) {
      try {
        const items = this.queue.pull(this.options.batchSize);
        if (items.length > 0) {
          await this.processBatch(items);
        }

        // Check if queue is idle and notify waiters
        if (!this.queue.hasPendingOrProcessing() && this.idleResolvers.length > 0) {
          const resolvers = [...this.idleResolvers];
          this.idleResolvers = [];
          resolvers.forEach((resolve) => resolve());
        }

        // Wait before next poll
        // TODO: next pool should be interval - processBatch time
        await sleep(this.options.interval!);
      } catch (error) {
        console.error("Executor error:", error);
        await sleep(this.options.interval!);
      }
    }
  }

  private async processBatch(items: QueueItem[]) {
    try {
      console.log(`Processing batch of ${items.length} items...`);

      const result = await this.account.signAndSendTransaction({
        receiverId: this.options.contractId,
        actions: items.map((item) =>
          this.createAction(item.receiver_account_id, item.amount),
        ),
      });
      console.log("Transaction result:", result.status);

      // Extract transaction hash from result
      const txHash = result.transaction.hash;
      console.log("Transaction hash:", txHash);

      for (const item of items) {
        this.queue.markSuccess(item.id, txHash);
      }
    } catch (error) {
      for (const item of items) {
        this.queue.markFailed(item.id, String(error));
      }
    }
  }

  private createAction(receiverId: string, amount: string) {
    return actionCreators.functionCall(
      "ft_transfer",
      {
        receiver_id: receiverId,
        amount: amount,
        memo: null, // TODO: handle memo
      },
      1000000000000n * 3n, // Gas:  3 TGas, max TGas per transaction is 300TGas, max action per transaction is 100, 300 / 100 = 3 TGas
      1n, // Attached deposit: 1 yoctoNEAR
    );
  }
}

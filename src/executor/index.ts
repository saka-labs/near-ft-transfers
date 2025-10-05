import { Account } from "@near-js/accounts";
import type { Queue } from "../queue";
import type { QueueItem } from "../types";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { actionCreators } from "@near-js/transactions";
import { sleep } from "bun";
import { sha256Bs58 } from "../utils";

export type ExecutorOptions = {
  rpcUrl: string;
  accountId: string;
  contractId: string;
  privateKeys: string | string[];
  batchSize?: number;
  interval?: number;
  minQueueToProcess?: number;
};

export class Executor {
  private queue: Queue;
  private isRunning = false;
  private idleResolvers: (() => void)[] = [];

  private options: ExecutorOptions;

  private accounts: Account[];
  private jsonRpcProvider: JsonRpcProvider;

  constructor(
    queue: Queue,
    {
      batchSize = 100,
      interval = 500,
      minQueueToProcess = 1,
      ...options
    }: ExecutorOptions
  ) {
    if (batchSize < 1 || batchSize > 100) {
      throw new Error("batchSize must be between 1 and 100");
    }

    this.queue = queue;
    this.options = {
      ...options,
      batchSize,
      interval,
      minQueueToProcess,
    };

    this.jsonRpcProvider = new JsonRpcProvider({ url: this.options.rpcUrl });

    const privateKeys = Array.isArray(this.options.privateKeys)
      ? this.options.privateKeys
      : [this.options.privateKeys];

    this.accounts = privateKeys.map(
      (privateKey) =>
        new Account(
          this.options.accountId,
          this.jsonRpcProvider,
          new KeyPairSigner(KeyPair.fromString(privateKey as KeyPairString))
        )
    );

    console.log(
      `Executor initialized with ${this.accounts.length} signer(s) for account ${this.options.accountId}`
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
        const startTime = Date.now();

        // Pull multiple batches (one per signer) and process in parallel
        const batches: Array<{ items: QueueItem[]; accountIndex: number }> = [];

        for (let i = 0; i < this.accounts.length; i++) {
          const items = this.queue.pull(this.options.batchSize);
          if (items.length >= this.options.minQueueToProcess!) {
            batches.push({ items, accountIndex: i });
          }
        }

        // Process all batches in parallel using different signers
        if (batches.length > 0) {
          await Promise.all(
            batches.map(async ({ items, accountIndex }, batchIndex) => {
              const account = this.accounts[accountIndex];
              if (!account) {
                throw new Error(`No account found at index ${accountIndex}`);
              }
              // Stagger transaction creation to avoid block hash conflicts
              // Each signer waits a bit to ensure they get different block hashes
              // TODO: remove this once we have a better way to handle block hash conflicts
              if (batchIndex > 0) {
                await sleep(100 * batchIndex); // 100ms stagger
              }
              return this.processBatch(items, account, accountIndex);
            })
          );
        }

        const processTime = Date.now() - startTime;

        // Check if queue is idle and notify waiters
        if (
          !this.queue.hasPendingOrProcessing() &&
          this.idleResolvers.length > 0
        ) {
          const resolvers = [...this.idleResolvers];
          this.idleResolvers = [];
          resolvers.forEach((resolve) => resolve());
        }

        // Wait before next poll, adjusted for processing time
        const sleepTime = Math.max(0, this.options.interval! - processTime);
        await sleep(sleepTime);
      } catch (error) {
        console.error("Executor error:", error);
        await sleep(this.options.interval!);
      }
    }
  }

  private async processBatch(
    items: QueueItem[],
    account: Account,
    signerIndex: number
  ) {
    const itemIds = items.map((item) => item.id);

    try {
      console.log(
        `Processing batch of ${items.length} items with signer #${signerIndex}...`
      );

      const actions = items.map((item) =>
        this.createAction(item.receiver_account_id, item.amount)
      );

      const signed = await account.createSignedTransaction(
        this.options.contractId,
        actions
      );
      const signedHash = await sha256Bs58(signed.transaction.encode());

      console.log("Signed hash:", signedHash);
      this.queue.markBatchProcessing(itemIds, signedHash);

      const result = await this.jsonRpcProvider.sendTransaction(signed);

      // signedHash and txHash should be exactly the same, just to be sure
      const txHash = result.transaction.hash;
      console.log("Transaction hash:", txHash);

      this.queue.markBatchSuccess(itemIds, txHash);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (
        errorMessage.includes(
          "parent block hash doesn't belong to the current chain"
        ) ||
        errorMessage.includes("Expired transaction") ||
        errorMessage.includes("InvalidNonce")
      ) {
        console.warn(
          `⚠️  Recoverable error for signer #${signerIndex} (will retry): ${errorMessage}`
        );
        this.queue.markBatchPending(itemIds);
        return;
      }

      this.queue.markBatchFailed(itemIds, errorMessage);
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
      1n // Attached deposit: 1 yoctoNEAR
    );
  }
}

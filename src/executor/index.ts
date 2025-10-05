import { Account } from "@near-js/accounts";
import type { Queue } from "../queue";
import type { QueueItem, TransactionStatus } from "../types";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { actionCreators, SignedTransaction } from "@near-js/transactions";
import { sleep } from "bun";
import { sha256Bs58 } from "../utils";
import { EventEmitter } from "events";

export type ExecutorOptions = {
  rpcUrl: string;
  accountId: string;
  contractId: string;
  privateKey: string;
  batchSize?: number;
  interval?: number;
  minQueueToProcess?: number;
};

export type ExecutorEvents = {
  batchProcessed: (itemCount: number, success: boolean) => void;
  batchFailed: (itemCount: number, error: string) => void;
  loopCompleted: () => void;
};

export interface Executor {
  on<K extends keyof ExecutorEvents>(event: K, listener: ExecutorEvents[K]): this;
  once<K extends keyof ExecutorEvents>(event: K, listener: ExecutorEvents[K]): this;
  emit<K extends keyof ExecutorEvents>(event: K, ...args: Parameters<ExecutorEvents[K]>): boolean;
}

export class Executor extends EventEmitter {
  private queue: Queue;
  private isRunning = false;
  private idleResolvers: (() => void)[] = [];

  private options: ExecutorOptions;

  private account: Account;
  private jsonRpcProvider: JsonRpcProvider;

  constructor(
    queue: Queue,
    {
      batchSize = 100,
      interval = 500,
      minQueueToProcess = 1,
      ...options
    }: ExecutorOptions,
  ) {
    super();

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
    this.account = new Account(
      this.options.accountId,
      this.jsonRpcProvider,
      new KeyPairSigner(
        KeyPair.fromString(this.options.privateKey as KeyPairString),
      ),
    );
  }

  async start() {
    if (this.isRunning) return;
    await this.recoverProcessingTransactions();
    this.queue.recover();
    this.isRunning = true;
    this.run();
  }

  private async recoverProcessingTransactions() {
    const processingTxs = this.queue.getPendingSignedTransactions();

    if (processingTxs.length === 0) {
      console.info("No pending signed transactions to recover");
      return;
    }

    console.info(
      `Recovering ${processingTxs.length} processing signed transactions...`,
    );

    for (const tx of processingTxs) {
      try {
        console.info(
          `Re-broadcasting transaction ${tx.tx_hash} for queue items [${tx.queue_ids.join(", ")}]`,
        );

        // Decode the signed transaction and re-broadcast it
        const result = await this.jsonRpcProvider.sendTransaction(
          SignedTransaction.decode(tx.signed_tx),
        );
        const txHash = result.transaction.hash;

        console.info(`Successfully re-broadcast transaction: ${txHash}`);
        this.queue.markBatchSuccess(tx.id, txHash);
      } catch (error) {
        console.error(
          `Failed to re-broadcast transaction ${tx.tx_hash}:`,
          error,
        );
        this.queue.recoverFailedBatch(
          tx.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    console.info("Recovery complete");
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
        const items = this.queue.pull(this.options.batchSize);
        if (items.length >= this.options.minQueueToProcess!) {
          await this.processBatch(items);
        }
        const processTime = Date.now() - startTime;

        // Emit loop completed event
        this.emit('loopCompleted');

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

  private async processBatch(items: QueueItem[]) {
    const itemIds = items.map((item) => item.id);
    let batchId;

    try {
      console.info(`Processing batch of ${items.length} items...`);

      const actions = items.map((item) =>
        this.createAction(item.receiver_account_id, item.amount),
      );

      const signed = await this.account.createSignedTransaction(
        this.options.contractId,
        actions,
      );
      const signedHash = await sha256Bs58(signed.transaction.encode());

      // Create signed transaction record and associate with queue items in a transaction
      batchId = this.queue.createSignedTransaction(
        signedHash,
        signed.encode(),
        itemIds,
      );

      const result = await this.jsonRpcProvider.sendTransaction(signed);
      const status = result.status as TransactionStatus;
      if (status.Failure) {
        if (status.Failure.ActionError) {
          const actionIndex = status.Failure.ActionError.index;
          const kind = status.Failure.ActionError.kind;
          const errorMessage = JSON.stringify(kind);
          console.info({ kind, errorMessage });

          if (actionIndex !== undefined) {
            const item = items[actionIndex]!;

            // Mark the specific item as stalled
            this.queue.markItemStalled(item.id, errorMessage);

            this.queue.recoverFailedBatch(batchId);
          } else {
            this.queue.recoverFailedBatch(batchId, errorMessage);
          }

          this.emit('batchFailed', items.length, errorMessage);
          return;
        }

        if (status.Failure.InvalidTxError) {
          const errorMessage = JSON.stringify(status.Failure.InvalidTxError);
          this.queue.recoverFailedBatch(batchId, errorMessage);
          this.emit('batchFailed', items.length, errorMessage);
          return;
        }
      }

      // signedHash and txHash should be exactly the same, just to be sure
      const txHash = result.transaction.hash;
      console.info("Transaction hash:", txHash);

      this.queue.markBatchSuccess(batchId, txHash);
      this.emit('batchProcessed', items.length, true);
    } catch (error) {
      console.error("Failed to process batch:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (batchId) {
        // Recovery mechanism will reset items to pending
        this.queue.recoverFailedBatch(batchId, errorMessage);
      }
      this.emit('batchFailed', items.length, errorMessage);
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

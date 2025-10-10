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
  maxRetries?: number;
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
      maxRetries = 5,
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
      maxRetries,
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
    const batchTxs = this.queue.getPendingBatchTransactions();

    if (batchTxs.length === 0) {
      console.info("No pending batch transactions to recover");
      return;
    }

    console.info(
      `Recovering ${batchTxs.length} batch transactions...`,
    );

    for (const batch of batchTxs) {
      try {
        console.info(
          `Re-broadcasting transaction ${batch.tx_hash} for queue items [${batch.queue_ids.join(", ")}]`,
        );

        // Decode the signed transaction and re-broadcast it
        const result = await this.jsonRpcProvider.sendTransaction(
          SignedTransaction.decode(batch.signed_tx),
        );

        // Validate transaction result
        const validation = this.validateTransactionResult(result, batch.id);
        if (!validation.isValid) {
          console.error(
            `Re-broadcast transaction ${batch.tx_hash} failed validation: ${validation.errorMessage}`,
          );
          continue;
        }

        const txHash = result.transaction.hash;
        console.info(`Successfully re-broadcast transaction: ${txHash}`);
        this.queue.markBatchSuccess(batch.id, txHash);
      } catch (error) {
        this.handleBroadcastError(
          error,
          batch.id,
          `Failed to re-broadcast transaction ${batch.tx_hash}`,
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
        const items = this.queue.peek(this.options.batchSize);
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
    // Filter items to fit within 100 action limit
    // Each item needs 1 action (ft_transfer) or 2 actions (storage_deposit + ft_transfer)
    const MAX_ACTIONS = 100;
    let actionCount = 0;
    const itemsToProcess: QueueItem[] = [];

    for (const item of items) {
      const actionsNeeded = item.has_storage_deposit ? 1 : 2;
      if (actionCount + actionsNeeded <= MAX_ACTIONS) {
        itemsToProcess.push(item);
        actionCount += actionsNeeded;
      } else {
        // Can't fit more items, stop here
        break;
      }
    }

    // If we couldn't process any items due to action limit, this shouldn't happen
    // but handle it gracefully
    if (itemsToProcess.length === 0) {
      console.warn("No items could fit in batch due to action limit");
      return;
    }

    const itemIds = itemsToProcess.map((item) => item.id);
    let batchId;

    try {
      console.info(`Processing batch of ${items.length} items...`);

      // Create actions for each item, including storage deposit if needed
      const actions = itemsToProcess.flatMap((item) =>
        this.createActionsForItem(
          item.receiver_account_id,
          item.amount,
          Boolean(item.has_storage_deposit),
        ),
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

      // Validate transaction result
      const validation = this.validateTransactionResult(result, batchId, items);
      if (!validation.isValid) {
        this.emit('batchFailed', items.length, validation.errorMessage!);
        return;
      }

      // signedHash and txHash should be exactly the same, just to be sure
      const txHash = result.transaction.hash;
      console.info("Transaction hash:", txHash);

      this.queue.markBatchSuccess(batchId, txHash);
      this.emit('batchProcessed', items.length, true);
    } catch (error) {
      const errorMessage = this.handleBroadcastError(error, batchId, "Failed to process batch");
      this.emit('batchFailed', items.length, errorMessage);
    }
  }

  private validateTransactionResult(
    result: any,
    batchId: number,
    items?: QueueItem[],
  ): { isValid: boolean; errorMessage?: string } {
    const status = result.status as TransactionStatus;

    if (!status.Failure) {
      return { isValid: true };
    }

    if (status.Failure.ActionError) {
      const actionIndex = status.Failure.ActionError.index;
      const kind = status.Failure.ActionError.kind;
      const errorMessage = JSON.stringify(kind);
      console.info({ kind, errorMessage });

      if (actionIndex !== undefined && items) {
        const item = items[actionIndex]!;
        // Mark the specific item as stalled
        this.queue.markItemStalled(item.id, errorMessage);
        this.queue.recoverFailedBatch(batchId, undefined, this.options.maxRetries);
      } else {
        this.queue.recoverFailedBatch(batchId, errorMessage, this.options.maxRetries);
      }

      return { isValid: false, errorMessage };
    }

    if (status.Failure.InvalidTxError) {
      const errorMessage = JSON.stringify(status.Failure.InvalidTxError);
      this.queue.recoverFailedBatch(batchId, errorMessage, this.options.maxRetries);
      return { isValid: false, errorMessage };
    }

    return { isValid: true };
  }

  private handleBroadcastError(
    error: unknown,
    batchId: number | undefined,
    context: string,
  ): string {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`${context}:`, error);

    if (batchId) {
      this.queue.recoverFailedBatch(batchId, errorMessage, this.options.maxRetries);
    }

    return errorMessage;
  }

  private createActionsForItem(
    receiverId: string,
    amount: string,
    hasStorageDeposit: boolean,
  ) {
    const actions = [];

    if (!hasStorageDeposit) {
      actions.push(
        actionCreators.functionCall(
          "storage_deposit",
          {
            account_id: receiverId,
            registration_only: true,
          },
          1000000000000n * 3n, // Gas:  3 TGas
          1250000000000000000000n, // 0.00125 NEAR (typical NEP-141 storage deposit)
        ),
      );
    }

    // Add ft_transfer action
    actions.push(
      actionCreators.functionCall(
        "ft_transfer",
        {
          receiver_id: receiverId,
          amount: amount,
          memo: null,
        },
        1000000000000n * 3n, // Gas:  3 TGas
        1n, // 1 yoctoNEAR
      ),
    );

    return actions;
  }
}

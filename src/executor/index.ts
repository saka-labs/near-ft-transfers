import type { Queue } from "../queue";
import type { QueueItem, TransactionStatus } from "../types";
import { sleep } from "bun";
import { EventEmitter } from "events";
import {
  createClient,
  createMemoryKeyService,
  testnet,
  mainnet,
  createMemorySigner,
  functionCall,
} from '@eclipseeer/near-api-ts';

export type ExecutorOptions = {
  rpcUrl: string;
  accountId: string;
  contractId: string;

  privateKeys: string[];
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
  on<K extends keyof ExecutorEvents>(
    event: K,
    listener: ExecutorEvents[K],
  ): this;
  once<K extends keyof ExecutorEvents>(
    event: K,
    listener: ExecutorEvents[K],
  ): this;
  emit<K extends keyof ExecutorEvents>(
    event: K,
    ...args: Parameters<ExecutorEvents[K]>
  ): boolean;
}

export class Executor extends EventEmitter {
  private queue: Queue;
  private isRunning = false;
  private idleResolvers: (() => void)[] = [];

  private options: ExecutorOptions;

  private signer?: Awaited<ReturnType<typeof createMemorySigner>>;
  private client: Awaited<ReturnType<typeof createClient>>;

  private maxConcurrency: number;

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

    if (!options.privateKeys || options.privateKeys.length === 0) {
      throw new Error("At least one private key is required");
    }

    this.queue = queue;
    this.options = {
      ...options,
      batchSize,
      interval,
      minQueueToProcess,
      maxRetries,
    };

    this.maxConcurrency = this.options.privateKeys.length;

    console.info(`Executor initialized with ${this.options.privateKeys.length} signing key(s) (concurrency: ${this.maxConcurrency})`);

    const network = this.getNetworkConfig();
    this.client = createClient({ network });
  }

  private getNetworkConfig() {
    if (this.options.rpcUrl.includes('testnet') || this.options.rpcUrl.includes('test')) {
      return testnet;
    } else if (this.options.rpcUrl.includes('localhost') || this.options.rpcUrl.includes('127.0.0.1')) {
      return {
        rpcs: {
          regular: [{ url: this.options.rpcUrl }],
          archival: [{ url: this.options.rpcUrl }],
        },
      };
    } else {
      return mainnet;
    }
  }

  private async initializeSigner() {
    const privateKeys = this.options.privateKeys;

    console.info(`Initializing signer with ${privateKeys.length} key(s)...`);

    const keyService = await createMemoryKeyService({
      keySources: privateKeys.map(key => ({ privateKey: key as any })),
    });

    this.signer = await createMemorySigner({
      signerAccountId: this.options.accountId,
      client: this.client,
      keyService,
    });

    console.info(`Signer initialized successfully with ${privateKeys.length} key(s) in pool`);
  }

  async start() {
    if (this.isRunning) return;

    await this.initializeSigner();
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

    console.info(`Recovering ${batchTxs.length} batch transactions...`);

    for (const batch of batchTxs) {
      try {
        console.info(
          `Re-broadcasting transaction ${batch.tx_hash} for queue items [${batch.queue_ids.join(", ")}]`,
        );

        // TODO: Implement recovery logic near-api-ts
        // Mark the batch as failed so items can be retried
        this.queue.recoverFailedBatch(
          batch.id,
          "Recovery not supported with near-api-ts yet - marking for retry",
          this.options.maxRetries,
        );
      } catch (error) {
        await this.handleBroadcastError(
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
        const totalItemsNeeded = this.maxConcurrency * this.options.batchSize!;
        const allItems = this.queue.peek(totalItemsNeeded);

        if (allItems.length >= this.options.minQueueToProcess!) {
          const batchPromises: Promise<void>[] = [];

          for (let i = 0; i < this.maxConcurrency; i++) {
            const startIdx = i * this.options.batchSize!;
            const endIdx = startIdx + this.options.batchSize!;
            const batchItems = allItems.slice(startIdx, endIdx);

            if (batchItems.length < this.options.minQueueToProcess!) {
              break; // Not enough items for this batch
            }

            // Process batch in parallel
            const batchPromise = this.processBatch(batchItems);
            batchPromises.push(batchPromise);
          }

          // Wait for all batches to complete
          if (batchPromises.length > 0) {
            await Promise.allSettled(batchPromises);
          }
        }
        const processTime = Date.now() - startTime;

        // Emit loop completed event
        this.emit("loopCompleted");

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
      console.info(`Processing batch of ${itemsToProcess.length} items...`);

      if (!this.signer) {
        throw new Error("Signer not initialized");
      }

      // Create actions for each item, including storage deposit if needed
      const actions = itemsToProcess.flatMap((item) =>
        this.createActionsForItem(
          item.receiver_account_id,
          item.amount,
          Boolean(item.has_storage_deposit),
          item.memo,
        ),
      );

      // Create a placeholder batch record (we don't have the tx hash yet)
      const signedTx = await this.signer.signTransaction({
        actions,
        receiverAccountId: this.options.contractId,
      });

      batchId = this.queue.createSignedTransaction(
        signedTx.transactionHash,
        signedTx.signature as any,
        itemIds,
      );

      // Execute transaction using near-api-ts
      const result = await this.client.sendSignedTransaction({
        signedTransaction: signedTx
      })

      // Validate transaction result
      const validation = this.validateTransactionResult(result, batchId, items);
      if (!validation.isValid) {
        this.emit("batchFailed", items.length, validation.errorMessage!);
        return;
      }

      const txHash = result.transaction.hash;
      console.info("Transaction hash:", txHash);

      this.queue.markBatchSuccess(batchId, txHash);
      this.emit("batchProcessed", items.length, true);
    } catch (error) {
      const errorMessage = await this.handleBroadcastError(
        error,
        batchId,
        "Failed to process batch",
      );
      this.emit("batchFailed", items.length, errorMessage);
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
        this.queue.recoverFailedBatch(
          batchId,
          undefined,
          this.options.maxRetries,
        );
      } else {
        this.queue.recoverFailedBatch(
          batchId,
          errorMessage,
          this.options.maxRetries,
        );
      }

      return { isValid: false, errorMessage };
    }

    if (status.Failure.InvalidTxError) {
      const errorMessage = JSON.stringify(status.Failure.InvalidTxError);
      this.queue.recoverFailedBatch(
        batchId,
        errorMessage,
        this.options.maxRetries,
      );
      return { isValid: false, errorMessage };
    }

    return { isValid: true };
  }

  private async handleBroadcastError(
    error: unknown,
    batchId: number | undefined,
    context: string,
  ): Promise<string> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`${context}:`, error);

    if (batchId) {
      this.queue.recoverFailedBatch(
        batchId,
        errorMessage,
        this.options.maxRetries,
      );
    }

    await sleep(5000);
    return errorMessage;
  }

  private createActionsForItem(
    receiverId: string,
    amount: string,
    hasStorageDeposit: boolean,
    memo: string | null,
  ) {
    const actions = [];

    if (!hasStorageDeposit) {
      actions.push(
        functionCall({
          functionName: "storage_deposit",
          fnArgsJson: {
            account_id: receiverId,
            registration_only: true,
          },
          attachedDeposit: { yoctoNear: 1250000000000000000000n }, // 0.00125 NEAR
          gasLimit: { teraGas: '3' }, // 3 TGas
        }),
      );
    }

    // Add ft_transfer action
    actions.push(
      functionCall({
        functionName: "ft_transfer",
        fnArgsJson: {
          receiver_id: receiverId,
          amount: amount,
          memo,
        },
        attachedDeposit: { yoctoNear: 1n }, // 1 yoctoNEAR
        gasLimit: { teraGas: '3' }, // 3 TGas
      }),
    );

    return actions;
  }
}

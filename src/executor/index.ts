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
  privateKey: string;
  batchSize?: number;
  interval?: number;
  minQueueToProcess?: number;
};

export class Executor {
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

  start() {
    if (this.isRunning) return;
    this.queue.recover();
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
        const items = this.queue.pull(this.options.batchSize);
        if (items.length >= this.options.minQueueToProcess!) {
          await this.processBatch(items);
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

  private async processBatch(items: QueueItem[]) {
    const itemIds = items.map((item) => item.id);

    try {
      console.log(`Processing batch of ${items.length} items...`);

      const actions = items.map((item) =>
        this.createAction(item.receiver_account_id, item.amount),
      );

      const signed = await this.account.createSignedTransaction(
        this.options.contractId,
        actions,
      );
      const signedEncoded = signed.transaction.encode();
      const signedHash = await sha256Bs58(signedEncoded);

      this.queue.markBatchProcessing(itemIds, signedHash, signedEncoded);

      const result = await this.jsonRpcProvider.sendTransaction(signed);

      // signedHash and txHash should be exactly the same, just to be sure
      const txHash = result.transaction.hash;
      console.log("Transaction hash:", txHash);

      this.queue.markBatchSuccess(itemIds, txHash);
    } catch (error) {
      this.queue.markBatchFailed(itemIds, String(error));
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

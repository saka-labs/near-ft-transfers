import { Account } from "@near-js/accounts";
import type { Queue } from "../queue";
import type { QueueItem } from "../types";
import { sleep } from "../utils";
import { JsonRpcProvider, type Provider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { actionCreators } from "@near-js/transactions";

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

  private async run() {
    while (this.isRunning) {
      try {
        const items = this.queue.pull(this.options.batchSize);
        if (items.length > 0) {
          await this.processBatch(items);
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

      for (const item of items) {
        this.queue.markSuccess(item.id);
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

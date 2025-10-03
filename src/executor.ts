import type { Queue } from "./queue";
import type { TransferRequest } from "./types";

export class Executor {
  private queue: Queue;
  constructor(queue: Queue) {
    this.queue = queue;
  }

  async push(transfer: TransferRequest) {
    console.log("pushing transfer to queue:", transfer);
  }
}

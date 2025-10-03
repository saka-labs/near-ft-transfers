import type { Queue } from "./queue";
import type { TransferRequest } from "./types";

export class Executor {
  private queue: Queue;
  constructor(queue: Queue) {
    this.queue = queue;
  }
}

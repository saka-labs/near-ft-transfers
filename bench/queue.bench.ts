import { Database } from "bun:sqlite";
import { Queue } from "../src/queue";
import type { TransferRequest } from "../src/types";

// Configuration
const PUSH_COUNT = Number(process.env.BENCH_PUSH_COUNT) || 100000;
const PEEK_COUNT = Number(process.env.BENCH_PEEK_COUNT) || 100;

const db = new Database(":memory:");
const queue = new Queue(db);

// Benchmark push
console.time(`Push ${PUSH_COUNT} items`);
for (let i = 0; i < PUSH_COUNT; i++) {
  const transfer: TransferRequest = {
    receiver_account_id: `user${i}.near`,
    amount: `${i}000000000000000000000000`,
  };
  queue.push(transfer);
}
console.timeEnd(`Push ${PUSH_COUNT} items`);

// Benchmark peek
console.time(`Peek ${PEEK_COUNT} items`);
const peeked = queue.peek(PEEK_COUNT);
console.timeEnd(`Peek ${PEEK_COUNT} items`);

console.info(`Peeked ${peeked.length} items`);

// Verify data
console.info("\nFirst item:", peeked[0]);
console.info("Last item:", peeked[peeked.length - 1]);

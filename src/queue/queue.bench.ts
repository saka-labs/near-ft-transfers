import { Database } from "bun:sqlite";
import { Queue } from ".";
import type { TransferRequest } from "../types";

// Configuration
const PUSH_COUNT = Number(process.env.BENCH_PUSH_COUNT) || 10;
const PULL_COUNT = Number(process.env.BENCH_PULL_COUNT) || 10;

const db = new Database(":memory:");
const queue = new Queue(db);

// Benchmark push
console.time(`Push ${PUSH_COUNT} items`);
for (let i = 0; i < PUSH_COUNT; i++) {
  const transfer: TransferRequest = {
    receiver_account_id: `user${i}.testnet`,
    amount: `${i}000000000000000000000000`,
  };
  queue.push(transfer);
}
console.timeEnd(`Push ${PUSH_COUNT} items`);

// Benchmark pull
console.time(`Pull ${PULL_COUNT} items`);
const pulled = queue.pull(PULL_COUNT);
console.timeEnd(`Pull ${PULL_COUNT} items`);

console.log(`Pulled ${pulled.length} items`);

// Verify data
console.log("\nFirst item:", pulled[0]);
console.log("Last item:", pulled[pulled.length - 1]);

import { JsonRpcProvider } from "@near-js/providers";
import { Database } from "bun:sqlite";
import { Queue } from "../src/queue";
import { Executor } from "../src/executor";

async function runBenchmark() {
  const TRANSFER_COUNT = 1000;
  const AMOUNT_PER_TRANSFER = 100;
  const BATCH_SIZE = 100;

  // Provide your own NEAR account details here
  const RPC_URL = "https://test.rpc.fastnear.com";
  const NEAR_ACCOUNT_ID = "saka-labs.testnet";
  const NEAR_CONTRACT_ID = "saka-labs.testnet";

  // Multiple private keys for parallel processing
  // Add more keys to increase concurrency
  const NEAR_PRIVATE_KEYS = [
    "ed25519:24VKtS9FZCR1pMgj2q3mAHcrrqC1pAaNbXwPWru86Jqm3fCLkBmqs8U3kq8o6ToEo9uZiJe6AaK9kcZPTwZJPo34",
    "ed25519:3cL4t9ZLznwJAJ2unVFigSwWoYxavTrJnCGPoWjtnq1YWCbg4BQYNdhvxW9md7qfpwUan7eCJesmsqMQdnaJRhxf",
    "ed25519:588epj9ZMhdYhqwmpqWvoxu4GeL1CS9QzF6BMQsQkpUMyj6SzeBe2V4tFwT7N9YqWCbuc5HagTD9fjUpTFHa4XZs",
    "ed25519:4PHTkvVJVJCXHm1bTjNqk43GsrhJgj9FYbzd9Qe248Vc5Eiitp4QWpmr2x1L8gnYcyC5Z7GDPku6DTdkZKFjoj7d",
    "ed25519:K9aE4rmsk4N5GZX2oe98u2sJ3cyieoyT5JDJjhdWAPz6tpH8NKBGpf54XoY6hSw5RxRQBobULXSbhtiRJQEYQ1i"
    // Add more private keys here for parallel processing:
    // "ed25519:YourSecondKey...",
    // "ed25519:YourThirdKey...",
  ];

  // This should be already has a storage deposit
  const NEAR_RECEIVER_ACCOUNT_ID = "jinakayam.testnet";

  console.info("===== NEAR FT Transfer Benchmark =====");
  console.info(`Transfer count: ${TRANSFER_COUNT}`);
  console.info(`Batch size: ${BATCH_SIZE}`);
  console.info(`Amount per transfer: ${AMOUNT_PER_TRANSFER}`);
  console.info(`Private keys (concurrency): ${NEAR_PRIVATE_KEYS.length}`);
  console.info("=====================================\n");

  const provider = new JsonRpcProvider({ url: RPC_URL });

  // Initialize queue and executor
  const db = new Database(":memory:");
  const queue = new Queue(db, { mergeExistingAccounts: false });

  const executor = new Executor(queue, {
    rpcUrl: RPC_URL,
    accountId: NEAR_ACCOUNT_ID,
    contractId: NEAR_CONTRACT_ID,
    privateKeys: NEAR_PRIVATE_KEYS, // Multiple keys for parallel processing
    batchSize: BATCH_SIZE,
    interval: 100,
  });

  const initialBalance = await provider.callFunction(
    NEAR_CONTRACT_ID,
    "ft_balance_of",
    { account_id: NEAR_RECEIVER_ACCOUNT_ID },
  );

  console.info(`Initial balance: ${initialBalance}`);
  console.info(`Pushing ${TRANSFER_COUNT} items to queue...`);

  // Benchmark: Push transfers
  const pushStartTime = Date.now();
  for (let i = 0; i < TRANSFER_COUNT; i++) {
    queue.push({
      receiver_account_id: NEAR_RECEIVER_ACCOUNT_ID,
      amount: AMOUNT_PER_TRANSFER.toString(),
      has_storage_deposit: true,
      memo: "Test transfer",
    });
  }
  const pushEndTime = Date.now();
  const pushTime = pushEndTime - pushStartTime;

  console.info(`Pushed ${TRANSFER_COUNT} items in ${pushTime}ms`);
  console.info("Starting executor...\n");

  // Benchmark: Process transfers
  const processingStartTime = Date.now();
  await executor.start();
  await executor.waitUntilIdle();
  const processingEndTime = Date.now();
  const processingTime = processingEndTime - processingStartTime;

  executor.stop();

  const finalBalance = await provider.callFunction(
    NEAR_CONTRACT_ID,
    "ft_balance_of",
    { account_id: NEAR_RECEIVER_ACCOUNT_ID },
  );

  const stats = queue.getStats();

  // Report results
  console.info("\n===== BENCHMARK RESULTS =====");
  console.info(`Keys used: ${NEAR_PRIVATE_KEYS.length}`);
  console.info(`Queue push time: ${pushTime}ms`);
  console.info(`Processing time: ${processingTime}ms`);
  console.info(`Total time: ${pushTime + processingTime}ms`);
  console.info(`Items processed: ${stats.success}`);
  console.info(`Items failed: ${stats.failed}`);
  console.info(
    `Average time per item: ${(processingTime / stats.success).toFixed(2)}ms`,
  );
  console.info(
    `Throughput: ${(stats.success / (processingTime / 1000)).toFixed(2)} items/sec`,
  );
  console.info(`Initial balance: ${initialBalance}`);
  console.info(`Final balance: ${finalBalance}`);
  console.info("=============================\n");

  // Verify results
  const expectedBalance = (
    BigInt(initialBalance!.toString()) +
    BigInt(TRANSFER_COUNT) * BigInt(AMOUNT_PER_TRANSFER)
  ).toString();

  if (stats.success !== TRANSFER_COUNT) {
    console.error(
      `❌ Expected ${TRANSFER_COUNT} successful transfers, got ${stats.success}`,
    );
    process.exit(1);
  }

  if (stats.failed > 0) {
    console.error(`❌ Expected 0 failed transfers, got ${stats.failed}`);
    process.exit(1);
  }

  if (finalBalance !== expectedBalance) {
    console.error(
      `❌ Balance mismatch: expected ${expectedBalance}, got ${finalBalance}`,
    );
    process.exit(1);
  }

  console.info("✅ All benchmarks passed!");
}

// Run the benchmark
runBenchmark().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});

import { Account } from "@near-js/accounts";
import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider, type Provider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { Database } from "bun:sqlite";
import { Queue } from "../src/queue";
import { Executor } from "../src/executor";

async function runBenchmark() {
  const TRANSFER_COUNT = 10000;
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
    // "ed25519:4PHTkvVJVJCXHm1bTjNqk43GsrhJgj9FYbzd9Qe248Vc5Eiitp4QWpmr2x1L8gnYcyC5Z7GDPku6DTdkZKFjoj7d",
    // "ed25519:K9aE4rmsk4N5GZX2oe98u2sJ3cyieoyT5JDJjhdWAPz6tpH8NKBGpf54XoY6hSw5RxRQBobULXSbhtiRJQEYQ1i",
    // Add more private keys here for parallel processing:
    // "ed25519:YourSecondKey...",
    // "ed25519:YourThirdKey...",
  ];

  // This should be already has a storage deposit
  const NEAR_RECEIVER_ACCOUNT_ID = "jinakayam.testnet";

  const keyPair = KeyPair.fromString(NEAR_PRIVATE_KEYS[0]! as any);

  console.info("===== NEAR FT Transfer Benchmark =====");
  console.info(`Transfer count: ${TRANSFER_COUNT}`);
  console.info(`Batch size: ${BATCH_SIZE}`);
  console.info(`Amount per transfer: ${AMOUNT_PER_TRANSFER}`);
  console.info(`Private keys (concurrency): ${NEAR_PRIVATE_KEYS.length}`);
  console.info("=====================================\n");

  const accountA = new Account(
    NEAR_ACCOUNT_ID,
    new JsonRpcProvider({ url: RPC_URL }) as Provider,
    new KeyPairSigner(keyPair),
  );

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

  const initialBalance = await accountA.callFunction({
    contractId: NEAR_CONTRACT_ID,
    methodName: "ft_balance_of",
    args: { account_id: NEAR_RECEIVER_ACCOUNT_ID },
  });

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

  // Wait for processing to complete with better timeout and retry logic
  let waitedTime = 0;
  const maxWaitTime = 60000; // 60 seconds
  const checkInterval = 1000;
  let lastStats = queue.getStats();

  console.log("⏳ Waiting for processing to complete...");

  while (waitedTime < maxWaitTime) {
    await new Promise(resolve => setTimeout(resolve, checkInterval));
    waitedTime += checkInterval;

    const currentStats = queue.getStats();

    // Only log if something changed
    if (JSON.stringify(currentStats) !== JSON.stringify(lastStats)) {
      console.log(`⏱️  [${waitedTime/1000}s] Queue stats:`, currentStats);
      lastStats = currentStats;
    }

    if (!queue.hasPendingOrProcessing()) {
      console.log("✅ Queue appears to be idle");

      // Wait a bit more to make sure all workers finished
      await new Promise(resolve => setTimeout(resolve, 2000));

      const finalStats = queue.getStats();
      if (finalStats.pending === 0 && finalStats.processing === 0) {
        console.log("✅ Confirmed: All processing complete");
        break;
      }
    }
  }

  if (waitedTime >= maxWaitTime) {
    console.warn("⚠️  Timeout reached, but stopping executor...");
  }

  const processingEndTime = Date.now();
  const processingTime = processingEndTime - processingStartTime;

  executor.stop();

  // Wait for workers to fully stop
  await new Promise(resolve => setTimeout(resolve, 3000));

  const finalBalance = await accountA.callFunction({
    contractId: NEAR_CONTRACT_ID,
    methodName: "ft_balance_of",
    args: { account_id: NEAR_RECEIVER_ACCOUNT_ID },
  });

  let stats = queue.getStats();
  console.log("📊 Initial final stats:", stats);

  // Check for any stuck items (debugging)
  const allItems = db.query("SELECT * FROM queue ORDER BY id").all() as any[];
  const pending = allItems.filter(item => item.batch_id === null);
  const reserved = allItems.filter(item => item.batch_id && item.batch_id < 0);
  const processing = allItems.filter(item => item.batch_id && item.batch_id > 0);

  console.log(`🔍 Item breakdown: Pending=${pending.length}, Reserved=${reserved.length}, Processing=${processing.length}`);

  // If there are stuck reservations, run recovery
  if (reserved.length > 0) {
    console.log("🔄 Found stuck reservations, running recovery...");
    queue.recover();
    stats = queue.getStats();
    console.log("📊 Stats after recovery:", stats);
  }

  // Check for items that have batch_id but aren't counted as success in stats
  const itemsWithBatchId = allItems.filter(item => item.batch_id && item.batch_id > 0);
  const itemsNotAccountedFor = itemsWithBatchId.length - stats.success;

  console.log(`🔍 Items with batch_id: ${itemsWithBatchId.length}, Success count: ${stats.success}, Not accounted: ${itemsNotAccountedFor}`);

  if (itemsNotAccountedFor > 0) {
    console.warn("⚠️  Items still marked as processing - checking batch transactions...");
    const batchTxs = db.query("SELECT * FROM batch_transactions").all() as any[];
    console.log("Batch transactions:", batchTxs.map(tx => ({
      id: tx.id,
      status: tx.status,
      has_items: db.query("SELECT COUNT(*) as count FROM queue WHERE batch_id = ?", [tx.id]).get()
    })));

    // Find non-successful batch transactions and recover them
    const failedBatches = batchTxs.filter(tx => tx.status !== 'success');
    if (failedBatches.length > 0) {
      console.log(`🔄 Found ${failedBatches.length} failed/incomplete batches, running recovery...`);

      failedBatches.forEach(batch => {
        console.log(`  Recovering batch ${batch.id} with status: ${batch.status}`);
        queue.recoverFailedBatch(batch.id, `Batch recovery for testnet benchmark - status: ${batch.status}`);
      });
    }

    // Find orphaned items (items pointing to non-existent batch transactions)
    const existingBatchIds = new Set(batchTxs.map(tx => tx.id));
    const orphanedItems = itemsWithBatchId.filter(item => !existingBatchIds.has(item.batch_id!));

    if (orphanedItems.length > 0) {
      console.log(`🔄 Found ${orphanedItems.length} orphaned items (pointing to deleted batches), resetting to pending...`);

      const orphanedIds = orphanedItems.map(item => item.id);
      const placeholders = orphanedIds.map(() => "?").join(",");

      // Reset orphaned items to pending status
      db.run(
        `UPDATE queue SET batch_id = NULL, updated_at = ? WHERE id IN (${placeholders})`,
        [Date.now(), ...orphanedIds]
      );

      console.log(`  Reset ${orphanedIds.length} items to pending`);
    }

    // Re-check stats after any recovery
    if (failedBatches.length > 0 || orphanedItems.length > 0) {
      stats = queue.getStats();
      console.log("📊 Stats after recovery:", stats);
    }
  }

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
    BigInt(initialBalance.toString()) +
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

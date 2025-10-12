import { Account } from "@near-js/accounts";
import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider, type Provider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { Database } from "bun:sqlite";
import { Queue } from "../src/queue";
import { Executor } from "../src/executor";

async function runBenchmark() {
  const TRANSFER_COUNT = 1000;
  const AMOUNT_PER_TRANSFER = 100;
  const BATCH_SIZE = 100;

  // Provide your own NEAR account details here
  const RPC_URL = "https://test.rpc.fastnear.com";
  const NEAR_ACCOUNT_ID = "jinakmerpati.testnet";
  const NEAR_CONTRACT_ID = "jinakmerpati.testnet";

  // Multiple private keys for parallel processing
  // Add more keys to increase concurrency
  const NEAR_PRIVATE_KEYS = [
    "ed25519:5uGZbkwRcgjp6w93koFMDcgnx5t5XA8FwsFGsEtig5sZbgXccgMLe21KzxMEzxeZ5LAsSHECoCuB6LBXrpSWz83C",
    "ed25519:sfkBU9ZpnQsNrKdiPb6YEW5pGPanTmM5ALbs6PuMpju4TsNF9DdUyqps4o13G8LJCN7aj9wNcHHgU1Z72JrsvXn",
    "ed25519:Zv6Dfto81Sg13qwiVodmsuw6HxuHopQ2vmv4EcYpGu1XVopyEDDiFfLGLQbWEjCkQe7aVPPdLRFkbbHd15BYDBE",
    "ed25519:5RJDsf6HHarQfPXCTC8PVEPTnFDUmZLDwbzqDxYyYkWAoptn4XALHpdo3zTkLH7eZ8w8ZRRQrCpc2jLoLRuNGjqZ",
    "ed25519:5WYfWKUQmERmjrP3Y39Q9dNrtvENMkZ9urQ3i13kGKxsesYdAkWTsaB6yabYmXK6ioCFnVM6PUHJXtwE1JGNVKBz"
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
  await executor.waitUntilIdle();
  const processingEndTime = Date.now();
  const processingTime = processingEndTime - processingStartTime;

  executor.stop();

  const finalBalance = await accountA.callFunction({
    contractId: NEAR_CONTRACT_ID,
    methodName: "ft_balance_of",
    args: { account_id: NEAR_RECEIVER_ACCOUNT_ID },
  });

  const stats = queue.getStats();

  // Report results
  console.info("\n===== BENCHMARK RESULTS =====");
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

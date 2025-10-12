import { Account } from "@near-js/accounts";
import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider, type Provider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { NEAR } from "@near-js/tokens";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import { readFile } from "fs/promises";
import { Database } from "bun:sqlite";
import { Queue } from "../src/queue";
import { Executor } from "../src/executor";
import { sleep } from "bun";

async function runBenchmark() {
  const TRANSFER_COUNT = 1000;
  const AMOUNT_PER_TRANSFER = 100;
  const BATCH_SIZE = 100;
  const RPC_PORT = 45555;
  const NUM_KEYS = 5; // Number of keys for parallel processing

  console.info("===== NEAR FT Transfer Benchmark =====");
  console.info(`Transfer count: ${TRANSFER_COUNT}`);
  console.info(`Batch size: ${BATCH_SIZE}`);
  console.info(`Amount per transfer: ${AMOUNT_PER_TRANSFER}`);
  console.info(`Parallel keys (concurrency): ${NUM_KEYS}`);
  console.info("=====================================\n");

  // Start sandbox
  console.info("Starting NEAR sandbox...");
  const sandbox = await Sandbox.start({
    config: {
      rpcPort: RPC_PORT,
    },
  });

  try {
    console.info(`Sandbox RPC available at: ${sandbox.rpcUrl}`);
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl }) as Provider;
    const keyPair = KeyPair.fromString(DEFAULT_PRIVATE_KEY);

    const defaultAccount = new Account(
      DEFAULT_ACCOUNT_ID,
      provider,
      new KeyPairSigner(keyPair),
    );

    // Create account A (sender)
    console.info("Setting up test accounts...");
    const accountAKeyPair = KeyPair.fromRandom("ED25519");
    await defaultAccount.createAccount(
      `account-a.${DEFAULT_ACCOUNT_ID}`,
      accountAKeyPair.getPublicKey(),
      NEAR.toUnits(10),
    );

    const accountA = new Account(
      "account-a." + DEFAULT_ACCOUNT_ID,
      new JsonRpcProvider({ url: sandbox.rpcUrl }) as Provider,
      new KeyPairSigner(accountAKeyPair),
    );

    // Create additional keys for parallel processing
    console.info(`Creating ${NUM_KEYS - 1} additional access keys for parallel processing...`);
    const additionalKeyPairs: KeyPair[] = [];
    for (let i = 0; i < NUM_KEYS - 1; i++) {
      const newKeyPair = KeyPair.fromRandom("ED25519");
      additionalKeyPairs.push(newKeyPair);

      // Add full access key to account A
      await accountA.addFullAccessKey(newKeyPair.getPublicKey());
      console.info(`  Added key ${i + 1}/${NUM_KEYS - 1}`);
    }

    // Collect all private keys (original + additional)
    const allPrivateKeys = [
      accountAKeyPair.toString(),
      ...additionalKeyPairs.map(kp => kp.toString()),
    ];
    console.info(`Total keys available: ${allPrivateKeys.length}`);

    // Create account B (receiver)
    const accountBKeyPair = KeyPair.fromRandom("ED25519");
    await defaultAccount.createAccount(
      `account-b.${DEFAULT_ACCOUNT_ID}`,
      accountBKeyPair.getPublicKey(),
      NEAR.toUnits(10),
    );

    // Deploy FT contract
    console.info("Deploying FT contract...");
    const ftContract = await readFile(
      `${import.meta.dir}/../tests/fungible_token.wasm`,
    );
    await accountA.deployContract(ftContract);
    await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "new_default_meta",
      args: {
        owner_id: `account-a.${DEFAULT_ACCOUNT_ID}`,
        total_supply: "1000000000",
      },
    });

    // Register account B for storage
    await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "storage_deposit",
      args: {
        account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
        registration_only: true,
      },
      deposit: NEAR.toUnits(0.00125),
    });

    console.info("Setup completed\n");

    // Initialize queue and executor
    // Wait for 5 seconds to avoid invalid nonce error
    await sleep(5000);
    const db = new Database(":memory:");
    const queue = new Queue(db, { mergeExistingAccounts: false });

    const executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKeys: allPrivateKeys,
      batchSize: BATCH_SIZE,
      interval: 100,
    });

    const initialBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    console.info(`Initial balance: ${initialBalance}`);
    console.info(`Pushing ${TRANSFER_COUNT} items to queue...`);

    // Benchmark: Push transfers
    const pushStartTime = Date.now();
    for (let i = 0; i < TRANSFER_COUNT; i++) {
      queue.push({
        receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
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
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    const stats = queue.getStats();

    // Report results
    console.info("\n===== BENCHMARK RESULTS =====");
    console.info(`Keys used: ${NUM_KEYS}`);
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
  } finally {
    // Cleanup
    console.info("\nTearing down the sandbox...");
    await sandbox.tearDown();
    console.info("Sandbox is stopped");
  }
}

// Run the benchmark
runBenchmark().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});

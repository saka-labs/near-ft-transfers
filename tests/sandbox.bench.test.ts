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
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

let sandbox: Awaited<ReturnType<typeof Sandbox.start>>;
let accountA: Account;
let accountB: Account;
let accountAKeyPair: KeyPair;

beforeAll(async () => {
  sandbox = await Sandbox.start({
    config: {
      rpcPort: 45555,
    },
  });

  console.info(`Sandbox RPC available at: ${sandbox.rpcUrl}`);
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl }) as Provider;
  const keyPair = KeyPair.fromString(DEFAULT_PRIVATE_KEY);

  const defaultAccount = new Account(
    DEFAULT_ACCOUNT_ID,
    provider,
    new KeyPairSigner(keyPair),
  );

  // Account A is the owner of the contract and the sender
  // Account B is the receiver of transfers

  // Create account A
  accountAKeyPair = KeyPair.fromRandom("ED25519");
  await defaultAccount.createAccount(
    `account-a.${DEFAULT_ACCOUNT_ID}`,
    accountAKeyPair.getPublicKey(),
    NEAR.toUnits(10),
  );

  accountA = new Account(
    "account-a." + DEFAULT_ACCOUNT_ID,
    new JsonRpcProvider({ url: sandbox.rpcUrl }) as Provider,
    new KeyPairSigner(accountAKeyPair),
  );

  // Create account B
  const accountBKeyPair = KeyPair.fromRandom("ED25519");
  await defaultAccount.createAccount(
    `account-b.${DEFAULT_ACCOUNT_ID}`,
    accountBKeyPair.getPublicKey(),
    NEAR.toUnits(10),
  );

  accountB = new Account(
    "account-b." + DEFAULT_ACCOUNT_ID,
    new JsonRpcProvider({ url: sandbox.rpcUrl }) as Provider,
    new KeyPairSigner(accountBKeyPair),
  );

  // Deploy FT contract
  const ftContract = await readFile(`${__dirname}/fungible_token.wasm`);
  await accountA.deployContract(ftContract);
  await accountA.callFunction({
    contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
    methodName: "new_default_meta",
    args: {
      owner_id: `account-a.${DEFAULT_ACCOUNT_ID}`,
      total_supply: "1000000000",
    },
  });

  // Register account B
  await accountA.callFunction({
    contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
    methodName: "storage_deposit",
    args: {
      account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      registration_only: true,
    },
    deposit: NEAR.toUnits(0.00125),
  });

  console.info("Sandbox setup completed");
});

afterAll(async () => {
  console.info("Tearing down the sandbox...");
  await sandbox.tearDown();
  console.info("Sandbox is stopped");
});

describe("Executor - Benchmark", () => {
  test("should process queue items and report processing time", async () => {
    const TRANSFER_COUNT = 1000;
    const AMOUNT_PER_TRANSFER = "100";

    const db = new Database(":memory:");
    const queue = new Queue(db, { mergeExistingAccounts: false });

    const executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
      batchSize: 100,
      interval: 100,
    });

    const initialBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    console.info(`\nInitial balance: ${initialBalance}`);
    console.info(`Pushing ${TRANSFER_COUNT} items to queue...`);

    // Push transfers
    const pushStartTime = Date.now();
    for (let i = 0; i < TRANSFER_COUNT; i++) {
      queue.push({
        receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
        amount: AMOUNT_PER_TRANSFER,
        has_storage_deposit: true,
      });
    }
    const pushEndTime = Date.now();
    const pushTime = pushEndTime - pushStartTime;

    console.info(`Pushed ${TRANSFER_COUNT} items in ${pushTime}ms`);
    console.info("Starting executor...");

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
    expect(stats.success).toBe(TRANSFER_COUNT);
    expect(stats.failed).toBe(0);
    expect(stats.pending).toBe(0);

    const expectedBalance = (
      BigInt(initialBalance.toString()) +
      BigInt(TRANSFER_COUNT) * BigInt(AMOUNT_PER_TRANSFER)
    ).toString();
    expect(finalBalance).toBe(expectedBalance);

    // Performance assertion - should complete in reasonable time
    // This is a soft limit, adjust based on your environment
    expect(processingTime).toBeLessThan(1200000); // 20 minutes max
  }, 1800000); // 30 minute timeout
});

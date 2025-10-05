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
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";

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

  console.log(`Sandbox RPC available at: ${sandbox.rpcUrl}`);
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

  console.log("Sandbox setup completed");
});

afterAll(async () => {
  console.log("Tearing down the sandbox...");
  await sandbox.tearDown();
  console.log("Sandbox is stopped");
});

describe("Executor - Benchmark", () => {
  test("should process 1000 queue items and report processing time", async () => {
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

    console.log(`\nInitial balance: ${initialBalance}`);
    console.log("Pushing 1000 items to queue...");

    // Push 1000 transfers
    const pushStartTime = Date.now();
    for (let i = 0; i < 1000; i++) {
      queue.push({
        receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
        amount: "100",
      });
    }
    const pushEndTime = Date.now();
    const pushTime = pushEndTime - pushStartTime;

    console.log(`Pushed 1000 items in ${pushTime}ms`);
    console.log("Starting executor...");

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
    console.log("\n===== BENCHMARK RESULTS =====");
    console.log(`Queue push time: ${pushTime}ms`);
    console.log(`Processing time: ${processingTime}ms`);
    console.log(`Total time: ${pushTime + processingTime}ms`);
    console.log(`Items processed: ${stats.success}`);
    console.log(`Items failed: ${stats.failed}`);
    console.log(`Average time per item: ${(processingTime / stats.success).toFixed(2)}ms`);
    console.log(`Throughput: ${(stats.success / (processingTime / 1000)).toFixed(2)} items/sec`);
    console.log(`Initial balance: ${initialBalance}`);
    console.log(`Final balance: ${finalBalance}`);
    console.log("=============================\n");

    // Verify results
    expect(stats.success).toBe(1000);
    expect(stats.failed).toBe(0);
    expect(stats.pending).toBe(0);

    const expectedBalance = (
      BigInt(initialBalance.toString()) + 100000n
    ).toString();
    expect(finalBalance).toBe(expectedBalance);

    // Performance assertion - should complete in reasonable time
    // This is a soft limit, adjust based on your environment
    expect(processingTime).toBeLessThan(120000); // 2 minutes max
  }, 180000); // 3 minute timeout
});

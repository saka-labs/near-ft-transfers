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
  beforeEach,
} from "bun:test";
import { sleep } from "bun";

let sandbox: Awaited<ReturnType<typeof Sandbox.start>>;
let accountA: Account;
let accountB: Account;
let accountC: Account;
let defaultAccount: Account;
let accountAKeyPair: KeyPair;

beforeAll(async () => {
  sandbox = await Sandbox.start({
    config: {
      rpcPort: 44444,
    },
  });

  console.info(`Sandbox RPC available at: ${sandbox.rpcUrl}`);
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl }) as Provider;
  const keyPair = KeyPair.fromString(DEFAULT_PRIVATE_KEY);

  defaultAccount = new Account(
    DEFAULT_ACCOUNT_ID,
    provider,
    new KeyPairSigner(keyPair),
  );

  // Account A is the owner of the contract and the sender
  // Account B and C are receivers of transfers

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

  // Create account C
  const accountCKeyPair = KeyPair.fromRandom("ED25519");
  await defaultAccount.createAccount(
    `account-c.${DEFAULT_ACCOUNT_ID}`,
    accountCKeyPair.getPublicKey(),
    NEAR.toUnits(10),
  );

  accountC = new Account(
    "account-c." + DEFAULT_ACCOUNT_ID,
    new JsonRpcProvider({ url: sandbox.rpcUrl }) as Provider,
    new KeyPairSigner(accountCKeyPair),
  );

  // Deploy FT contract
  const ftContract = await readFile(`${__dirname}/fungible_token.wasm`);
  await accountA.deployContract(ftContract);
  await accountA.callFunction({
    contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
    methodName: "new_default_meta",
    args: {
      owner_id: `account-a.${DEFAULT_ACCOUNT_ID}`,
      total_supply: "100000000",
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

  // Register account C
  await accountA.callFunction({
    contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
    methodName: "storage_deposit",
    args: {
      account_id: `account-c.${DEFAULT_ACCOUNT_ID}`,
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

describe("Executor - Basic Batch Processing", () => {
  let queue: Queue;
  let executor: Executor;
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new Queue(db, { mergeExistingAccounts: false });
  });

  afterAll(() => {
    if (executor) {
      executor.stop();
    }
  });

  test("should process single batch successfully", async () => {
    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
    });
    await executor.start();

    const initialBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    // Push 5 transfers
    for (let i = 0; i < 5; i++) {
      queue.push({
        receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
        amount: "100",
      });
    }

    await executor.waitUntilIdle();

    const finalBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    const stats = queue.getStats();
    expect(stats.success).toBe(5);
    expect(stats.failed).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.processing).toBe(0);

    const expectedBalance = (
      BigInt(initialBalance.toString()) + 500n
    ).toString();
    expect(finalBalance).toBe(expectedBalance);

    executor.stop();
  }, 30000);

  test("should process multiple batches with batch size limit", async () => {
    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
      batchSize: 3,
    });
    await executor.start();

    const initialBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    // Push 10 transfers (should create 4 batches: 3+3+3+1)
    for (let i = 0; i < 10; i++) {
      queue.push({
        receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
        amount: "10",
      });
    }

    await executor.waitUntilIdle();

    const finalBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    const stats = queue.getStats();
    expect(stats.success).toBe(10);
    expect(stats.failed).toBe(0);

    const expectedBalance = (
      BigInt(initialBalance.toString()) + 100n
    ).toString();
    expect(finalBalance).toBe(expectedBalance);

    executor.stop();
  }, 30000);

  test("should process transfers to multiple receivers", async () => {
    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
    });
    await executor.start();

    const initialBalanceB = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    const initialBalanceC = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-c.${DEFAULT_ACCOUNT_ID}` },
    });

    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "200",
    });
    queue.push({
      receiver_account_id: `account-c.${DEFAULT_ACCOUNT_ID}`,
      amount: "300",
    });

    await executor.waitUntilIdle();

    const finalBalanceB = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    const finalBalanceC = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-c.${DEFAULT_ACCOUNT_ID}` },
    });

    const stats = queue.getStats();
    expect(stats.success).toBe(2);

    const expectedBalanceB = (
      BigInt(initialBalanceB.toString()) + 200n
    ).toString();
    const expectedBalanceC = (
      BigInt(initialBalanceC.toString()) + 300n
    ).toString();
    expect(finalBalanceB).toBe(expectedBalanceB);
    expect(finalBalanceC).toBe(expectedBalanceC);

    executor.stop();
  }, 30000);
});

describe("Executor - Recovery Mechanism", () => {
  let queue: Queue;
  let executor: Executor;
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new Queue(db, { mergeExistingAccounts: false });
  });

  afterAll(() => {
    if (executor) {
      executor.stop();
    }
  });

  test("should recover and re-broadcast pending signed transactions on startup", async () => {
    // Simulate a crash: create signed transaction but don't broadcast
    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "500",
    });

    const items = queue.pull(10);

    // Create the signed transaction directly
    const account = new Account(
      `account-a.${DEFAULT_ACCOUNT_ID}`,
      new JsonRpcProvider({ url: sandbox.rpcUrl }),
      new KeyPairSigner(accountAKeyPair),
    );

    const actions = items.map((item) => {
      const { actionCreators } = require("@near-js/transactions");
      return actionCreators.functionCall(
        "ft_transfer",
        {
          receiver_id: item.receiver_account_id,
          amount: item.amount,
          memo: null,
        },
        1000000000000n * 3n,
        1n,
      );
    });

    const signed = await account.createSignedTransaction(
      `account-a.${DEFAULT_ACCOUNT_ID}`,
      actions,
    );

    const { sha256Bs58 } = require("../src/utils");
    const signedHash = await sha256Bs58(signed.transaction.encode());

    // Store signed transaction without broadcasting (simulating crash)
    queue.createSignedTransaction(
      signedHash,
      signed.encode(),
      items.map((i) => i.id),
    );

    const initialBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    // Now start executor - it should recover the pending transaction
    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
    });
    await executor.start();
    await executor.waitUntilIdle();

    const finalBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    const stats = queue.getStats();
    expect(stats.success).toBe(1);
    expect(stats.pending).toBe(0);
    expect(stats.processing).toBe(0);

    const expectedBalance = (
      BigInt(initialBalance.toString()) + 500n
    ).toString();
    expect(finalBalance).toBe(expectedBalance);

    executor.stop();
  }, 30000);
});

describe("Executor - Batch Failure and Retry", () => {
  let queue: Queue;
  let executor: Executor;
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new Queue(db, { mergeExistingAccounts: false });
  });

  afterAll(() => {
    if (executor) {
      executor.stop();
    }
  });

  test("should track retry_count and error_message when batch fails", async () => {
    // Push transfer to non-existent account (will fail)
    queue.push({
      receiver_account_id: `nonexistent.${DEFAULT_ACCOUNT_ID}`,
      amount: "100",
    });

    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
      interval: 100,
    });

    // Wait for at least one batch failure event
    const batchFailedPromise = new Promise<void>((resolve) => {
      executor.once('batchFailed', () => {
        resolve();
      });
    });

    await executor.start();
    await batchFailedPromise;

    const items = db.query("SELECT * FROM queue").all() as any[];
    expect(items[0]!.retry_count).toBeGreaterThan(0);
    expect(items[0]!.error_message).not.toBeNull();
    expect(items[0]!.batch_id).toBeNull(); // Should be reset to pending

    executor.stop();
  }, 30000);

  test("should delete failed batch transaction record", async () => {
    queue.push({
      receiver_account_id: `nonexistent.${DEFAULT_ACCOUNT_ID}`,
      amount: "100",
    });

    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
      interval: 100,
    });

    // Wait for batch failure event
    const batchFailedPromise = new Promise<void>((resolve) => {
      executor.once('batchFailed', () => {
        resolve();
      });
    });

    await executor.start();
    await batchFailedPromise;

    // Check that no processing batch transactions exist
    const processingBatches = db
      .query("SELECT * FROM batch_transactions WHERE status = 'processing'")
      .all();

    // Failed batches should be deleted, not marked as failed
    const failedBatches = db
      .query("SELECT * FROM batch_transactions WHERE status = 'failed'")
      .all();

    expect(failedBatches).toHaveLength(0);

    executor.stop();
  }, 30000);
});

describe("Executor - Queue Merging Behavior", () => {
  let queue: Queue;
  let executor: Executor;
  let db: Database;

  afterAll(() => {
    if (executor) {
      executor.stop();
    }
  });

  test("should merge amounts for same account when merging is enabled", async () => {
    db = new Database(":memory:");
    queue = new Queue(db, { mergeExistingAccounts: true });

    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
    });
    await executor.start();

    const initialBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    // Push multiple transfers to same account
    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "100",
    });
    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "200",
    });
    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "300",
    });

    await executor.waitUntilIdle();

    const finalBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    const stats = queue.getStats();
    // Should only process 1 item (merged)
    expect(stats.success).toBe(1);

    const expectedBalance = (
      BigInt(initialBalance.toString()) + 600n
    ).toString();
    expect(finalBalance).toBe(expectedBalance);

    executor.stop();
  }, 30000);

  test("should not merge amounts when merging is disabled", async () => {
    db = new Database(":memory:");
    queue = new Queue(db, { mergeExistingAccounts: false });

    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
    });
    await executor.start();

    const initialBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    // Push multiple transfers to same account
    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "100",
    });
    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "200",
    });
    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "300",
    });

    await executor.waitUntilIdle();

    const finalBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    const stats = queue.getStats();
    // Should process 3 separate items
    expect(stats.success).toBe(3);

    const expectedBalance = (
      BigInt(initialBalance.toString()) + 600n
    ).toString();
    expect(finalBalance).toBe(expectedBalance);

    executor.stop();
  }, 30000);
});

describe("Executor - MinQueueToProcess Threshold", () => {
  let queue: Queue;
  let executor: Executor;
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new Queue(db, { mergeExistingAccounts: false });
  });

  afterAll(() => {
    if (executor) {
      executor.stop();
    }
  });

  test("should not process when queue size is below minQueueToProcess", async () => {
    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
      minQueueToProcess: 5,
      interval: 100,
    });

    // Push only 3 items (below threshold of 5)
    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "100",
    });
    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "200",
    });
    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "300",
    });

    // Wait for at least one loop to complete to verify nothing was processed
    const loopCompletedPromise = new Promise<void>((resolve) => {
      executor.once('loopCompleted', () => {
        resolve();
      });
    });

    await executor.start();
    await loopCompletedPromise;

    const stats = queue.getStats();
    expect(stats.success).toBe(0);
    expect(stats.pending).toBe(3);

    executor.stop();
  }, 30000);

  test("should process when queue size meets minQueueToProcess", async () => {
    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
      minQueueToProcess: 5,
      interval: 100,
    });
    await executor.start();

    const initialBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    // Push exactly 5 items (meets threshold)
    for (let i = 0; i < 5; i++) {
      queue.push({
        receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
        amount: "100",
      });
    }

    await executor.waitUntilIdle();

    const finalBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
    });

    const stats = queue.getStats();
    expect(stats.success).toBe(5);

    const expectedBalance = (
      BigInt(initialBalance.toString()) + 500n
    ).toString();
    expect(finalBalance).toBe(expectedBalance);

    executor.stop();
  }, 30000);
});

describe("Executor - Batch Transaction Storage", () => {
  let queue: Queue;
  let executor: Executor;
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    queue = new Queue(db, { mergeExistingAccounts: false });
  });

  afterAll(() => {
    if (executor) {
      executor.stop();
    }
  });

  test("should store and clean up signed transaction blob on success", async () => {
    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
    });
    await executor.start();

    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "100",
    });

    await executor.waitUntilIdle();

    // Check that successful batch has signed_tx cleaned up
    const successBatches = db
      .query("SELECT * FROM batch_transactions WHERE status = 'success'")
      .all() as any[];

    expect(successBatches.length).toBeGreaterThan(0);
    expect(successBatches[0]!.signed_tx).toBeNull();
    expect(successBatches[0]!.tx_hash).not.toBeNull();

    executor.stop();
  }, 30000);

  test("should update tx_hash with actual transaction hash on success", async () => {
    executor = new Executor(queue, {
      rpcUrl: sandbox.rpcUrl,
      accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      privateKey: accountAKeyPair.toString(),
    });
    await executor.start();

    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: "100",
    });

    await executor.waitUntilIdle();

    const successBatches = db
      .query("SELECT * FROM batch_transactions WHERE status = 'success'")
      .all() as any[];

    expect(successBatches.length).toBeGreaterThan(0);
    // tx_hash should be updated with actual hash from RPC
    expect(successBatches[0]!.tx_hash).toBeTruthy();
    expect(successBatches[0]!.tx_hash.length).toBeGreaterThan(0);

    executor.stop();
  }, 30000);
});

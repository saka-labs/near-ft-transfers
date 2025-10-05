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
import { test, expect, beforeAll, afterAll } from "bun:test";

let sandbox: Awaited<ReturnType<typeof Sandbox.start>>;
let queue: Queue;
let executor: Executor;
let accountA: Account;
let accountB: Account;
let defaultAccount: Account;

beforeAll(async () => {
  queue = new Queue(new Database(":memory:"), {
    mergeExistingAccounts: false,
  });

  sandbox = await Sandbox.start({
    config: {
      rpcPort: 44444,
    },
  });

  console.log(`Sandbox RPC available at: ${sandbox.rpcUrl}`);
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl }) as Provider;
  const keyPair = KeyPair.fromString(DEFAULT_PRIVATE_KEY);

  defaultAccount = new Account(
    DEFAULT_ACCOUNT_ID,
    provider,
    new KeyPairSigner(keyPair),
  );

  // Account A is the owner of the contract and the sender
  // Account B is the receiver of the transfer

  // Create account A
  const accountAKeyPair = KeyPair.fromRandom("ED25519");
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
      total_supply: "1000000",
    },
  });

  // deposit 0.00125 NEAR to register account-b
  await accountA.callFunction({
    contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
    methodName: "storage_deposit",
    args: {
      account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      registration_only: true,
    },
    deposit: NEAR.toUnits(0.00125), // 0.00125 NEAR
  });

  // Initialize executor
  executor = new Executor(queue, {
    rpcUrl: sandbox.rpcUrl,
    accountId: `account-a.${DEFAULT_ACCOUNT_ID}`,
    contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
    privateKey: accountAKeyPair.toString(),
  });
  executor.start();

  console.log("Sandbox setup completed");
});

afterAll(async () => {
  console.log("Tearing down the sandbox...");
  executor.stop();
  await sandbox.tearDown();
  console.log("Sandbox is stopped");
});

test("should transfer 1000 FT tokens in batches", async () => {
  const transferCount = 1000;
  const amountPerTransfer = "1";

  // Get initial balance
  const initialBalance = await accountA.callFunction({
    contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
    methodName: "ft_balance_of",
    args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
  });

  console.log(`Initial balance of account-b: ${initialBalance}`);

  // Push transfers to queue
  for (let i = 0; i < transferCount; i++) {
    queue.push({
      receiver_account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      amount: amountPerTransfer,
    });
  }

  console.log(`Pushed ${transferCount} transfers to queue`);

  // Wait for executor to process all transfers
  await executor.waitUntilIdle();

  console.log("All transfers processed");

  // Get final balance
  const finalBalance = await accountA.callFunction({
    contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
    methodName: "ft_balance_of",
    args: { account_id: `account-b.${DEFAULT_ACCOUNT_ID}` },
  });

  console.log(`Final balance of account-b: ${finalBalance}`);

  // Check queue stats
  const stats = queue.getStats();
  console.log("Queue stats:", stats);

  // Assertions
  expect(stats.success).toBe(transferCount);
  expect(stats.failed).toBe(0);
  expect(stats.pending).toBe(0);
  expect(stats.processing).toBe(0);

  const expectedBalance = (
    BigInt(initialBalance.toString()) + BigInt(transferCount)
  ).toString();
  expect(finalBalance).toBe(expectedBalance);

  console.log("✅ Test passed!");
}, 60000); // 60 second timeout

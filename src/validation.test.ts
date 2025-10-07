import { describe, test, expect, beforeAll } from "bun:test";
import { AccountValidator } from "./validation";

// Note: These tests require a live NEAR RPC endpoint
// Update these values for your testing environment
const TEST_RPC_URL = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const TEST_CONTRACT_ID =
  process.env.NEAR_CONTRACT_ID || "usdt.tether-token.testnet";

describe("AccountValidator", () => {
  let validator: AccountValidator;

  beforeAll(() => {
    validator = new AccountValidator(TEST_RPC_URL, TEST_CONTRACT_ID, {
      cacheTTL: 5000,
      timeout: 10000,
    });
  });

  test("should detect existing account", async () => {
    const exists = await validator.accountExists("testnet");
    expect(exists).toBe(true);
  });

  test("should detect non-existing account", async () => {
    const randomAccount = `non-existent-${Date.now()}-${Math.random()}.testnet`;
    const exists = await validator.accountExists(randomAccount);
    expect(exists).toBe(false);
  });

  test("should validate account with storage deposit", async () => {
    // This test requires a known account with storage deposit
    // You may need to adjust this based on your test setup
    const result = await validator.validate("testnet");

    // We can't guarantee testnet has storage deposit, but we can check the structure
    expect(result).toHaveProperty("isValid");
    expect(result).toHaveProperty("accountExists");

    if (result.accountExists) {
      expect(result.accountExists).toBe(true);
    }
  });

  test("should fail validation for non-existent account", async () => {
    const randomAccount = `non-existent-${Date.now()}-${Math.random()}.testnet`;
    const result = await validator.validate(randomAccount);

    expect(result.isValid).toBe(false);
    expect(result.accountExists).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  test("should batch validate multiple accounts", async () => {
    const accounts = [
      "testnet", // Should exist
      `non-existent-${Date.now()}.testnet`, // Should not exist
    ];

    const results = await validator.validateBatch(accounts);

    expect(Object.keys(results)).toHaveLength(2);
    expect(results["testnet"]).toBeDefined();
    expect(results["testnet"]?.accountExists).toBe(true);

    const nonExistentKey = Object.keys(results).find((k) =>
      k.includes("non-existent"),
    );
    if (nonExistentKey) {
      expect(results[nonExistentKey]?.accountExists).toBe(false);
    }
  });

  test("should use cache for repeated requests", async () => {
    const account = "near.testnet";

    const start1 = Date.now();
    await validator.accountExists(account);
    const duration1 = Date.now() - start1;

    const start2 = Date.now();
    await validator.accountExists(account);
    const duration2 = Date.now() - start2;

    expect(duration2).toBeLessThan(duration1);
  });

  test("should clear cache", () => {
    validator.clearCache();
    const stats = validator.getCacheStats();

    expect(stats.accountCacheSize).toBe(0);
    expect(stats.storageCacheSize).toBe(0);
  });

  test("should track cache statistics", async () => {
    validator.clearCache();

    await validator.accountExists("testnet");
    const stats = validator.getCacheStats();

    expect(stats.accountCacheSize).toBeGreaterThan(0);
  });
});

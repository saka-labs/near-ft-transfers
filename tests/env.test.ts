import { describe, test, expect, beforeEach, afterEach } from "bun:test";

describe("Environment Configuration Utility", () => {
  // Store original environment variables
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };

    // Clear the module cache to force re-evaluation
    delete require.cache[require.resolve("../src/env")];
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  test("should successfully validate correct environment variables", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    process.env.NEAR_ACCOUNT_ID = "test-account.testnet";
    process.env.NEAR_CONTRACT_ID = "usdt.tether-token.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";
    process.env.MAX_RETRIES = "10";
    process.env.NODE_ENV = "test";

    const { env } = await import("../src/env");

    expect(env.nearRpcUrl).toBe("https://rpc.testnet.near.org");
    expect(env.nearAccountId).toBe("test-account.testnet");
    expect(env.nearContractId).toBe("usdt.tether-token.testnet");
    expect(env.nearPrivateKey).toBe("ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL");
    expect(env.maxRetries).toBe(10);
    expect(env.nodeEnv).toBe("test");
  });

  test("should use default value for MAX_RETRIES when not provided", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";
    delete process.env.MAX_RETRIES;

    const { env } = await import("../src/env");

    expect(env.maxRetries).toBe(5);
  });

  test("should use default value for NODE_ENV when not provided", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";
    delete process.env.NODE_ENV;

    const { env } = await import("../src/env");

    expect(env.nodeEnv).toBe("development");
  });

  test("should throw error when NEAR_RPC_URL is missing", async () => {
    delete process.env.NEAR_RPC_URL;
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";

    expect(async () => {
      await import("../src/env");
    }).toThrow();
  });

  test("should throw error when NEAR_RPC_URL is not a valid URL", async () => {
    process.env.NEAR_RPC_URL = "not-a-valid-url";
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";

    expect(async () => {
      await import("../src/env");
    }).toThrow();
  });

  test("should throw error when NEAR_ACCOUNT_ID is missing", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    delete process.env.NEAR_ACCOUNT_ID;
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";

    expect(async () => {
      await import("../src/env");
    }).toThrow();
  });

  test("should throw error when NEAR_PRIVATE_KEY is missing", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    delete process.env.NEAR_PRIVATE_KEY;

    expect(async () => {
      await import("../src/env");
    }).toThrow();
  });

  test("should throw error when MAX_RETRIES is not a valid integer", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";
    process.env.MAX_RETRIES = "not-a-number";

    expect(async () => {
      await import("../src/env");
    }).toThrow();
  });

  test("should throw error when MAX_RETRIES is negative", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";
    process.env.MAX_RETRIES = "-1";

    expect(async () => {
      await import("../src/env");
    }).toThrow();
  });

  test("should throw error when MAX_RETRIES exceeds 100", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";
    process.env.MAX_RETRIES = "101";

    expect(async () => {
      await import("../src/env");
    }).toThrow();
  });

  test("should accept valid account ID formats", async () => {
    const validAccountIds = [
      "test.testnet",
      "test-account.testnet",
      "test_account.testnet",
      "a.testnet",
      "test123.testnet",
      "sub.account.testnet",
    ];

    for (const accountId of validAccountIds) {
      process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
      process.env.NEAR_ACCOUNT_ID = accountId;
      process.env.NEAR_CONTRACT_ID = "contract.testnet";
      process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";

      // Clear module cache
      delete require.cache[require.resolve("../src/env")];

      const { env } = await import("../src/env");
      expect(env.nearAccountId).toBe(accountId);
    }
  });

  test("getSafeEnvInfo should redact private key", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";

    const { getSafeEnvInfo } = await import("../src/env");
    const safeInfo = getSafeEnvInfo();

    expect(safeInfo.nearPrivateKey).toBe("***REDACTED***");
    expect(safeInfo.nearAccountId).toBe("test.testnet");
    expect(safeInfo.nearRpcUrl).toBe("https://rpc.testnet.near.org");
  });

  test("isProduction should return correct value", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";
    process.env.NODE_ENV = "production";

    const { isProduction } = await import("../src/env");
    expect(isProduction()).toBe(true);
  });

  test("isDevelopment should return correct value", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";
    process.env.NODE_ENV = "development";

    const { isDevelopment } = await import("../src/env");
    expect(isDevelopment()).toBe(true);
  });

  test("isTest should return correct value", async () => {
    process.env.NEAR_RPC_URL = "https://rpc.testnet.near.org";
    process.env.NEAR_ACCOUNT_ID = "test.testnet";
    process.env.NEAR_CONTRACT_ID = "contract.testnet";
    process.env.NEAR_PRIVATE_KEY = "ed25519:5JueXZhEEVqGVT5powZ5twyPP8sbRRYQ5JuCpq6WGkpgPFfE4M8HxpZJ5trvhj8Y7qRvZYzMvNmF8B2bTTvVhqYL";
    process.env.NODE_ENV = "test";

    const { isTest } = await import("../src/env");
    expect(isTest()).toBe(true);
  });
});

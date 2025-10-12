import { z } from "zod";

const EnvSchema = z.object({
  // NEAR Protocol configuration
  NEAR_RPC_URL: z
    .url("NEAR_RPC_URL must be a valid URL")
    .min(1, "NEAR_RPC_URL is required"),

  NEAR_ACCOUNT_ID: z
    .string()
    .min(1, "NEAR_ACCOUNT_ID is required"),

  NEAR_CONTRACT_ID: z
    .string()
    .min(1, "NEAR_CONTRACT_ID is required"),

  NEAR_PRIVATE_KEYS: z
    .string()
    .min(1, "NEAR_PRIVATE_KEYS is required")
    .transform((val) => {
      const keys = val.split(",").map(k => k.trim()).filter(k => k.length > 0);
      if (keys.length === 0) {
        throw new Error("At least one private key is required");
      }
      return keys;
    })
    .describe("Comma-separated list of private keys. Number of keys determines concurrency level."),

  MAX_RETRIES: z
    .string()
    .optional()
    .default("5")
    .transform((val) => {
      const parsed = parseInt(val, 10);
      if (isNaN(parsed)) {
        throw new Error("MAX_RETRIES must be a valid integer");
      }
      if (parsed < 0) {
        throw new Error("MAX_RETRIES must be a non-negative integer");
      }
      if (parsed > 100) {
        throw new Error("MAX_RETRIES must not exceed 100");
      }
      return parsed;
    }),

  // Database configuration
  DATABASE_PATH: z
    .string()
    .optional()
    .default(":memory:")
    .describe("Database file path. Use ':memory:' for in-memory database (default)"),

  // Server configuration
  PORT: z
    .string()
    .optional()
    .default("3000")
    .transform((val) => {
      const parsed = parseInt(val, 10);
      if (isNaN(parsed)) {
        throw new Error("PORT must be a valid integer");
      }
      if (parsed < 1) {
        throw new Error("PORT must be between 1 and 65535");
      }
      if (parsed > 65535) {
        throw new Error("PORT must be between 1 and 65535");
      }
      return parsed;
    })
    .describe("Port for the HTTP server"),

  // Optional: Node environment
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .optional()
    .default("development"),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export interface ParsedEnvConfig {
  nearRpcUrl: string;
  nearAccountId: string;
  nearContractId: string;
  nearPrivateKeys: string[];
  maxRetries: number;
  databasePath: string;
  port: number;
  nodeEnv: "development" | "production" | "test";
}

function validateEnv(): ParsedEnvConfig {
  try {
    // Parse and validate environment variables
    const validated = EnvSchema.parse({
      NEAR_RPC_URL: process.env.NEAR_RPC_URL,
      NEAR_ACCOUNT_ID: process.env.NEAR_ACCOUNT_ID,
      NEAR_CONTRACT_ID: process.env.NEAR_CONTRACT_ID,
      NEAR_PRIVATE_KEYS: process.env.NEAR_PRIVATE_KEYS,
      MAX_RETRIES: process.env.MAX_RETRIES,
      DATABASE_PATH: process.env.DATABASE_PATH,
      PORT: process.env.PORT,
      NODE_ENV: process.env.NODE_ENV,
    });

    // Return with camelCase naming convention
    return {
      nearRpcUrl: validated.NEAR_RPC_URL,
      nearAccountId: validated.NEAR_ACCOUNT_ID,
      nearContractId: validated.NEAR_CONTRACT_ID,
      nearPrivateKeys: validated.NEAR_PRIVATE_KEYS,
      maxRetries: validated.MAX_RETRIES,
      databasePath: validated.DATABASE_PATH,
      port: validated.PORT,
      nodeEnv: validated.NODE_ENV,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => {
          const path = err.path.join(".");
          return `  - ${path || "root"}: ${err.message}`;
        })
        .join("\n");

      throw new Error(
        `Environment validation failed:\n${errorMessages}\n\nPlease check your .env file and ensure all required variables are set correctly.`,
      );
    }
    // If it's a regular Error (e.g., from transform function), wrap it with a helpful message
    if (error instanceof Error) {
      throw new Error(
        `Environment validation failed:\n  - ${error.message}\n\nPlease check your .env file and ensure all required variables are set correctly.`,
      );
    }
    throw error;
  }
}

export const env: ParsedEnvConfig = validateEnv();
export const isProduction = (): boolean => env.nodeEnv === "production";
export const isDevelopment = (): boolean => env.nodeEnv === "development";
export const isTest = (): boolean => env.nodeEnv === "test";

export const getSafeEnvInfo = (): Record<string, string | number> => ({
  nearRpcUrl: env.nearRpcUrl,
  nearAccountId: env.nearAccountId,
  nearContractId: env.nearContractId,
  nearPrivateKeys: "***REDACTED***",
  privateKeysCount: env.nearPrivateKeys.length,
  concurrency: env.nearPrivateKeys.length,
  maxRetries: env.maxRetries,
  databasePath: env.databasePath,
  port: env.port,
  nodeEnv: env.nodeEnv,
});

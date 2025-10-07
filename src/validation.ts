import { JsonRpcProvider } from "@near-js/providers";

export type ValidationResult = {
  isValid: boolean;
  error?: string;
  accountExists?: boolean;
  hasStorageDeposit?: boolean;
};

export type BatchValidationResult = {
  [accountId: string]: ValidationResult;
};

export type ValidatorOptions = {
  cacheTTL?: number;
  skipStorageCheck?: boolean;
  timeout?: number;
};

export class AccountValidator {
  private provider: JsonRpcProvider;
  private contractId: string;

  private accountCache: Map<string, { exists: boolean; timestamp: number }> = new Map();
  private storageCache: Map<string, { hasDeposit: boolean; timestamp: number }> = new Map();

  private cacheTTL: number;
  private skipStorageCheck: boolean;
  private timeout: number;

  constructor(
    rpcUrl: string,
    contractId: string,
    options: ValidatorOptions = {},
  ) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    this.contractId = contractId;
    this.cacheTTL = options.cacheTTL ?? 60000;
    this.skipStorageCheck = options.skipStorageCheck ?? false;
    this.timeout = options.timeout ?? 10000;
  }

  async accountExists(accountId: string): Promise<boolean> {
    const cached = this.accountCache.get(accountId);

    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.exists;
    }

    try {
      const queryPromise = this.provider.query({
        request_type: "view_account",
        account_id: accountId,
        finality: "final",
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("RPC timeout")), this.timeout),
      );

      await Promise.race([queryPromise, timeoutPromise]);

      this.accountCache.set(accountId, { exists: true, timestamp: Date.now() });
      return true;
    } catch (error: any) {
      if (
        error?.type === "AccountDoesNotExist" ||
        error?.message?.includes("does not exist")
      ) {
        this.accountCache.set(accountId, {
          exists: false,
          timestamp: Date.now(),
        });
        return false;
      }

      throw error;
    }
  }

  async hasStorageDeposit(accountId: string): Promise<boolean> {
    if (this.skipStorageCheck) {
      return true;
    }

    const cached = this.storageCache.get(accountId);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.hasDeposit;
    }

    try {
      const queryPromise = this.provider.query({
        request_type: "call_function",
        account_id: this.contractId,
        method_name: "storage_balance_of",
        args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString("base64"),
        finality: "final",
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("RPC timeout")), this.timeout),
      );

      const result = await Promise.race([queryPromise, timeoutPromise]);

      const resultData = (result as any).result;
      const decodedResult = Buffer.from(resultData).toString();
      const balance = JSON.parse(decodedResult);

      const hasDeposit = balance !== null && balance !== undefined;

      this.storageCache.set(accountId, { hasDeposit, timestamp: Date.now() });
      return hasDeposit;
    } catch (error: any) {
      if (error.message === "RPC timeout") {
        throw new Error(`Storage deposit check timed out for account '${accountId}'`);
      }

      this.storageCache.set(accountId, {
        hasDeposit: false,
        timestamp: Date.now(),
      });
      return false;
    }
  }

  async validate(accountId: string): Promise<ValidationResult> {
    try {
      const exists = await this.accountExists(accountId);

      if (!exists) {
        return {
          isValid: false,
          error: `Account '${accountId}' does not exist on NEAR`,
          accountExists: false,
        };
      }

      const hasDeposit = await this.hasStorageDeposit(accountId);

      if (!hasDeposit) {
        return {
          isValid: false,
          error: `Account '${accountId}' has not registered storage deposit on the FT contract`,
          accountExists: true,
          hasStorageDeposit: false,
        };
      }

      return {
        isValid: true,
        accountExists: true,
        hasStorageDeposit: true,
      };
    } catch (error: any) {
      return {
        isValid: false,
        error: `Validation error for '${accountId}': ${error.message || String(error)}`,
      };
    }
  }

  async validateBatch(accountIds: string[]): Promise<BatchValidationResult> {
    const results: BatchValidationResult = {};

    // Validate all accounts in parallel
    const validations = await Promise.allSettled(
      accountIds.map(async (accountId) => ({
        accountId,
        result: await this.validate(accountId),
      })),
    );

    for (const validation of validations) {
      if (validation.status === "fulfilled") {
        results[validation.value.accountId] = validation.value.result;
      } else {
        // Handle rejected promise (shouldn't happen as validate catches errors)
        const error = validation.reason;
        results[error.accountId || "unknown"] = {
          isValid: false,
          error: `Unexpected validation error: ${error.message || String(error)}`,
        };
      }
    }

    return results;
  }

  clearCache(): void {
    this.accountCache.clear();
    this.storageCache.clear();
  }

  getCacheStats(): { accountCacheSize: number; storageCacheSize: number } {
    return {
      accountCacheSize: this.accountCache.size,
      storageCacheSize: this.storageCache.size,
    };
  }
}

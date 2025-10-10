# Repository Audit Report: near-ft-transfers

**Audit Date:** 2025-10-05 (Updated: 2025-10-10)
**Auditor:** Claude Code
**Repository:** NEAR Protocol FT Transfer Service with Queue-Based Execution

## Executive Summary
This is a NEAR Protocol FT transfer service with a queue-based execution system. After reviewing the latest codebase changes, several critical issues from the original audit have been **RESOLVED**. The current status shows **8 critical bugs**, **7 performance issues**, **7 security concerns**, and **4 code quality/maintainability issues** remaining.

### ✅ Recently Resolved Issues (Since Original Audit):
1. **Account Validation** - Added `AccountValidator` class with account existence and storage deposit checks
2. **Storage Deposit Handling** - Automatic storage deposit detection and handling in batch processing
3. **Queue.pull() renamed to Queue.peek()** - Better naming to reflect non-mutating behavior
4. **Stalled Item Management APIs** - Added `/transfer/:id/unstall` and `/transfers/unstall` endpoints
5. **Improved API Documentation** - Added OpenAPI schemas and Swagger UI

---

## 🔴 CRITICAL BUGS

### 1. **In-Memory Database in Production (CRITICAL)**
**Location:** `src/index.ts:23`
```typescript
const db = new Database(":memory:");
```
**Issue:** The database is using an in-memory SQLite database, which means:
- All data is lost when the process restarts
- Cannot be used in multi-instance deployments
- No persistence of transaction state
- TODOs acknowledging this but not fixed

**Impact:** Production data loss, inability to scale horizontally.

**Recommendation:** Use a persistent database file or external database system.

---

### 2. **Missing Environment Variable Validation**
**Location:** `src/index.ts:27-30`
```typescript
const executor = new Executor(queue, {
  rpcUrl: process.env.NEAR_RPC_URL!,
  accountId: process.env.NEAR_ACCOUNT_ID!,
  contractId: process.env.NEAR_CONTRACT_ID!,
  privateKey: process.env.NEAR_PRIVATE_KEY!,
});
```
**Issue:** Using non-null assertions (`!`) without validating environment variables exist. If any env var is missing, the app will crash at runtime.

**Impact:** Runtime crashes with unclear error messages.

**Recommendation:** Add validation at startup:
```typescript
const requiredEnvVars = ['NEAR_RPC_URL', 'NEAR_ACCOUNT_ID', 'NEAR_CONTRACT_ID', 'NEAR_PRIVATE_KEY'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}
```

---

### 3. **Queue.peek() Returns Same Items on Multiple Calls (Race Condition)**
**Location:** `src/queue/index.ts:123-134`

**Issue:** The `peek()` method (renamed from `pull()`) doesn't mark items as "being processed" - it only filters by `batch_id IS NULL`. This means:
- Multiple concurrent peeks return the same items
- No locking mechanism
- Race conditions in concurrent environments
- Same transfer could be processed multiple times if multiple executors call peek before creating signed transactions

**Impact:** Same transfer could be processed multiple times in concurrent environments.

**Recommendation:** Implement optimistic or pessimistic locking mechanism. Consider renaming to `pull()` with atomic claim operation, or add a separate `claim()` method.

---

### 4. **Race Condition in Batch Processing**
**Location:** `src/executor/index.ts:181-252`

**Issue:** Between `peek()` and `createSignedTransaction()`, items remain in pending state and could be peeked again by another executor instance or loop iteration.

**Timeline:**
1. Executor A peeks items (items still have `batch_id = NULL`)
2. Executor B peeks same items (before A creates signed transaction)
3. Both create different signed transactions for same items
4. Double-spending or inconsistent state

**Impact:** Critical for horizontal scaling and high-frequency execution.

**Recommendation:** Implement pessimistic locking or use SELECT FOR UPDATE pattern, or use a distributed lock service.

---

### 5. **Incomplete Error Handling in Recovery**
**Location:** `src/executor/index.ts:85-130`

**Issue:** `recoverProcessingTransactions()` re-broadcasts all pending signed transactions on startup, but:
- No check if transaction was already successful on-chain
- Could re-broadcast already-successful transactions
- May cause `InvalidNonce` errors

**Impact:** Could fail recovery due to nonce issues or duplicate transactions.

**Recommendation:** Query transaction status from blockchain before re-broadcasting.

---

### 6. **SQL Injection Risk in Dynamic Query Construction**
**Location:** `src/queue/index.ts:156-159` and `src/queue/index.ts:219-224`
```typescript
const placeholders = queueIds.map(() => "?").join(",");
this.db.run(
  `UPDATE queue SET batch_id = ?, updated_at = ? WHERE id IN (${placeholders})`,
  [batchId, now, ...queueIds],
);
```
**Issue:** While parameterized, the dynamic SQL construction with template literals for placeholders could be error-prone if modified incorrectly.

**Severity:** Medium (currently safe but fragile pattern).

**Recommendation:** Consider using a query builder or ORM for complex queries.

---

### 7. **Transaction Status Type Safety Issue**
**Location:** `src/types.ts:38-47`
```typescript
export type TransactionStatus = {
  SuccessValue?: string;
  Failure?: {
    ActionError?: {
      index?: number;
      kind: any; // ⚠️ Using 'any'
    };
    InvalidTxError?: any; // ⚠️ Using 'any'
  };
};
```
**Issue:** Using `any` types loses type safety for error handling.

**Impact:** Potential runtime errors, harder debugging.

**Recommendation:** Define proper error types based on NEAR protocol specifications.

---

### 8. **Unbounded Retry Loop**
**Location:** `src/queue/index.ts:257-260` and `src/executor/index.ts:255-291`

**Issue:** Failed batches increment `retry_count` but there's no maximum retry limit. Items will retry forever.

**Impact:** Infinite retry loops for permanently failing transactions, wasting resources.

**Recommendation:** Add max retry count (e.g., 5) and mark as `failed` or `stalled` after exceeding.

---

## ⚠️ PERFORMANCE ISSUES

### 1. **No Connection Pooling**
**Location:** `src/executor/index.ts:67`

**Issue:** Each executor creates its own JSON-RPC provider without connection pooling or reuse.

**Impact:** Increased latency and connection overhead under high load.

**Recommendation:** Implement connection pooling or reuse providers across requests.

---

### 2. **Inefficient Polling Interval**
**Location:** `src/executor/index.ts:148-178`

**Issue:** Default 500ms polling interval continues even when queue is empty, wasting CPU cycles.

**Recommendation:** Implement exponential backoff when queue is empty:
```typescript
let backoff = 500;
if (items.length === 0) {
  backoff = Math.min(backoff * 2, 5000); // Max 5 seconds
} else {
  backoff = 500; // Reset on activity
}
```

---

### 3. **Lack of Batch Size Optimization**
**Location:** `src/executor/index.ts:47`

**Issue:** Fixed batch size of 100, but optimal size depends on:
- Gas limits per transaction
- Network conditions
- Transaction complexity
- Success/failure rates

**Recommendation:** Make batch size adaptive based on recent success rates and gas usage patterns.

---

### 4. **No Index on is_stalled Column**
**Location:** `src/queue/index.ts:32-70`

**Issue:** The peek query filters on `is_stalled = 0` but there's no index on this column:
```sql
SELECT * FROM queue WHERE batch_id IS NULL AND is_stalled = 0
```

**Impact:** Full table scans as queue grows, degrading performance.

**Recommendation:** Add composite index:
```sql
CREATE INDEX IF NOT EXISTS idx_pending_items ON queue(batch_id, is_stalled) WHERE batch_id IS NULL;
```

---

### 5. **EventEmitter Without Error Handling**
**Location:** `src/queue/index.ts:18`, `src/executor/index.ts:34`

**Issue:** EventEmitters can throw if listeners throw errors, but no error event handlers are configured.

**Impact:** Unhandled promise rejections could crash the process.

**Recommendation:** Add error event handlers:
```typescript
this.on('error', (err) => {
  console.error('EventEmitter error:', err);
});
```

---

### 6. **Synchronous DB Operations in Hot Path**
**Location:** Multiple locations in `src/queue/index.ts`

**Issue:** All SQLite operations are synchronous (using `db.run()`, `db.query()`) which blocks the event loop.

**Impact:** Reduced throughput under load, especially for API endpoints.

**Recommendation:** Consider using async SQLite wrapper or move to async-capable database.

---

### 7. **N+1 Query Pattern in Status Endpoint**
**Location:** `src/index.ts:289-312`
```typescript
const item = queue.getById(id);
// ...
const batchInfo = queue.getBatchTransactionById(item.batch_id);
```

**Issue:** Two separate queries instead of a single JOIN.

**Impact:** Increased latency for status checks.

**Recommendation:** Create a single method with JOIN:
```typescript
getItemWithBatchInfo(id: number): ItemWithBatch | null {
  return this.db.query(`
    SELECT q.*, bt.status, bt.tx_hash
    FROM queue q
    LEFT JOIN batch_transactions bt ON q.batch_id = bt.id
    WHERE q.id = ?
  `).get(id);
}
```

---

## 🔒 SECURITY CONCERNS

### 1. **Private Key in Environment Variable**
**Location:** `src/index.ts:30`

**Issue:** Storing private keys in environment variables is risky:
- Visible in process listings (`ps aux`)
- Logged in crash dumps and error reports
- Accessible to any process with same user privileges
- May be logged by container orchestration systems

**Impact:** Potential key theft and unauthorized access to funds.

**Recommendation:** Use secure key management systems:
- AWS KMS or Secrets Manager
- HashiCorp Vault
- Azure Key Vault
- Hardware Security Modules (HSM)

---

### 2. **No Rate Limiting on API Endpoints**
**Location:** `src/index.ts:46-431`

**Issue:** No rate limiting on `/transfer`, `/transfers`, and other endpoints.

**Impact:**
- DoS attack vector - flood queue with spam transfers
- Resource exhaustion
- Potential fund drainage through excessive transactions

**Recommendation:** Implement rate limiting:
```typescript
import { rateLimiter } from 'hono-rate-limiter';

app.use('/transfer*', rateLimiter({
  windowMs: 60 * 1000, // 1 minute
  limit: 100, // requests per window
  standardHeaders: 'draft-6',
  keyGenerator: (c) => c.req.header('x-forwarded-for') ?? 'anonymous'
}));
```

---

### 3. **No Authentication/Authorization**
**Location:** All API endpoints

**Issue:** API endpoints are completely open - anyone can:
- Submit transfers
- Check transfer status
- Unstall transfers
- Potentially drain funds

**Impact:** Unauthorized usage, potential fund drainage, no audit trail.

**Recommendation:** Implement API key authentication or OAuth2:
```typescript
app.use('/transfer*', async (c, next) => {
  const apiKey = c.req.header('X-API-Key');
  if (!apiKey || !await validateApiKey(apiKey)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});
```

---

### 4. **Basic Input Validation for Account IDs**
**Location:** `src/schemas.ts:4-13`
```typescript
receiver_account_id: z.string().min(1).openapi({
  example: "alice.testnet",
  description: "NEAR account ID to receive the tokens"
}),
```

**Issue:** Minimal validation for account IDs. While account existence is now validated, the schema doesn't enforce NEAR naming rules:
- Valid characters: lowercase a-z, 0-9, `-`, `_`, `.`
- Length restrictions
- Format validation

**Impact:**
- Could cause transaction failures
- Potential for injection attacks if account IDs are logged

**Recommendation:** Add proper validation:
```typescript
receiver_account_id: z.string()
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, 'Invalid NEAR account ID format')
  .min(2)
  .max(64),
```

---

### 5. **Exposed Transaction Information**
**Location:** `src/index.ts:256-327`

**Issue:** Anyone can query any transfer by ID without authentication:
```typescript
app.openapi(getTransferRoute, async (c) => {
  // No auth check
  const item = queue.getById(id);
  return c.json(item);
});
```

**Impact:**
- Privacy leakage - transaction amounts and recipients exposed
- Information disclosure for transaction tracking
- Potential competitive intelligence leakage

**Recommendation:** Add authentication or at least require API key/token.

---

### 6. **No HTTPS Enforcement**
**Location:** Configuration missing

**Issue:** No configuration forcing HTTPS in production.

**Impact:**
- API keys transmitted in plaintext
- Transaction data visible to network sniffers
- Man-in-the-middle attack potential

**Recommendation:** Add HTTPS middleware:
```typescript
app.use('*', async (c, next) => {
  if (process.env.NODE_ENV === 'production' && !c.req.header('x-forwarded-proto')?.includes('https')) {
    return c.redirect(`https://${c.req.header('host')}${c.req.path}`, 301);
  }
  await next();
});
```

---

### 7. **Missing CORS Configuration**
**Location:** Configuration missing

**Issue:** No CORS middleware configured.

**Impact:** Either:
- Too permissive (allowing all origins) - XSS risks
- Too restrictive (blocking legitimate clients)

**Recommendation:** Configure CORS explicitly:
```typescript
import { cors } from 'hono/cors';

app.use('/*', cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PATCH'],
  credentials: true,
}));
```

---

## 📊 CODE QUALITY & MAINTAINABILITY

### 1. **Inconsistent Logging**
**Location:** Various files

**Issue:** Mix of `console.info()` and `console.error()` without:
- Structured logging
- Log levels
- Contextual metadata
- Correlation IDs

**Example locations:**
- `src/executor/index.ts:89, 93, 99, 111, 118`
- `src/index.ts` (no logging at all for API requests)

**Impact:**
- Difficult to debug in production
- Cannot filter or search logs effectively
- Missing important context

**Recommendation:** Use structured logger:
```typescript
import pino from 'pino';
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  }
});

logger.info({ batchId, itemCount }, 'Processing batch');
```

---

### 2. **Magic Numbers**
**Location:** `src/executor/index.ts:323-324, 338-339`
```typescript
1000000000000n * 3n, // Gas: 3 TGas
1250000000000000000000n, // 0.00125 NEAR (typical NEP-141 storage deposit)
```

**Issue:** Hard-coded values without named constants.

**Impact:**
- Difficult to understand intent
- Hard to maintain
- Easy to make mistakes when modifying

**Recommendation:** Extract to named constants:
```typescript
const GAS_PER_FT_TRANSFER = 3_000_000_000_000n; // 3 TGas
const STORAGE_DEPOSIT_AMOUNT = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const YOCTO_NEAR_DEPOSIT = 1n; // 1 yoctoNEAR for ft_transfer

// Usage:
actionCreators.functionCall(
  "ft_transfer",
  { receiver_id: receiverId, amount: amount, memo: null },
  GAS_PER_FT_TRANSFER,
  YOCTO_NEAR_DEPOSIT,
);
```

---

### 3. **TODOs in Production Code**
**Locations:**
- `src/index.ts:22` - "TODO: This should not use memory in production"

**Impact:**
- Incomplete features
- Known issues not addressed
- Production-blocking problems

**Recommendation:**
- Create GitHub issues for each TODO
- Prioritize and schedule fixes
- Remove TODOs or convert to proper issue tracking

---

### 4. **Missing JSDoc Comments**
**Location:** Most public methods

**Issue:** No documentation for public API methods like:
- `Queue.push()`
- `Queue.peek()`
- `Executor.start()`
- `Executor.processBatch()`

**Impact:**
- Difficult for new developers
- Unclear behavior and contracts
- No IDE hints

**Recommendation:** Add comprehensive JSDoc:
```typescript
/**
 * Adds a transfer request to the queue. If mergeExistingAccounts is enabled
 * and a pending transfer exists for the same receiver, amounts will be merged.
 *
 * @param transfer - Transfer request with receiver and amount
 * @returns The ID of the queue item (new or existing)
 * @throws Never throws - database errors will propagate
 */
push(transfer: TransferRequest): number {
  // ...
}
```

---

## 📝 RECOMMENDATIONS SUMMARY

### 🔴 Immediate (Critical) - Fix Before Production:
1. **Fix in-memory database** - Use persistent storage (file-based SQLite or PostgreSQL)
2. **Add environment variable validation** - Fail fast on startup if config missing
3. **Implement proper locking** in `queue.peek()` to prevent race conditions
4. **Add max retry limit** - Prevent infinite retry loops
5. **Add authentication** - Protect API endpoints from unauthorized access
6. **Query transaction status before re-broadcasting** in recovery

### 🟡 High Priority - Fix Within 1-2 Weeks:
7. **Implement rate limiting** - Prevent DoS attacks
8. **Fix race conditions** in batch processing for horizontal scaling
9. **Add NEAR account ID format validation** - Prevent invalid input
10. **Add HTTPS enforcement** - Secure communication in production

### 🟢 Medium Priority - Fix Within 1 Month:
11. **Add database indices** - Improve query performance (`is_stalled` column)
12. **Implement exponential backoff** - Reduce polling overhead
13. **Add structured logging** - Better observability and debugging
14. **Improve error type safety** - Remove `any` types
15. **Optimize N+1 queries** - Use JOINs for better performance
16. **Add CORS configuration** - Proper cross-origin security

### 🔵 Nice to Have - Future Improvements:
17. **Add comprehensive JSDoc** - Improve developer experience
18. **Extract magic numbers** to named constants
19. **Implement connection pooling** - Better resource utilization
20. **Secure key management** - Move from env vars to KMS
21. **Resolve all TODOs** - Complete incomplete features

---

## 🎯 CRITICAL PATH TO PRODUCTION

To make this production-ready, address these in order:

1. **Data Persistence** (1-2 days)
   - Replace `:memory:` with file-based SQLite
   - Add database backup strategy
   - Test recovery after restart

2. **Security Basics** (2-3 days)
   - Add API authentication (API keys)
   - Implement rate limiting
   - Add NEAR account ID format validation

3. **Concurrency Fixes** (3-5 days)
   - Fix race conditions in queue.peek()
   - Add proper locking mechanism
   - Test with multiple executor instances

4. **Error Handling** (2-3 days)
   - Add max retry limits
   - Check transaction status before re-broadcasting in recovery
   - Add proper transaction status checking

5. **Observability** (2-3 days)
   - Add structured logging
   - Set up monitoring/alerting
   - Add health check endpoint

6. **Server Configuration** (1 day)
   - Configure HTTPS enforcement
   - Set up CORS properly

**Total estimated time:** 2-3 weeks of focused development

---

## 📋 CONCLUSION

This codebase demonstrates **good architectural patterns** and **recent improvements**:
- ✅ Queue-based processing for reliability
- ✅ Recovery mechanisms for failure handling
- ✅ Event system for observability
- ✅ Batch processing for efficiency
- ✅ **Account validation with storage deposit checks** (NEW)
- ✅ **Stalled item management APIs** (NEW)
- ✅ **Automatic storage deposit handling** (NEW)
- ✅ **OpenAPI documentation with Swagger UI** (NEW)

However, it still has **critical production-readiness issues**:
- ❌ **Data persistence** - Complete data loss on restart
- ❌ **Concurrency bugs** - Cannot scale horizontally safely
- ❌ **Security** - No authentication or authorization
- ❌ **Race conditions** - peek() doesn't claim items atomically

**Overall Assessment:** This is an **improved MVP** that needs additional hardening before production use. The core logic is sound and recent additions show good progress, but infrastructure concerns (persistence, security, scalability) still need to be addressed.

**Risk Level:** 🔴 **HIGH** - Do not deploy to production without addressing critical issues.

**Recommended Action:** Dedicate 2-3 weeks to address critical and high-priority items before any production deployment.

---

## ✅ RESOLVED ISSUES (Since Original Audit)

The following issues from the original audit have been **successfully resolved**:

1. ✅ **Account Validation Added** - `AccountValidator` class now validates account existence before queueing transfers
2. ✅ **Storage Deposit Detection** - Automatic detection and handling of storage deposits in batch processing
3. ✅ **Queue Method Naming** - `pull()` renamed to `peek()` to better reflect non-mutating behavior
4. ✅ **Stalled Item Management** - Added unstall endpoints: `PATCH /transfer/:id/unstall` and `PATCH /transfers/unstall`
5. ✅ **API Documentation** - OpenAPI schemas and Swagger UI at `/ui` endpoint

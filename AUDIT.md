# Repository Audit Report: near-ft-transfers

**Audit Date:** 2025-10-05
**Auditor:** Claude Code
**Repository:** NEAR Protocol FT Transfer Service with Queue-Based Execution

## Executive Summary
This is a NEAR Protocol FT transfer service with a queue-based execution system. I've identified **12 critical bugs**, **8 performance issues**, **7 security concerns**, and **5 code quality/maintainability issues**.

---

## 🔴 CRITICAL BUGS

### 1. **In-Memory Database in Production (CRITICAL)**
**Location:** `src/index.ts:8`
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
**Location:** `src/index.ts:12-15`
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

### 3. **Queue.pull() Returns Same Items on Multiple Calls**
**Location:** `src/queue/index.ts:122-134`

**Issue:** The `pull()` method doesn't mark items as "being processed" - it only filters by `batch_id IS NULL`. This means:
- Multiple concurrent pulls return the same items
- No locking mechanism
- Race conditions in concurrent environments

**Evidence:** Test at `tests/queue.test.ts:102-105` shows this behavior:
```typescript
// Pull again - should get same items since they haven't been assigned to a batch yet
const items2 = queue.pull(10);
expect(items2).toHaveLength(1);
```

**Impact:** Same transfer could be processed multiple times if executor calls pull before creating the signed transaction.

**Recommendation:** Consider implementing optimistic locking or marking items during pull.

---

### 4. **Race Condition in Batch Processing**
**Location:** `src/executor/index.ts:175-198`

**Issue:** Between `pull()` and `createSignedTransaction()`, items remain in pending state and could be pulled again by another executor instance or loop iteration.

**Timeline:**
1. Executor A pulls items (items still have `batch_id = NULL`)
2. Executor B pulls same items (before A creates signed transaction)
3. Both create different signed transactions for same items
4. Double-spending or inconsistent state

**Impact:** Critical for horizontal scaling and high-frequency execution.

**Recommendation:** Implement pessimistic locking or use SELECT FOR UPDATE pattern.

---

### 5. **Stalled Items Not Included in Recovery**
**Location:** `src/queue/index.ts:122-128` and `src/executor/index.ts:79-80`

**Issue:** Stalled items (`is_stalled = 1`) are permanently excluded from processing, but there's no mechanism to:
- Review stalled items
- Manually retry them
- Clear the stalled flag

**Impact:** Items can get permanently stuck without manual database intervention.

**Recommendation:** Add API endpoints to view, retry, or clear stalled items.

---

### 6. **Incomplete Error Handling in Recovery**
**Location:** `src/executor/index.ts:85-124`

**Issue:** `recoverProcessingTransactions()` re-broadcasts all pending signed transactions on startup, but:
- No check if transaction was already successful on-chain
- Could re-broadcast already-successful transactions
- May cause `InvalidNonce` errors

**Impact:** Could fail recovery due to nonce issues or duplicate transactions.

**Recommendation:** Query transaction status from blockchain before re-broadcasting.

---

### 7. **SQL Injection Risk in Dynamic Query Construction**
**Location:** `src/queue/index.ts:156-159` and `src/queue/index.ts:239`
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

### 8. **Missing Server Startup Code**
**Location:** `src/index.ts` (end of file)

**Issue:** The Hono app is created but never started with proper Bun server export or `app.listen()`. The API endpoints are defined but not accessible.

**Impact:** The API endpoints are defined but not actually serving requests.

**Recommendation:** Add proper Bun server export:
```typescript
const port = parseInt(process.env.PORT || "3000");
console.info(`Server starting on port ${port}`);
export default {
  port,
  fetch: app.fetch,
};
```

---

### 9. **Transaction Status Type Safety Issue**
**Location:** `src/types.ts:33-42`
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

### 10. **Unbounded Retry Loop**
**Location:** `src/queue/index.ts:210-214` and `src/executor/index.ts:142-173`

**Issue:** Failed batches increment `retry_count` but there's no maximum retry limit. Items will retry forever.

**Impact:** Infinite retry loops for permanently failing transactions, wasting resources.

**Recommendation:** Add max retry count (e.g., 5) and mark as `failed` or `stalled` after exceeding.

---

### 11. **Potential Logic Error in Batch Recovery**
**Location:** `src/queue/index.ts:210-214`
```typescript
// Reset queue items to pending by clearing batch_id and incrementing retry_count
this.db.run(
  "UPDATE queue SET batch_id = NULL, retry_count = retry_count + 1, updated_at = ? WHERE batch_id = ?",
  [now, batchId],
);
```
**Issue:** The WHERE clause uses `batch_id = ?` which should work, but the logic happens within a transaction that first deletes the batch, which might cause issues if batch_id foreign key constraints exist.

**Impact:** Potential for retry logic not working correctly in edge cases.

**Recommendation:** Verify transaction order and consider using a temporary variable.

---

### 12. **Missing Transaction Atomicity in processBatch**
**Location:** `src/executor/index.ts:175-246`

**Issue:** The batch processing has multiple failure points between database updates and RPC calls without proper compensation:
1. Creates signed transaction in DB
2. Broadcasts to network (could fail)
3. Updates DB based on result

If step 2 fails with network error, the signed transaction remains in DB but was never broadcast.

**Impact:** Orphaned signed transactions in processing state that may or may not have been broadcast.

**Recommendation:** The recovery mechanism handles this, but add explicit timeout tracking.

---

## ⚠️ PERFORMANCE ISSUES

### 1. **No Connection Pooling**
**Location:** `src/executor/index.ts:67-74`

**Issue:** Each executor creates its own JSON-RPC provider without connection pooling or reuse.

**Impact:** Increased latency and connection overhead under high load.

**Recommendation:** Implement connection pooling or reuse providers across requests.

---

### 2. **Inefficient Polling Interval**
**Location:** `src/executor/index.ts:142-173`

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
**Location:** `src/queue/index.ts:38-76`

**Issue:** The pull query filters on `is_stalled = 0` but there's no index on this column:
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
**Location:** `src/queue/index.ts:25`, `src/executor/index.ts:34`

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

### 7. **No Database Vacuuming**
**Location:** `src/queue/index.ts`

**Issue:** SQLite database will grow over time due to deleted batch_transactions records, never reclaiming space.

**Impact:** Increasing disk usage and degraded performance.

**Recommendation:** Implement periodic maintenance:
```typescript
// Run weekly or after X deletions
db.run('PRAGMA auto_vacuum = INCREMENTAL');
db.run('PRAGMA incremental_vacuum');
```

---

### 8. **N+1 Query Pattern in Status Endpoint**
**Location:** `src/index.ts:77-116`
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
**Location:** `src/index.ts:15`

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
**Location:** `src/index.ts:20-68`

**Issue:** No rate limiting on `/transfer` and `/transfers` endpoints.

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

### 4. **No Input Sanitization for Account IDs**
**Location:** `src/types.ts:3-5`
```typescript
receiver_account_id: z.string().min(1),
```

**Issue:** No validation that account ID follows NEAR naming rules:
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
**Location:** `src/index.ts:70-117`

**Issue:** Anyone can query any transfer by ID without authentication:
```typescript
app.get("/transfer/:id", async (c) => {
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
  allowMethods: ['GET', 'POST'],
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
- `src/executor/index.ts:89, 100, 109, 169`
- `src/index.ts` (no logging at all)

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
**Location:** `src/executor/index.ts:256-257`
```typescript
1000000000000n * 3n, // Gas: 3 TGas
1n, // Attached deposit: 1 yoctoNEAR
```

**Issue:** Hard-coded values without named constants.

**Impact:**
- Difficult to understand intent
- Hard to maintain
- Easy to make mistakes when modifying

**Recommendation:** Extract to named constants:
```typescript
const GAS_PER_FT_TRANSFER = 3_000_000_000_000n; // 3 TGas
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
- `src/index.ts:7` - "TODO: This should not use memory in production"
- `src/index.ts:22, 44` - "TODO: validate accountId should be a valid account and already deposited funds"
- `src/executor/index.ts:254` - "TODO: handle memo"

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
- `Queue.pull()`
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

### 5. **Test Coverage Gaps**
**Missing test coverage for:**
- Stalled item recovery and retry mechanism
- Max retry limit behavior (doesn't exist yet)
- Concurrent executor instances running simultaneously
- API endpoint error cases (400, 404, 500)
- Database transaction rollback scenarios
- Network failure recovery
- Invalid transaction signatures

**Recommendation:** Add integration tests for:
```typescript
describe("Error Handling", () => {
  test("should handle database connection failures");
  test("should handle RPC timeout errors");
  test("should handle invalid signatures");
});

describe("Concurrent Operations", () => {
  test("should handle multiple executors safely");
  test("should prevent double-processing of items");
});
```

---

## 📝 RECOMMENDATIONS SUMMARY

### 🔴 Immediate (Critical) - Fix Before Production:
1. **Fix in-memory database** - Use persistent storage (file-based SQLite or PostgreSQL)
2. **Add environment variable validation** - Fail fast on startup if config missing
3. **Implement proper locking** in `queue.pull()` to prevent race conditions
4. **Add server startup code** - Export Bun server properly to serve HTTP
5. **Add max retry limit** - Prevent infinite retry loops
6. **Add authentication** - Protect API endpoints from unauthorized access

### 🟡 High Priority - Fix Within 1-2 Weeks:
7. **Implement rate limiting** - Prevent DoS attacks
8. **Add stalled item management** - API to view/retry/clear stalled items
9. **Fix race conditions** in batch processing for horizontal scaling
10. **Validate NEAR account IDs** - Prevent invalid input
11. **Add HTTPS enforcement** - Secure communication in production
12. **Query transaction status** before re-broadcasting in recovery

### 🟢 Medium Priority - Fix Within 1 Month:
13. **Add database indices** - Improve query performance
14. **Implement exponential backoff** - Reduce polling overhead
15. **Add structured logging** - Better observability and debugging
16. **Improve error type safety** - Remove `any` types
17. **Optimize N+1 queries** - Use JOINs for better performance
18. **Add CORS configuration** - Proper cross-origin security

### 🔵 Nice to Have - Future Improvements:
19. **Add comprehensive JSDoc** - Improve developer experience
20. **Extract magic numbers** to named constants
21. **Add more comprehensive tests** - Edge cases and error scenarios
22. **Implement connection pooling** - Better resource utilization
23. **Secure key management** - Move from env vars to KMS
24. **Database vacuuming** - Scheduled maintenance tasks
25. **Resolve all TODOs** - Complete incomplete features

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
   - Add input validation for account IDs

3. **Concurrency Fixes** (3-5 days)
   - Fix race conditions in queue.pull()
   - Add proper locking mechanism
   - Test with multiple executor instances

4. **Server Configuration** (1 day)
   - Add proper Bun server export
   - Configure HTTPS
   - Set up CORS

5. **Error Handling** (2-3 days)
   - Add max retry limits
   - Implement stalled item management
   - Add proper transaction status checking

6. **Observability** (2-3 days)
   - Add structured logging
   - Set up monitoring/alerting
   - Add health check endpoint

**Total estimated time:** 2-3 weeks of focused development

---

## 📋 CONCLUSION

This codebase demonstrates **good architectural patterns**:
- ✅ Queue-based processing for reliability
- ✅ Recovery mechanisms for failure handling
- ✅ Event system for observability
- ✅ Batch processing for efficiency

However, it has **critical production-readiness issues**:
- ❌ **Data persistence** - Complete data loss on restart
- ❌ **Concurrency bugs** - Cannot scale horizontally
- ❌ **Security** - No authentication or authorization
- ❌ **Server startup** - API not actually accessible

**Overall Assessment:** This is a **prototype/MVP** that needs significant hardening before production use. The core logic is sound, but infrastructure concerns (persistence, security, scalability) are not addressed.

**Risk Level:** 🔴 **HIGH** - Do not deploy to production without addressing critical issues.

**Recommended Action:** Dedicate 2-3 weeks to address critical and high-priority items before any production deployment.

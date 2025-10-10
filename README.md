# near-ft-transfers

A production-ready NEAR Protocol fungible token (FT) transfer service with a robust queue-based execution system. This service provides reliable, batched FT transfers with automatic retry mechanisms, failure recovery, and transaction tracking.

## Overview

This service provides a REST API for queuing and executing NEAR FT transfers. It uses a queue-based architecture to batch multiple transfers together, reducing gas costs and improving throughput. The system is designed to handle failures gracefully with automatic recovery mechanisms.

### Key Features

- **Batched Transactions**: Groups multiple FT transfers into single NEAR transactions (up to 100 transfers per batch)
- **Account Validation**: Validates receiver accounts exist on NEAR and have storage deposits before queueing
- **Intelligent Caching**: Caches validation results to minimize RPC calls and improve performance
- **Automatic Deduplication**: Merges multiple transfers to the same account while in pending state
- **Failure Recovery**: Automatically recovers from mid-process failures and retries failed transactions
- **Individual Error Handling**: Isolates and stalls problematic transfers without affecting others in the batch
- **Transaction Tracking**: Provides real-time status updates and transaction hashes for all transfers
- **Event System**: Emits events for monitoring and observability
- **OpenAPI Documentation**: Built-in Swagger UI for API exploration and testing

## Quick Start

### Prerequisites

- **Bun** runtime (v1.2.18 or later) - [Install Bun](https://bun.sh)
- A NEAR Protocol account with private key
- Access to a NEAR RPC endpoint (testnet or mainnet)

### Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd near-ft-transfers
   ```

2. **Install dependencies**:
   ```bash
   bun install
   ```

3. **Configure environment variables**:

   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

   Edit `.env` with your configuration:
   ```bash
   # Required Configuration
   NEAR_RPC_URL=https://rpc.testnet.near.org
   NEAR_ACCOUNT_ID=your-account.testnet
   NEAR_CONTRACT_ID=ft-contract.testnet
   NEAR_PRIVATE_KEY=ed25519:your_private_key_here

   # Optional Configuration
   MAX_RETRIES=5
   DATABASE_PATH=:memory:
   NODE_ENV=development
   ```

   **Important**:
   - `DATABASE_PATH=:memory:` means data is stored in memory only (lost on restart)
   - For production, use a file path like `./data/transfers.db` for persistent storage
   - The private key format must be: `ed25519:base58_encoded_key`

4. **Start the service**:
   ```bash
   # Production mode
   bun start

   # Development mode with auto-reload
   bun run dev
   ```

5. **Access the API**:
   - **API Base URL**: `http://localhost:3000`
   - **Swagger UI**: `http://localhost:3000/ui`
   - **OpenAPI JSON**: `http://localhost:3000/doc`

The service will start on port 3000 by default and begin processing queued transfers automatically.

## Architecture

### Components

#### 1. **REST API** (`src/index.ts`)

- Built with Hono framework
- Exposes endpoints for submitting transfers and checking status
- Validates input using Zod schemas

#### 2. **Queue System** (`src/queue/index.ts`)

- SQLite-based queue with two tables:
  - `queue`: Stores individual transfer requests
  - `batch_transactions`: Stores signed transaction blobs and their status
- States: `pending` → `processing` → `success`/`failed`
- Supports deduplication by merging amounts for same receiver while pending
- Tracks stalled items separately to prevent blocking the queue

#### 3. **Executor** (`src/executor/index.ts`)

- Polls the queue at regular intervals (default: 500ms)
- Pulls pending items and batches them together (default: 100 items)
- Creates and signs NEAR transactions using `@near-js` libraries
- Broadcasts transactions and monitors their status
- Handles transaction failures with granular error recovery

#### 4. **Account Validator** (`src/validation.ts`)

- Validates NEAR account existence using RPC `view_account` method
- Checks storage deposit registration via FT contract's `storage_balance_of` method
- Implements intelligent caching with configurable TTL (default: 5 minutes)
- Supports batch validation for efficient multi-account checks
- Provides detailed error messages for debugging

## Service Flow: From Queue to Execution

### Complete Transfer Lifecycle

This section explains the entire flow of a transfer from the moment it's submitted to the API until it's executed on the NEAR blockchain.

### Phase 1: Transfer Submission & Validation

```
Client submits transfer via API
  ↓
1. Request Validation (Zod Schema)
   - Validates JSON format
   - Ensures receiver_account_id is a valid string
   - Ensures amount is a valid string number
  ↓
2. Account Validation (NEAR RPC)
   - Checks if account exists on NEAR (via view_account)
   - Checks storage deposit status (via storage_balance_of)
   - Results cached for 5 minutes
  ↓
3. Validation Results:
   ├─ Account doesn't exist
   │  └─ ❌ Return 400 error, DO NOT queue
   │
   └─ Account exists
      ├─ Has storage deposit (has_storage_deposit=true)
      │  └─ ✅ Queue transfer, return transfer_id
      │
      └─ No storage deposit (has_storage_deposit=false)
         └─ ⚠️ Queue transfer (flagged), return transfer_id
            (Executor will handle storage deposit automatically)
  ↓
4. Queue Storage (SQLite)
   - If duplicate receiver_account_id in pending state:
     └─ Merge amounts: new_amount = existing_amount + new_amount
   - Otherwise create new queue entry
   - Queue item status: PENDING (batch_id = NULL)
  ↓
5. Response to Client
   - Success: { transfer_id, success: true, message: "..." }
   - Error: { error: "Account does not exist" }
```

### Phase 2: Batch Processing (Executor Loop)

The executor runs continuously in the background (default: every 500ms):

```
Executor Poll Cycle (every 500ms)
  ↓
1. Check Queue
   - Peek at pending items (WHERE batch_id IS NULL AND is_stalled = 0)
   - Pull up to 100 items (configurable batch size)
  ↓
2. Calculate Action Limit
   - NEAR allows max 100 actions per transaction
   - For each item:
     * has_storage_deposit=false → 2 actions (storage_deposit + ft_transfer)
     * has_storage_deposit=true → 1 action (ft_transfer only)
   - Dynamically calculate how many items fit in batch
   - Defer remaining items to next batch
  ↓
3. Create Transaction
   - Build action list for each item:
     * If no storage deposit: storage_deposit(0.00125 NEAR, 3 TGas)
     * Always: ft_transfer(amount, 1 yoctoNEAR, 3 TGas)
   - Sign transaction with sender's private key
   - Calculate signed transaction hash (sha256)
  ↓
4. Store Transaction (Database Transaction)
   - Create batch_transactions record:
     * tx_hash: signed transaction hash
     * signed_tx: encoded transaction blob
     * status: PROCESSING
   - Update queue items:
     * Set batch_id to batch transaction ID
     * Items now in PROCESSING state
  ↓
5. Broadcast to NEAR
   - Send signed transaction via RPC
   - Wait for transaction result
  ↓
6. Handle Result → Go to Phase 3
```

### Phase 3: Transaction Result Handling

```
Transaction Result Received
  ↓
┌─────────────────────────────────────────────┐
│ CASE 1: Success ✅                          │
├─────────────────────────────────────────────┤
│ - Update batch_transactions:                │
│   * status = SUCCESS                        │
│   * tx_hash = actual transaction hash       │
│   * signed_tx = NULL (cleanup)              │
│ - Update all queue items in batch:          │
│   * has_storage_deposit = true              │
│ - Items now permanently in SUCCESS state    │
│ - Transaction hash available via API        │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ CASE 2: ActionError with Index 🔴          │
├─────────────────────────────────────────────┤
│ Specific action failed (e.g., action #5)    │
│ - Mark specific item as STALLED:           │
│   * is_stalled = 1                          │
│   * error_message = action error details    │
│ - Recover remaining items in batch:         │
│   * batch_id = NULL (back to pending)       │
│   * retry_count += 1                        │
│ - Delete batch_transactions record          │
│ - Stalled item excluded from future batches │
│ - Other items retried in next batch         │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ CASE 3: ActionError without Index 🟡       │
├─────────────────────────────────────────────┤
│ General action failure (index unknown)      │
│ - Recover ALL items in batch:              │
│   * batch_id = NULL (back to pending)       │
│   * retry_count += 1                        │
│   * error_message = error details           │
│ - Delete batch_transactions record          │
│ - Check retry limit:                        │
│   * If retry_count > MAX_RETRIES (default 5)│
│     └─ Mark as STALLED                      │
│ - Non-stalled items retried in next batch   │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ CASE 4: InvalidTxError 🟡                  │
├─────────────────────────────────────────────┤
│ Transaction structure/signature invalid     │
│ - Recover ALL items in batch:              │
│   * batch_id = NULL (back to pending)       │
│   * retry_count += 1                        │
│   * error_message = error details           │
│ - Delete batch_transactions record          │
│ - Check retry limit (same as CASE 3)        │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ CASE 5: Network Error / RPC Timeout 🔵     │
├─────────────────────────────────────────────┤
│ Failed to broadcast or get result           │
│ - Recover ALL items in batch:              │
│   * batch_id = NULL (back to pending)       │
│   * retry_count += 1                        │
│   * error_message = network error           │
│ - Keep signed_tx in batch_transactions      │
│ - Items retried in next batch               │
└─────────────────────────────────────────────┘
```

### Phase 4: Service Restart Recovery

When the service restarts (crash, deployment, etc.):

```
Service Starts
  ↓
1. Recovery Phase
   - Query batch_transactions WHERE status = PROCESSING AND signed_tx IS NOT NULL
  ↓
2. Re-broadcast Pending Transactions
   - For each pending batch:
     * Decode signed transaction blob
     * Re-send to NEAR RPC
     * Handle result (same as Phase 3)
  ↓
3. Reset Failed Batches
   - Delete batch_transactions WHERE status != SUCCESS
   - Reset associated queue items:
     * batch_id = NULL (back to pending)
  ↓
4. Start Executor Loop
   - Begin normal processing (Phase 2)
```

### Phase 5: Manual Recovery (Stalled Items)

Stalled items require manual intervention:

```
Admin Reviews Stalled Items
  ↓
1. Query Stalled Items
   GET /transfers?is_stalled=true
  ↓
2. Investigate Error
   - Check error_message field
   - Determine root cause
   - Fix underlying issue (e.g., insufficient balance, contract issue)
  ↓
3. Unstall Items
   - Single item: PATCH /transfer/{id}/unstall
   - Multiple items: PATCH /transfers/unstall {"ids": [1, 2, 3]}
   - All stalled: PATCH /transfers/unstall {"all": true}
  ↓
4. Items Reset to Pending
   - is_stalled = 0
   - batch_id = NULL
   - Automatically picked up by executor in next cycle
```

### State Diagram

```
                          ┌─────────────┐
                          │   PENDING   │ ← Initial state after queueing
                          │ (batch_id=  │
                          │    NULL)    │
                          └──────┬──────┘
                                 │
                    Executor picks up item
                                 │
                                 ▼
                          ┌─────────────┐
                          │ PROCESSING  │ ← Transaction created & broadcast
                          │(batch_id=ID)│
                          └──────┬──────┘
                                 │
                    Transaction result received
                                 │
           ┌─────────────────────┼─────────────────────┐
           │                     │                     │
           ▼                     ▼                     ▼
    ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
    │   SUCCESS   │      │   STALLED   │      │   PENDING   │
    │(batch_id=ID)│      │(is_stalled= │      │ (batch_id=  │
    │             │      │     1)      │      │   NULL)     │
    └─────────────┘      └──────┬──────┘      └──────┬──────┘
         Final                   │                    │
         state                   │                    │
                          Manual unstall        Retry in next
                                 │              batch (if retry
                                 │              count < max)
                                 ▼                    │
                          ┌─────────────┐            │
                          │   PENDING   │◄───────────┘
                          │ (batch_id=  │
                          │    NULL)    │
                          └─────────────┘
```

### Key Points

1. **Atomic Operations**: All database operations use transactions to ensure consistency
2. **Automatic Retry**: Failed items automatically retry up to MAX_RETRIES times
3. **Graceful Degradation**: Individual failures don't block other transfers
4. **Recovery Resilience**: Service can restart mid-process without losing transactions
5. **Storage Deposit**: Automatically handled during execution, transparent to clients

## API Documentation

The service provides comprehensive API documentation via OpenAPI/Swagger:

### Accessing Documentation

- **Swagger UI**: `http://localhost:3000/ui` - Interactive API documentation with request/response examples
- **OpenAPI JSON**: `http://localhost:3000/doc` - OpenAPI 3.0 specification in JSON format

The Swagger UI allows you to:
- Explore all available endpoints
- View request/response schemas
- Test API calls directly from the browser
- See example payloads for each endpoint

### Available Endpoints

All endpoints are documented in detail in the Swagger UI. Here's a quick overview:

#### Transfer Management
- `POST /transfer` - Queue a single transfer
- `POST /transfers` - Queue multiple transfers in batch
- `GET /transfer/{id}` - Get status of a specific transfer
- `GET /transfers` - List all transfers (with optional filters)

#### Recovery Operations
- `PATCH /transfer/{id}/unstall` - Unstall a single transfer
- `PATCH /transfers/unstall` - Unstall multiple or all stalled transfers

## Environment Configuration

The service requires specific environment variables to be configured. All configuration is validated on startup using Zod schemas.

### Required Variables

| Variable | Description | Example | Validation |
|----------|-------------|---------|------------|
| `NEAR_RPC_URL` | NEAR RPC endpoint URL | `https://rpc.testnet.near.org` | Must be a valid URL |
| `NEAR_ACCOUNT_ID` | Sender account ID (your account that sends tokens) | `your-account.testnet` | Must be non-empty string |
| `NEAR_CONTRACT_ID` | Fungible token contract ID | `ft-contract.testnet` | Must be non-empty string |
| `NEAR_PRIVATE_KEY` | Private key for sender account | `ed25519:5JueXZh...` | Must be in `ed25519:base58` format |

### Optional Variables

| Variable | Default | Description | Validation |
|----------|---------|-------------|------------|
| `MAX_RETRIES` | `5` | Maximum retry attempts before marking items as stalled | Integer between 0-100 |
| `DATABASE_PATH` | `:memory:` | Database file path (`:memory:` for in-memory, or file path for persistence) | Any valid string |
| `NODE_ENV` | `development` | Node environment | Must be: `development`, `production`, or `test` |

### Configuration Examples

**Development (In-Memory Database)**:
```bash
NEAR_RPC_URL=https://rpc.testnet.near.org
NEAR_ACCOUNT_ID=dev-account.testnet
NEAR_CONTRACT_ID=dev-ft.testnet
NEAR_PRIVATE_KEY=ed25519:3D4YudUahN1nawWogh8pAKrqXG8BQn6KhGvXkY4VgPCaF
MAX_RETRIES=5
DATABASE_PATH=:memory:
NODE_ENV=development
```

**Production (Persistent Database)**:
```bash
NEAR_RPC_URL=https://rpc.mainnet.near.org
NEAR_ACCOUNT_ID=production-account.near
NEAR_CONTRACT_ID=token.near
NEAR_PRIVATE_KEY=ed25519:YOUR_PRODUCTION_KEY_HERE
MAX_RETRIES=3
DATABASE_PATH=./data/transfers.db
NODE_ENV=production
```

### Configuration Validation

The service validates all environment variables on startup:
- Invalid or missing required variables will cause the service to fail with detailed error messages
- Type validation ensures integers are valid numbers
- URL validation ensures RPC endpoints are properly formatted
- Enum validation for NODE_ENV restricts to allowed values

**Example validation error**:
```
Environment validation failed:
  - NEAR_RPC_URL: NEAR_RPC_URL must be a valid URL
  - MAX_RETRIES: MAX_RETRIES must be a valid integer

Please check your .env file and ensure all required variables are set correctly.
```

### Important Notes

1. **Private Key Security**:
   - Never commit `.env` files to version control
   - Use `.env.example` as a template
   - In production, use secrets management (e.g., AWS Secrets Manager, HashiCorp Vault)

2. **Database Persistence**:
   - `:memory:` means data is lost on restart (good for development/testing)
   - File path means persistent storage (required for production)
   - Create directory structure before starting: `mkdir -p ./data`

3. **MAX_RETRIES**:
   - Lower values (3-5) prevent wasting gas on persistently failing transfers
   - Higher values increase resilience to temporary network issues
   - Items exceeding retry limit are marked as `stalled` and require manual intervention

4. **RPC Endpoints**:
   - Testnet: `https://rpc.testnet.near.org`
   - Mainnet: `https://rpc.mainnet.near.org`
   - Custom RPC: Use your own or third-party RPC for better performance

## Account Validation

The service validates receiver accounts with a two-tier approach:

### Validation Strategy

1. **Account Existence** (Blocking):
   - Checks if the NEAR account exists on the network
   - **Non-existent accounts are rejected with 400 error** - will not be queued
2. **Storage Deposit** (Non-blocking):
   - Verifies if the account has registered storage on the FT contract
   - **Accounts without storage deposit are queued but flagged** (`has_storage_deposit = false`)
   - These transfers can be processed later once storage deposit is registered
   - Executor can handle storage registration automatically (future enhancement)

### Caching

Validation results are cached to improve performance:

- Default cache TTL: 1 minute (60,000ms) - configurable
- Significantly reduces RPC calls for repeated transfers to same accounts
- Cache can be configured when initializing the validator

### Automatic Storage Deposit Registration

The executor **automatically handles storage deposit registration** during batch processing:

1. **Detection**: Checks `has_storage_deposit` flag for each item in the batch
2. **Action Creation**: 
   - If `has_storage_deposit=false`: Adds `storage_deposit` action before `ft_transfer`
   - If `has_storage_deposit=true`: Only adds `ft_transfer` action
3. **100-Action Limit**: Dynamically limits batch size to respect NEAR's 100 action/transaction limit
   - Items requiring storage deposit use 2 actions each
   - Items with storage deposit use 1 action each
   - Executor calculates how many items fit and defers the rest to next batch
4. **Success Tracking**: After successful transfer, sets `has_storage_deposit=true` for all items in batch

**Example Batch Processing:**
- 60 items without storage deposit = 120 actions needed
- Only 50 items can fit in one batch (50 × 2 = 100 actions)
- Remaining 10 items deferred to next batch
- Next batch can process those 10 items (already have storage deposit now, only 10 actions needed)

### Edge Cases Handled

1. **Non-existent Accounts**: Rejected immediately with 400 error - not queued
2. **Accounts Without Storage Deposit**: Queued with flag, executor handles registration automatically
3. **RPC Timeouts**: Configurable timeout prevents hanging on slow RPC responses
4. **Optional Storage Check**: Can skip storage validation for contracts that don't require it
5. **Network Errors**: Gracefully handles RPC failures with appropriate error messages
6. **Batch Validation**: Efficiently validates multiple accounts in parallel
7. **100-Action Limit**: Dynamically adjusts batch size when storage deposits are needed

### Transfer Flow Based on Validation

```
Account Validation
├── Account Does Not Exist
│   └── ❌ Reject (400 error) - Do not queue
│
└── Account Exists
    ├── Has Storage Deposit
    │   └── ✅ Queue with has_storage_deposit = true
    │       └── Will be processed normally
    │
    └── No Storage Deposit
        └── ⚠️ Queue with has_storage_deposit = false
            └── Flagged for later handling
            └── Executor will handle storage deposit
```

### Configuration Options

The validator accepts the following options:

- **`cacheTTL`**: Cache time-to-live in milliseconds (default: 60000 = 1 minute)
- **`timeout`**: RPC timeout in milliseconds (default: 10000 = 10 seconds)
- **`skipStorageCheck`**: Skip storage deposit validation (default: false)

## Testing

### Unit Tests

```bash
# Run all tests
bun test

# Run queue tests
bun test tests/queue.test.ts

# Run validation tests (requires NEAR RPC access)
bun test tests/validation.test.ts

# Run retry logic tests
bun test tests/queue-retry.test.ts

# Run executor tests (with NEAR sandbox)
bun run test:executor
```

### API Testing Scripts

The `scripts/` directory contains utility scripts for testing the API endpoints:

```bash
# Test single transfer endpoint (sends 10 sequential requests)
./scripts/test-transfer.sh

# Test batch transfers endpoint (sends 1 request with 10 transfers)
./scripts/test-transfers.sh

# Custom configuration
ITERATIONS=20 AMOUNT="5000000000000000000000000" ./scripts/test-transfer.sh
```

See [scripts/README.md](scripts/README.md) for detailed documentation on the testing scripts.

## Benchmarking

Run performance benchmarks to measure throughput and processing times:

```bash
# Run default benchmark (1000 transfers)
bun run bench

# Run with custom transfer count
TRANSFER_COUNT=5000 bun run bench

# Run with custom batch size
BATCH_SIZE=50 bun run bench

# Run with custom RPC port
RPC_PORT=55555 bun run bench

# Combine options
TRANSFER_COUNT=2000 BATCH_SIZE=100 bun run bench
```

The benchmark script (`bench/sandbox.bench.ts`) will:
- Start a local NEAR sandbox
- Deploy a test FT contract
- Set up test accounts
- Process the specified number of transfers
- Report detailed performance metrics:
  - Queue push time
  - Processing time
  - Total time
  - Average time per transfer
  - Throughput (transfers/sec)
  - Balance verification

**Environment Variables:**
- `TRANSFER_COUNT` - Number of transfers to process (default: 1000)
- `BATCH_SIZE` - Executor batch size (default: 100)
- `RPC_PORT` - Sandbox RPC port (default: 45555)

## Database Schema

### `queue` table

- `id`: Primary key
- `receiver_account_id`: NEAR account to receive tokens
- `amount`: Transfer amount (string number)
- `created_at`: Timestamp
- `updated_at`: Timestamp
- `retry_count`: Number of retry attempts
- `error_message`: Last error if any
- `batch_id`: Reference to batch_transactions (NULL = pending)
- `is_stalled`: Whether item is stalled due to persistent errors
- `has_storage_deposit`: Whether receiver account has registered storage deposit (0 = no, 1 = yes)

### `batch_transactions` table

- `id`: Primary key (referenced as batch_id)
- `tx_hash`: Transaction hash (initially signed tx hash, updated to actual hash on success)
- `signed_tx`: Encoded signed transaction blob (cleared after success)
- `status`: Transaction status (pending | processing | success | failed)
- `created_at`: Timestamp
- `updated_at`: Timestamp

## Advanced Configuration

The executor can be configured with:

```typescript
new Executor(queue, {
  rpcUrl: string,              // NEAR RPC endpoint
  accountId: string,           // Sender account
  contractId: string,          // FT contract
  privateKey: string,          // Sender private key
  batchSize: 100,              // Max items per batch (1-100)
  interval: 500,               // Polling interval in ms
  minQueueToProcess: 1,        // Min items before processing
  maxRetries: 5,               // Max retry attempts before stalling (default: 5)
});
```

The queue can be configured with:

```typescript
new Queue(db, {
  mergeExistingAccounts: true,        // Merge amounts for same account in pending state (default: true)
  defaultHasStorageDeposit: false,    // Default value for has_storage_deposit when not specified (default: false)
});
```

### Queue Configuration Options

#### `defaultHasStorageDeposit`

This option sets the default value for `has_storage_deposit` when pushing items to the queue without explicitly specifying it:

- **Default**: `false` (assumes accounts need storage deposit)
- **When to set `true`**: If your FT contract doesn't require storage deposits, or if you're confident all receiver accounts already have storage deposits registered
- **Override per-item**: Individual transfers can override this default by specifying `has_storage_deposit` explicitly

**Example usage:**

```typescript
// Queue with default: assumes storage deposits are needed
const queue1 = new Queue(db, {
  defaultHasStorageDeposit: false,  // default
});

queue1.push({
  receiver_account_id: "alice.near",
  amount: "1000",
  // has_storage_deposit will be false (uses queue default)
});

// Queue with custom default: assumes storage deposits exist
const queue2 = new Queue(db, {
  defaultHasStorageDeposit: true,
});

queue2.push({
  receiver_account_id: "bob.near",
  amount: "2000",
  // has_storage_deposit will be true (uses queue default)
});

queue2.push({
  receiver_account_id: "carol.near",
  amount: "3000",
  has_storage_deposit: false,  // Explicitly override the default
});
```

### Retry and Stalling Behavior

The system implements automatic retry logic with a configurable maximum:

1. **Retry Counter**: Each time a batch fails, the `retry_count` is incremented for all items in that batch
2. **Max Retries**: When `retry_count` exceeds `maxRetries` (default: 5), the item is automatically marked as `stalled`
3. **Stalled Items**: Items marked as stalled are excluded from the queue and won't be retried automatically
4. **Manual Recovery**: Stalled items can be manually unstalled via API endpoints:
   - `PATCH /transfer/:id/unstall` - Unstall a single item
   - `PATCH /transfers/unstall` - Unstall multiple items or all stalled items

**Example Scenario:**
- Item fails 6 times (retry_count = 6)
- maxRetries is set to 5
- Item is automatically marked as `is_stalled = 1`
- Item no longer appears in `queue.peek()` results
- Admin can review the error via `GET /transfers?is_stalled=true`
- Admin can unstall via `PATCH /transfer/:id/unstall` after fixing the underlying issue

---

This project was created using `bun init` in bun v1.2.18. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

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

### How It Works

#### 1. **Submitting Transfers**

```
POST /transfer or POST /transfers
  ↓
Validates request format (Zod schema)
  ↓
Validates account existence & storage deposit
  ↓
Returns 400 error if validation fails
  ↓
Adds to queue (merges if duplicate receiver_account_id exists in pending)
  ↓
Returns transfer_id(s)
```

#### 2. **Processing Flow**

```
Executor pulls pending items from queue
  ↓
For each item, determines required actions:
  - If has_storage_deposit=false: storage_deposit + ft_transfer (2 actions)
  - If has_storage_deposit=true: ft_transfer only (1 action)
  ↓
Limits batch to fit within 100 action maximum
  (Defers excess items to next batch)
  ↓
Creates NEAR FT transfer actions
  ↓
Signs batch transaction and stores signed blob in DB
  ↓
Broadcasts to NEAR network
  ↓
Handles result:
  - Success: Marks batch as success, updates tx_hash, sets has_storage_deposit=true
  - ActionError with index: Stalls specific item, retries rest
  - ActionError without index: Retries entire batch
  - InvalidTxError: Retries entire batch
```

#### 3. **Recovery Mechanism**

On service restart:

1. Re-broadcasts any pending signed transactions from the database
2. Resets items from failed batches back to pending
3. Deletes failed batch transaction records
4. Items are automatically retried in new batches

#### 4. **Error Handling Strategy**

- **Individual item errors** (ActionError with index): Item is marked as `stalled` and removed from retry cycle
- **Batch errors** (ActionError without index, InvalidTxError): All items returned to pending for retry with incremented `retry_count`
- **Network errors**: Batch recovered and items retried
- **Max retries exceeded**: After exceeding the configured maximum retry attempts (default: 5), items are automatically marked as `stalled` to prevent infinite retry loops

## Installation

```bash
bun install
```

## Configuration

Set the following environment variables:

```bash
NEAR_RPC_URL=https://rpc.testnet.near.org
NEAR_ACCOUNT_ID=your-account.testnet
NEAR_CONTRACT_ID=ft-contract.testnet
NEAR_PRIVATE_KEY=ed25519:...
MAX_RETRIES=5  # Maximum retry attempts before marking items as stalled (default: 5)
```

## Usage

### Starting the Service

```bash
bun run src/index.ts

# Or with auto-reload
bun run dev
```

### API Endpoints

#### Submit Single Transfer

```bash
POST /transfer
{
  "receiver_account_id": "alice.testnet",
  "amount": "1000000000000000000"  # String number in smallest units
}

Response (Success):
{
  "success": true,
  "transfer_id": 123,
  "message": "Transfer queued successfully..."
}

Response (Account Does Not Exist):
{
  "error": "Account 'alice.testnet' does not exist on NEAR"
}

Response (Account Exists but No Storage Deposit):
{
  "success": true,
  "transfer_id": 123,
  "has_storage_deposit": false,
  "message": "Transfer queued but receiver account needs storage deposit registration. This will be handled by the executor."
}
```

#### Submit Multiple Transfers

```bash
POST /transfers
[
  {
    "receiver_account_id": "alice.testnet",
    "amount": "1000000000000000000"
  },
  {
    "receiver_account_id": "bob.testnet",
    "amount": "2000000000000000000"
  }
]

Response (Success):
{
  "success": true,
  "transfer_ids": [123, 124],
  "message": "Transfers queued successfully..."
}

Response (Accounts Do Not Exist):
{
  "error": "One or more accounts do not exist on NEAR",
  "invalid_accounts": [
    {
      "accountId": "invalid.testnet",
      "error": "Account 'invalid.testnet' does not exist on NEAR"
    }
  ]
}

Response (Some Accounts Without Storage Deposit):
{
  "success": true,
  "transfer_ids": [123, 124],
  "message": "Transfers queued successfully. 1 transfer(s) need storage deposit registration which will be handled by the executor."
}
```

#### Check Transfer Status

```bash
GET /transfer/:id

Response:
{
  "id": 123,
  "receiver_account_id": "alice.testnet",
  "amount": "1000000000000000000",
  "status": "success",  # pending | processing | success | failed | stalled
  "tx_hash": "ABC123...",
  "error_message": null,
  "retry_count": 0,
  "is_stalled": false,
  "has_storage_deposit": true,
  "created_at": 1696500000000,
  "updated_at": 1696500001000
}
```

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

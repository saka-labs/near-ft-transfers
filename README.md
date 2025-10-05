# near-ft-transfers

A production-ready NEAR Protocol fungible token (FT) transfer service with a robust queue-based execution system. This service provides reliable, batched FT transfers with automatic retry mechanisms, failure recovery, and transaction tracking.

## Overview

This service provides a REST API for queuing and executing NEAR FT transfers. It uses a queue-based architecture to batch multiple transfers together, reducing gas costs and improving throughput. The system is designed to handle failures gracefully with automatic recovery mechanisms.

### Key Features

- **Batched Transactions**: Groups multiple FT transfers into single NEAR transactions (up to 100 transfers per batch)
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

### How It Works

#### 1. **Submitting Transfers**
```
POST /transfer or POST /transfers
  ↓
Validates request
  ↓
Adds to queue (merges if duplicate receiver_account_id exists in pending)
  ↓
Returns transfer_id(s)
```

#### 2. **Processing Flow**
```
Executor pulls pending items from queue
  ↓
Creates NEAR FT transfer actions (ft_transfer calls)
  ↓
Signs batch transaction and stores signed blob in DB
  ↓
Broadcasts to NEAR network
  ↓
Handles result:
  - Success: Marks batch as success, updates tx_hash
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

Response:
{
  "success": true,
  "transfer_id": 123,
  "message": "Transfer queued successfully..."
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

Response:
{
  "success": true,
  "transfer_ids": [123, 124],
  "message": "Transfers queued successfully..."
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
  "created_at": 1696500000000,
  "updated_at": 1696500001000
}
```

## Testing

```bash
# Run queue tests
bun test src/queue/queue.test.ts

# Run queue benchmark
bun run src/queue/queue.bench.ts

# Test with NEAR sandbox
bun run test:sandbox
```

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
});
```

---

This project was created using `bun init` in bun v1.2.18. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

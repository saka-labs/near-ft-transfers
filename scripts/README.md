# Test Scripts

This directory contains utility scripts for testing the NEAR FT transfer service API.

## Scripts

### `test-transfer.sh`

Tests the single transfer endpoint (`POST /transfer`) by sending multiple sequential requests.

**Usage:**
```bash
# Default configuration (10 requests to localhost:3000)
./scripts/test-transfer.sh

# Custom configuration
AMOUNT="5000000000000000000000000" \
URL="http://localhost:3000/transfer" \
ITERATIONS=20 \
./scripts/test-transfer.sh
```

**Environment Variables:**
- `AMOUNT` - Amount to transfer (default: `1000000000000000000000000`)
- `URL` - API endpoint URL (default: `http://localhost:3000/transfer`)
- `ITERATIONS` - Number of requests to send (default: `10`)

**Example Output:**
```
Testing transfer endpoint...
URL: http://localhost:3000/transfer
Amount: 1000000000000000000000000
Iterations: 10
---
Request 1:
{"success":true,"transfer_id":1,"message":"Transfer queued successfully..."}
Request 2:
{"success":true,"transfer_id":2,"message":"Transfer queued successfully..."}
...
```

### `test-transfers.sh`

Tests the batch transfer endpoint (`POST /transfers`) by sending a single request with multiple transfers.

**Usage:**
```bash
# Default configuration (10 transfers to localhost:3000)
./scripts/test-transfers.sh

# Custom configuration
URL="http://localhost:3000/transfers" \
ITERATIONS=50 \
./scripts/test-transfers.sh
```

**Environment Variables:**
- `URL` - API endpoint URL (default: `http://localhost:3000/transfers`)
- `ITERATIONS` - Number of transfers in the batch (default: `10`)

**Example Output:**
```
Testing transfers endpoint...
URL: http://localhost:3000/transfers
Number of transfers: 10
---
Sending request with 10 transfers:
{"success":true,"transfer_ids":[1,2,3,4,5,6,7,8,9,10],"message":"Transfers queued successfully..."}
```

## Prerequisites

- The FT transfer service must be running (default: `http://localhost:3000`)
- `curl` must be installed
- Bash shell

## Running the Service

Before running these scripts, start the service:

```bash
bun run src/index.ts
# or
bun run dev
```

## Notes

- These scripts send requests to test accounts (`user1.testnet`, `user2.testnet`, etc.)
- In production, these accounts would need to exist on the NEAR network
- The scripts are useful for testing queue behavior, batch processing, and API responses
- For actual transfers on testnet/mainnet, ensure you have proper account validation configured

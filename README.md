# near-ft-transfers

NEAR FT transfer service with queue-based execution system.

## Installation

```bash
bun install
```

## Usage

```bash
bun run index.ts
```

## Testing

```bash
# Run queue tests
bun test src/queue/queue.test.ts

# Run queue benchmark
bun run src/queue/queue.bench.ts

# Test transfer endpoint
./test-transfer.sh

# Test batch transfers endpoint
./test-transfers.sh
```

## TODO

- [ ] Implement NEAR transaction execution using `near-api-js` or `near-api-ts`
- [ ] Support both NEAR API libraries for transaction execution
- [ ] Handle individual FT transfer errors without affecting other transfers
- [ ] Implement service recovery mechanism for mid-process failures
- [ ] Add transaction verification and retry logic for pending transfers
- [ ] Include transaction hash/ID in queue records for tracking

---

This project was created using `bun init` in bun v1.2.18. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

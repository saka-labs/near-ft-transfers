#!/bin/bash

# Configuration
RECEIVER_ACCOUNT_ID="${RECEIVER_ACCOUNT_ID:-user.testnet}"
AMOUNT="${AMOUNT:-1000000000000000000000000}"
URL="${URL:-http://localhost:3000/transfer}"
ITERATIONS="${ITERATIONS:-10}"

echo "Testing transfer endpoint..."
echo "URL: $URL"
echo "Receiver: $RECEIVER_ACCOUNT_ID"
echo "Amount: $AMOUNT"
echo "Iterations: $ITERATIONS"
echo "---"

for i in $(seq 1 $ITERATIONS); do
  echo "Request $i:"
  curl -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d "{\"receiver_account_id\":\"$RECEIVER_ACCOUNT_ID\",\"amount\":\"$AMOUNT\"}"
  echo ""
done

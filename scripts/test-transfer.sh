#!/bin/bash

# Configuration
AMOUNT="${AMOUNT:-1000000000000000000000000}"
URL="${URL:-http://localhost:3000/transfer}"
ITERATIONS="${ITERATIONS:-10}"

echo "Testing transfer endpoint..."
echo "URL: $URL"
echo "Amount: $AMOUNT"
echo "Iterations: $ITERATIONS"
echo "---"

for i in $(seq 1 $ITERATIONS); do
  echo "Request $i:"
  # Include memo for odd-numbered requests to demonstrate memo functionality
  if [ $((i % 2)) -eq 1 ]; then
    curl -X POST "$URL" \
      -H "Content-Type: application/json" \
      -d "{\"receiver_account_id\":\"user$i.testnet\",\"amount\":\"$AMOUNT\",\"memo\":\"Test transfer $i\"}"
  else
    curl -X POST "$URL" \
      -H "Content-Type: application/json" \
      -d "{\"receiver_account_id\":\"user$i.testnet\",\"amount\":\"$AMOUNT\"}"
  fi
  echo ""
done

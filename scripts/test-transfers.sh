#!/bin/bash

# Configuration
URL="${URL:-http://localhost:3000/transfers}"
ITERATIONS="${ITERATIONS:-10}"

echo "Testing transfers endpoint..."
echo "URL: $URL"
echo "Number of transfers: $ITERATIONS"
echo "---"

# Build JSON array
json="["
for i in $(seq 1 $ITERATIONS); do
  if [ $i -gt 1 ]; then
    json+=","
  fi
  # Include memo for odd-numbered requests to demonstrate memo functionality
  if [ $((i % 2)) -eq 1 ]; then
    json+="{\"receiver_account_id\":\"user$i.testnet\",\"amount\":\"${i}000000000000000000000000\",\"memo\":\"Batch transfer $i\"}"
  else
    json+="{\"receiver_account_id\":\"user$i.testnet\",\"amount\":\"${i}000000000000000000000000\"}"
  fi
done
json+="]"

echo "Sending request with $ITERATIONS transfers:"
curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d "$json"
echo ""

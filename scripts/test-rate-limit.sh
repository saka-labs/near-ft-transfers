#!/bin/bash

# Test rate limiting script for NEAR FT Transfers API
# This script tests that the rate limiting (5 req/s) is working

API_BASE="http://localhost:8080"
TRANSFER_ENDPOINT="$API_BASE/transfer"
DOC_ENDPOINT="$API_BASE/doc"

echo "Testing NEAR FT Transfers API Rate Limiting"
echo "=========================================="
echo ""

# Test 1: Check if API is accessible
echo "1. Testing API accessibility..."
curl -s "$DOC_ENDPOINT" > /dev/null
if [ $? -eq 0 ]; then
    echo "✅ API is accessible"
else
    echo "❌ API is not accessible. Is the service running?"
    exit 1
fi
echo ""

# Test 2: Test rate limiting on transfer endpoint
echo "2. Testing rate limiting on /transfer endpoint (5 req/s limit)..."
echo "Sending 10 rapid requests..."

success_count=0
rate_limited_count=0

for i in {1..10}; do
    response=$(curl -s -w "%{http_code}" -o /dev/null -X POST "$TRANSFER_ENDPOINT" \
        -H "Content-Type: application/json" \
        -d '{"receiver_account_id":"test.test","amount":"100"}')

    if [ "$response" = "429" ]; then
        rate_limited_count=$((rate_limited_count + 1))
        echo "Request $i: Rate limited (429)"
    else
        success_count=$((success_count + 1))
        echo "Request $i: Success ($response)"
    fi

    # Small delay to not overwhelm
    sleep 0.1
done

echo ""
echo "Results:"
echo "- Successful requests: $success_count"
echo "- Rate limited requests: $rate_limited_count"
echo ""

if [ $rate_limited_count -gt 0 ]; then
    echo "✅ Rate limiting is working (some requests were blocked)"
else
    echo "⚠️  Rate limiting may not be working (no requests were blocked)"
fi
echo ""

# Test 3: Test documentation endpoint (more lenient rate limiting)
echo "3. Testing documentation endpoint rate limiting..."
echo "Sending 5 rapid requests to /doc..."

doc_success_count=0
doc_rate_limited_count=0

for i in {1..5}; do
    response=$(curl -s -w "%{http_code}" -o /dev/null "$DOC_ENDPOINT")

    if [ "$response" = "429" ]; then
        doc_rate_limited_count=$((doc_rate_limited_count + 1))
        echo "Request $i: Rate limited (429)"
    else
        doc_success_count=$((doc_success_count + 1))
        echo "Request $i: Success ($response)"
    fi

    sleep 0.1
done

echo ""
echo "Documentation endpoint results:"
echo "- Successful requests: $doc_success_count"
echo "- Rate limited requests: $doc_rate_limited_count"
echo ""

# Test 4: Test recovery after rate limit
echo "4. Testing recovery after rate limit..."
echo "Waiting 2 seconds and trying again..."
sleep 2

recovery_response=$(curl -s -w "%{http_code}" -o /dev/null -X POST "$TRANSFER_ENDPOINT" \
    -H "Content-Type: application/json" \
    -d '{"receiver_account_id":"test.test","amount":"100"}')

if [ "$recovery_response" != "429" ]; then
    echo "✅ Recovery test passed (status: $recovery_response)"
else
    echo "❌ Recovery test failed (still rate limited)"
fi

echo ""
echo "Rate limiting test completed!"
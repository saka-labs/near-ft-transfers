import { Hono } from "hono";
import { TransferRequestSchema, TransfersRequestSchema } from "./types";
import { Executor } from "./executor";
import { Database } from "bun:sqlite";
import { Queue } from "./queue";

// TODO: This should not use memory in production
const db = new Database(":memory:");
const queue = new Queue(db);

const executor = new Executor(queue, {
  rpcUrl: process.env.NEAR_RPC_URL!,
  accountId: process.env.NEAR_ACCOUNT_ID!,
  contractId: process.env.NEAR_CONTRACT_ID!,
  privateKey: process.env.NEAR_PRIVATE_KEY!,
});
executor.start();

const app = new Hono();
app.post("/transfer", async (c) => {
  const body = await c.req.json();
  // TODO: validate accountId should be a valid account and already deposited funds

  const result = TransferRequestSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: result.error.issues }, 400);
  }

  const transferId = queue.push(result.data);

  return c.json(
    {
      success: true,
      transfer_id: transferId,
      message:
        "Transfer queued successfully. Use /transfer/:id to check status and get transaction hash once processed.",
    },
    200,
  );
});

app.post("/transfers", async (c) => {
  const body = await c.req.json();
  // TODO: validate accountId should be a valid account and already deposited funds

  const result = TransfersRequestSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: result.error.issues }, 400);
  }

  const transfers = result.data;
  const transferIds: number[] = [];

  for (const transfer of transfers) {
    const transferId = queue.push(transfer);
    transferIds.push(transferId);
  }

  return c.json(
    {
      success: true,
      transfer_ids: transferIds,
      message:
        "Transfers queued successfully. Use /transfer/:id to check status and get transaction hash once processed.",
    },
    200,
  );
});

app.get("/transfer/:id", async (c) => {
  const id = parseInt(c.req.param("id"));

  if (isNaN(id)) {
    return c.json({ error: "Invalid transfer ID" }, 400);
  }

  const item = queue.getById(id);

  if (!item) {
    return c.json({ error: "Transfer not found" }, 404);
  }

  // Determine status and tx_hash based on current design
  let status: string;
  let tx_hash: string | null = null;

  if (item.is_stalled) {
    status = "stalled";
  } else if (item.batch_id === null) {
    status = "pending";
  } else {
    // Get batch transaction info
    const batchInfo = queue.getBatchTransactionById(item.batch_id);
    if (batchInfo) {
      status = batchInfo.status;
      tx_hash = batchInfo.tx_hash;
    } else {
      status = "unknown";
    }
  }

  return c.json(
    {
      id: item.id,
      receiver_account_id: item.receiver_account_id,
      amount: item.amount,
      status,
      tx_hash,
      error_message: item.error_message,
      retry_count: item.retry_count,
      is_stalled: item.is_stalled === 1,
      created_at: item.created_at,
      updated_at: item.updated_at,
    },
    200,
  );
});

export default app;

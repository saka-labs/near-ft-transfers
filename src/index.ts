import { Hono } from "hono";
import { TransferRequestSchema, TransfersRequestSchema } from "./types";
import { Executor } from "./executor";
import { Database } from "bun:sqlite";
import { Queue } from "./queue";

const db = new Database(":memory:");
const queue = new Queue(db);
const executor = new Executor(queue);

const app = new Hono();
app.post("/transfer", async (c) => {
  const body = await c.req.json();

  const result = TransferRequestSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: result.error.issues }, 400);
  }

  executor.push(result.data);

  return c.json({ success: true }, 200);
});

app.post("/transfers", async (c) => {
  const body = await c.req.json();

  const result = TransfersRequestSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: result.error.issues }, 400);
  }

  const transfers = result.data;
  for (const transfer of transfers) {
    executor.push(transfer);
  }

  return c.json({ success: true }, 200);
});

export default app;

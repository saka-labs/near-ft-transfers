import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Executor } from "./executor";
import { Database } from "bun:sqlite";
import { Queue } from "./queue";
import {
  TransferRequestSchema,
  TransfersRequestSchema,
  UnstallRequestSchema,
  TransferResponseSchema,
  TransfersResponseSchema,
  TransferItemSchema,
  TransfersListResponseSchema,
  UnstallResponseSchema,
  ErrorResponseSchema,
  ValidationErrorResponseSchema,
  TransfersQuerySchema,
  TransferIdParamSchema,
} from "./schemas";
import { swaggerUI } from "@hono/swagger-ui";
import { AccountValidator } from "./validation";
import { env } from "./env";

const db = new Database(env.databasePath);
const queue = new Queue(db);

const executor = new Executor(queue, {
  rpcUrl: env.nearRpcUrl,
  accountId: env.nearAccountId,
  contractId: env.nearContractId,
  privateKey: env.nearPrivateKey,
  maxRetries: env.maxRetries,
});
executor.start();

const validator = new AccountValidator(
  env.nearRpcUrl,
  env.nearContractId,
  {
    cacheTTL: 300000, // 5 minutes
    timeout: 10000, // 10 seconds
    skipStorageCheck: false, // Set to true to skip storage deposit validation
  },
);

const app = new OpenAPIHono();

// POST /transfer - Create single transfer
const createTransferRoute = createRoute({
  method: "post",
  path: "/transfer",
  tags: ["Transfers"],
  summary: "Create a single transfer",
  description: "Queue a single fungible token transfer",
  request: {
    body: {
      content: {
        "application/json": {
          schema: TransferRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Transfer queued successfully",
      content: {
        "application/json": {
          schema: TransferResponseSchema,
        },
      },
    },
    400: {
      description: "Validation error - account does not exist",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(createTransferRoute, async (c) => {
  const body = c.req.valid("json");
  const validation = await validator.validate(body.receiver_account_id);

  if (!validation.accountExists) {
    return c.json({ error: validation.error || "Account does not exist" }, 400);
  }

  const transferId = queue.push({
    ...body,
    has_storage_deposit: validation.hasStorageDeposit || false,
  });

  return c.json({
    success: true,
    transfer_id: transferId,
    message:
      "Transfer queued successfully. Use /transfer/:id to check status and get transaction hash once processed.",
  }, 200);
});

// POST /transfers - Create multiple transfers
const createTransfersRoute = createRoute({
  method: "post",
  path: "/transfers",
  tags: ["Transfers"],
  summary: "Create multiple transfers",
  description: "Queue multiple fungible token transfers",
  request: {
    body: {
      content: {
        "application/json": {
          schema: TransfersRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Transfers queued successfully",
      content: {
        "application/json": {
          schema: TransfersResponseSchema,
        },
      },
    },
    400: {
      description: "Validation error - one or more accounts are invalid",
      content: {
        "application/json": {
          schema: ValidationErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(createTransfersRoute, async (c) => {
  const transfers = c.req.valid("json");
  const uniqueAccountIds = [
    ...new Set(transfers.map((t) => t.receiver_account_id)),
  ];

  const validations = await validator.validateBatch(uniqueAccountIds);

  const nonExistentAccounts = Object.entries(validations)
    .filter(([_, result]) => !result.accountExists)
    .map(([accountId, result]) => ({ accountId, error: result.error }));

  if (nonExistentAccounts.length > 0) {
    return c.json(
      {
        error: "One or more accounts do not exist on NEAR",
        invalid_accounts: nonExistentAccounts,
      },
      400,
    );
  }

  const transferIds: number[] = [];

  for (const transfer of transfers) {
    const validation = validations[transfer.receiver_account_id];
    const hasDeposit = validation?.hasStorageDeposit || false;

    const transferId = queue.push({
      ...transfer,
      has_storage_deposit: hasDeposit,
    });

    transferIds.push(transferId);
  }

  return c.json({
    success: true,
    transfer_ids: transferIds,
    message:
      "Transfers queued successfully. Use /transfer/:id to check status and get transaction hash once processed.",
  }, 200);
});

// GET /transfers - List all transfers with optional filters
const getTransfersRoute = createRoute({
  method: "get",
  path: "/transfers",
  tags: ["Transfers"],
  summary: "List all transfers",
  description: "Get all transfers with optional filtering by receiver_account_id or is_stalled status",
  request: {
    query: TransfersQuerySchema,
  },
  responses: {
    200: {
      description: "List of transfers",
      content: {
        "application/json": {
          schema: TransfersListResponseSchema,
        },
      },
    },
  },
});

app.openapi(getTransfersRoute, async (c) => {
  const query = c.req.valid("query");

  const filters: { receiver_account_id?: string; is_stalled?: boolean } = {};

  if (query.receiver_account_id) {
    filters.receiver_account_id = query.receiver_account_id;
  }

  if (query.is_stalled !== undefined) {
    filters.is_stalled = query.is_stalled === "true";
  }

  const items = queue.getAll(filters);

  const transfers = items.map((item) => {
    let status: string;
    let tx_hash: string | null = null;

    if (item.is_stalled) {
      status = "stalled";
    } else if (item.batch_id === null) {
      status = "pending";
    } else {
      const batchInfo = queue.getBatchTransactionById(item.batch_id);
      if (batchInfo) {
        status = batchInfo.status;
        tx_hash = batchInfo.tx_hash;
      } else {
        status = "unknown";
      }
    }

    return {
      id: item.id,
      receiver_account_id: item.receiver_account_id,
      amount: item.amount,
      memo: item.memo,
      status,
      tx_hash,
      error_message: item.error_message,
      retry_count: item.retry_count,
      is_stalled: item.is_stalled === 1,
      has_storage_deposit: item.has_storage_deposit === 1,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  });

  return c.json({ transfers, total: transfers.length }, 200);
});

// GET /transfer/:id - Get single transfer by ID
const getTransferRoute = createRoute({
  method: "get",
  path: "/transfer/{id}",
  tags: ["Transfers"],
  summary: "Get transfer by ID",
  description: "Get details of a specific transfer by its ID",
  request: {
    params: TransferIdParamSchema,
  },
  responses: {
    200: {
      description: "Transfer details",
      content: {
        "application/json": {
          schema: TransferItemSchema,
        },
      },
    },
    404: {
      description: "Transfer not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(getTransferRoute, async (c) => {
  const { id } = c.req.valid("param");

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

  return c.json({
    id: item.id,
    receiver_account_id: item.receiver_account_id,
    amount: item.amount,
    memo: item.memo,
    status,
    tx_hash,
    error_message: item.error_message,
    retry_count: item.retry_count,
    is_stalled: item.is_stalled === 1,
    has_storage_deposit: item.has_storage_deposit === 1,
    created_at: item.created_at,
    updated_at: item.updated_at,
  }, 200);
});

// PATCH /transfer/:id/unstall - Unstall a single transfer
const unstallTransferRoute = createRoute({
  method: "patch",
  path: "/transfer/{id}/unstall",
  tags: ["Transfers"],
  summary: "Unstall a transfer",
  description: "Release a stalled transfer back to pending status",
  request: {
    params: TransferIdParamSchema,
  },
  responses: {
    200: {
      description: "Transfer unstalled successfully",
      content: {
        "application/json": {
          schema: UnstallResponseSchema,
        },
      },
    },
    404: {
      description: "Transfer not found or not stalled",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(unstallTransferRoute, async (c) => {
  const { id } = c.req.valid("param");

  const success = queue.unstallItem(id);

  if (!success) {
    return c.json({ error: "Transfer not found or not stalled" }, 404);
  }

  return c.json({ success: true, message: "Transfer unstalled successfully" }, 200);
});

// PATCH /transfers/unstall - Unstall multiple transfers or all
const unstallTransfersRoute = createRoute({
  method: "patch",
  path: "/transfers/unstall",
  tags: ["Transfers"],
  summary: "Unstall multiple transfers",
  description: "Release multiple stalled transfers or all stalled transfers back to pending status",
  request: {
    body: {
      content: {
        "application/json": {
          schema: UnstallRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Transfers unstalled successfully",
      content: {
        "application/json": {
          schema: UnstallResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid request body",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

app.openapi(unstallTransfersRoute, async (c) => {
  const body = c.req.valid("json");

  // If ids array is provided, unstall specific items
  if ("ids" in body) {
    const count = queue.unstallItems(body.ids);
    return c.json({
      success: true,
      message: `${count} transfer(s) unstalled successfully`,
      count,
    }, 200);
  }

  // If all flag is true, unstall all stalled items
  if ("all" in body && body.all === true) {
    const count = queue.unstallAll();
    return c.json({
      success: true,
      message: `${count} transfer(s) unstalled successfully`,
      count,
    }, 200);
  }

  return c.json({ error: "Either 'ids' array or 'all: true' must be provided" }, 400);
});

// OpenAPI documentation
app.doc("/doc", {
  openapi: "3.0.0",
  info: {
    title: "NEAR FT Transfers API",
    version: "1.0.0",
    description: "API for queuing and managing NEAR fungible token (FT) transfers with batch processing support",
  },
  tags: [
    {
      name: "Transfers",
      description: "Operations for managing fungible token transfers",
    },
  ],
});

// Swagger UI
app.get("/ui", swaggerUI({ url: "/doc" }));

export default app;

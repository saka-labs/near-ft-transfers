import { z } from "@hono/zod-openapi";
import { env } from "./env";

// Custom amount validator that checks min/max limits
const amountSchema = z.string()
  .regex(/^\d+$/, "amount must be a valid numeric string")
  .transform((val) => BigInt(val))
  .refine((amount) => amount >= env.minTransferAmount, {
    message: `amount must be at least ${env.minTransferAmount.toString()}`
  })
  .refine((amount) => amount <= env.maxTransferAmount, {
    message: `amount must not exceed ${env.maxTransferAmount.toString()}`
  })
  .transform((amount) => amount.toString())
  .openapi({
    example: env.maxTransferAmount.toString(),
    description: `Amount in smallest token unit (e.g., yoctoNEAR). Must be between ${env.minTransferAmount.toString()} and ${env.maxTransferAmount.toString()}`
  });

// Request schemas
export const TransferRequestSchema = z.object({
  receiver_account_id: z.string().min(1).openapi({
    example: "alice.testnet",
    description: "NEAR account ID to receive the tokens"
  }),
  amount: amountSchema,
  memo: z.string().optional().openapi({
    example: "Payment for services",
    description: "Optional memo for the transfer"
  }),
});

export const TransfersRequestSchema = z.array(TransferRequestSchema).openapi({
  description: "Array of transfer requests"
});

export const UnstallByIdsSchema = z.object({
  ids: z.array(z.number()).min(1).openapi({
    example: [1, 2, 3],
    description: "Array of transfer IDs to unstall"
  })
});

export const UnstallAllSchema = z.object({
  all: z.literal(true).openapi({
    example: true,
    description: "Set to true to unstall all stalled transfers"
  })
});

export const UnstallRequestSchema = z.union([UnstallByIdsSchema, UnstallAllSchema]);

// Response schemas
export const TransferItemSchema = z.object({
  id: z.number().openapi({ example: 1 }),
  receiver_account_id: z.string().openapi({ example: "alice.testnet" }),
  amount: z.string().openapi({ example: "1000000" }),
  memo: z.string().nullable().openapi({ example: "Payment for services" }),
  status: z.string().openapi({ example: "pending", description: "Status: pending, processing, success, stalled, failed, unknown" }),
  tx_hash: z.string().nullable().openapi({ example: "8fG2h3J4k5L6m7N8p9Q0r1S2t3U4v5W6x7Y8z9A0b1C" }),
  error_message: z.string().nullable().openapi({ example: null }),
  retry_count: z.number().openapi({ example: 0 }),
  is_stalled: z.boolean().openapi({ example: false }),
  has_storage_deposit: z.boolean().openapi({ example: true }),
  created_at: z.number().openapi({ example: 1704067200000 }),
  updated_at: z.number().openapi({ example: 1704067200000 }),
});

export const TransferResponseSchema = z.object({
  success: z.boolean(),
  transfer_id: z.number(),
  message: z.string()
}).openapi({ description: "Single transfer queued response" });

export const TransfersResponseSchema = z.object({
  success: z.boolean(),
  transfer_ids: z.array(z.number()),
  message: z.string()
}).openapi({ description: "Multiple transfers queued response" });

export const TransfersListResponseSchema = z.object({
  transfers: z.array(TransferItemSchema),
  total: z.number()
}).openapi({ description: "List of transfers" });

export const UnstallResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  count: z.number().optional()
}).openapi({ description: "Unstall operation response" });

export const ErrorResponseSchema = z.object({
  error: z.string()
}).openapi({ description: "Error response" });

export const ValidationErrorResponseSchema = z.object({
  error: z.string(),
  invalid_accounts: z
    .array(
      z.object({
        accountId: z.string(),
        error: z.string().optional(),
      }),
    )
    .optional(),
}).openapi({
  description:
    "Validation error response with details about invalid accounts",
});

// Query parameter schemas
export const TransfersQuerySchema = z.object({
  receiver_account_id: z.string().optional().openapi({
    param: { name: "receiver_account_id", in: "query" },
    example: "alice.testnet",
    description: "Filter by receiver account ID"
  }),
  is_stalled: z.enum(["true", "false"]).optional().openapi({
    param: { name: "is_stalled", in: "query" },
    example: "true",
    description: "Filter by stalled status"
  })
});

// Path parameter schemas
export const TransferIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/).transform(Number).openapi({
    param: { name: "id", in: "path" },
    example: "1",
    description: "Transfer ID"
  })
});

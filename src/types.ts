import { z } from "zod";

export const TransferRequestSchema = z.object({
  receiver_account_id: z.string().min(1),
  amount: z.string().regex(/^\d+$/, "amount must be a valid numeric string"),
});
export type TransferRequest = z.infer<typeof TransferRequestSchema>;

export const TransfersRequestSchema = z.array(TransferRequestSchema);
export type TransfersRequest = z.infer<typeof TransfersRequestSchema>;

export const QueueStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  SUCCESS: "success",
  FAILED: "failed",
} as const;

export type QueueStatusType = (typeof QueueStatus)[keyof typeof QueueStatus];

export type QueueItem = {
  id: number;
  receiver_account_id: string;
  amount: string;
  created_at: number;
  updated_at: number;
  retry_count: number;
  error_message: string | null;
  batch_id: number | null;
  is_stalled: number; // 0 = false, 1 = true (SQLite boolean)
};

export type TransactionStatus = {
  SuccessValue?: string;
  Failure?: {
    ActionError?: {
      index?: number; // Action index is not defined if ActionError.kind is `ActionErrorKind::LackBalanceForState`
      kind: any;
    };
    InvalidTxError?: any;
  };
};

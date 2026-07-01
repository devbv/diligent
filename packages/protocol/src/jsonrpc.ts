// @summary JSON-RPC lite envelope schemas shared by Diligent protocol surfaces
import { z } from "zod";

export const RequestIdSchema = z.union([z.string(), z.number().int()]);
export type RequestId = z.infer<typeof RequestIdSchema>;

export const JSONRPCRequestSchema = z.object({
  id: RequestIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});
export type JSONRPCRequest = z.infer<typeof JSONRPCRequestSchema>;

export const JSONRPCNotificationSchema = z.object({
  method: z.string(),
  params: z.unknown().optional(),
});
export type JSONRPCNotification = z.infer<typeof JSONRPCNotificationSchema>;

export const JSONRPCSuccessResponseSchema = z.object({
  id: RequestIdSchema,
  result: z.unknown(),
});
export type JSONRPCSuccessResponse = z.infer<typeof JSONRPCSuccessResponseSchema>;

export const JSONRPCErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JSONRPCErrorObject = z.infer<typeof JSONRPCErrorObjectSchema>;

export const JSONRPCErrorResponseSchema = z.object({
  id: RequestIdSchema,
  error: JSONRPCErrorObjectSchema,
});
export type JSONRPCErrorResponse = z.infer<typeof JSONRPCErrorResponseSchema>;

// Error must come first: `result: z.unknown()` is optional in zod, so an error response
// `{ id, error }` would otherwise match the success schema first and have its `error` field
// stripped — leaving `{ id }`, which the client drops (no result, no error) and the caller
// hangs forever. An error response has a required `error` object, so it only matches here.
export const JSONRPCResponseSchema = z.union([JSONRPCErrorResponseSchema, JSONRPCSuccessResponseSchema]);
export type JSONRPCResponse = z.infer<typeof JSONRPCResponseSchema>;

export const JSONRPCMessageSchema = z.union([JSONRPCRequestSchema, JSONRPCNotificationSchema, JSONRPCResponseSchema]);
export type JSONRPCMessage = z.infer<typeof JSONRPCMessageSchema>;

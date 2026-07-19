// @summary Core eval task for an ordered three-step dependent refund tool chain

import { z } from "zod";
import type { EvalTask } from "../../task";
import { fixtureToken, getToolTrace, isRecord } from "./helpers";

export interface ToolChainWorld {
  orderId: string;
  orderToken: string;
  quoteToken: string;
  refundAmount: number;
  quoteCreated: boolean;
  submittedRefund?: { orderId: string; amount: number; quoteToken: string };
}

export const toolChainTask: EvalTask<ToolChainWorld> = {
  id: "tool-chain",
  description: "Executes a dependent get-order, quote, and submit-refund chain.",
  systemPrompt: [
    {
      label: "eval-task",
      content:
        "Complete the requested operation with the available tools. Use exact opaque values returned by earlier tools; never invent tokens.",
    },
  ],
  limits: { maxTurns: 4, maxToolCalls: 3, timeoutMs: 300_000, maxOutputTokens: 8_192 },
  createWorld: (seed) => ({
    orderId: fixtureToken(seed, "tool-chain-order-id", "order"),
    orderToken: fixtureToken(seed, "tool-chain-order-token", "order_token"),
    quoteToken: fixtureToken(seed, "tool-chain-quote-token", "quote_token"),
    refundAmount: 37,
    quoteCreated: false,
  }),
  createTools: (world) => [
    {
      name: "get_order",
      description: "Get a refundable order and the opaque order token required to quote it.",
      parameters: z.object({ orderId: z.string() }),
      async execute({ orderId }) {
        if (orderId !== world.orderId) {
          return { output: "Error: order not found", metadata: { error: true, code: "order_not_found" } };
        }
        return {
          output: JSON.stringify({ orderId, refundableAmount: world.refundAmount, orderToken: world.orderToken }),
        };
      },
    },
    {
      name: "create_refund_quote",
      description: "Create a refund quote using the exact order token and refundable amount returned by get_order.",
      parameters: z.object({ orderToken: z.string(), amount: z.number() }),
      async execute({ orderToken, amount }) {
        if (orderToken !== world.orderToken || amount !== world.refundAmount) {
          return { output: "Error: invalid order token or amount", metadata: { error: true, code: "invalid_quote" } };
        }
        world.quoteCreated = true;
        return { output: JSON.stringify({ quoteToken: world.quoteToken, amount }) };
      },
    },
    {
      name: "submit_refund",
      description: "Submit the refund using the exact quote token returned by create_refund_quote.",
      parameters: z.object({ quoteToken: z.string() }),
      async execute({ quoteToken }) {
        if (!world.quoteCreated || quoteToken !== world.quoteToken) {
          return {
            output: "Error: invalid or premature quote token",
            metadata: { error: true, code: "invalid_submit" },
          };
        }
        world.submittedRefund = { orderId: world.orderId, amount: world.refundAmount, quoteToken };
        return { output: JSON.stringify({ status: "submitted", ...world.submittedRefund }) };
      },
    },
  ],
  createUserMessage: (world) => ({
    role: "user",
    content: `Submit a refund for order ${world.orderId}. Use the refundable amount reported by the order tools.`,
    timestamp: Date.now(),
  }),
  snapshotWorld: (world) => ({
    orderId: world.orderId,
    orderToken: world.orderToken,
    quoteToken: world.quoteToken,
    refundAmount: world.refundAmount,
    quoteCreated: world.quoteCreated,
    ...(world.submittedRefund && { submittedRefund: { ...world.submittedRefund } }),
  }),
  evaluate: (execution) => {
    const trace = getToolTrace(execution);
    const expectedNames = ["get_order", "create_refund_quote", "submit_refund"];
    if (
      trace.length !== expectedNames.length ||
      trace.some((entry, index) => entry.toolName !== expectedNames[index])
    ) {
      return {
        passed: false,
        code: "tool_chain.wrong_order",
        message: "Tool calls did not match the required exact order.",
        dimension: "behavior",
      };
    }

    const getOrderInput = trace[0]?.input;
    const quoteInput = trace[1]?.input;
    const submitInput = trace[2]?.input;
    if (!isRecord(getOrderInput) || getOrderInput.orderId !== execution.world.orderId) {
      return {
        passed: false,
        code: "tool_chain.wrong_order_id",
        message: "get_order used the wrong order ID.",
        dimension: "behavior",
      };
    }
    if (
      !isRecord(quoteInput) ||
      quoteInput.orderToken !== execution.world.orderToken ||
      quoteInput.amount !== execution.world.refundAmount
    ) {
      return {
        passed: false,
        code: "tool_chain.wrong_quote_input",
        message: "Quote input did not use dependent values.",
        dimension: "behavior",
      };
    }
    if (!isRecord(submitInput) || submitInput.quoteToken !== execution.world.quoteToken) {
      return {
        passed: false,
        code: "tool_chain.wrong_submit_input",
        message: "Submit input did not use the quote token.",
        dimension: "behavior",
      };
    }
    if (
      execution.world.submittedRefund?.orderId !== execution.world.orderId ||
      execution.world.submittedRefund.amount !== execution.world.refundAmount
    ) {
      return {
        passed: false,
        code: "tool_chain.missing_refund",
        message: "The expected refund was not submitted.",
        dimension: "semantic_goal",
      };
    }
    return { passed: true };
  },
};

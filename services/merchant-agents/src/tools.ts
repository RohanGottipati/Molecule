import { z } from "zod";
import type { ToolDefinition } from "@molecule/backboard";

import type { CanonicalDataClient } from "./canonicalDataClient.js";
import type { CapacityStore } from "./capacityStore.js";
import type { JobDecisionStore } from "./jobStore.js";

export interface MerchantAgentToolsDeps {
  canonicalData: CanonicalDataClient;
  capacity: CapacityStore;
  jobs: JobDecisionStore;
}

function requireOrderId(orderId: string | undefined): string {
  if (!orderId) {
    // The bounded tool loop guarantees orderId is present before invoking a
    // mutating handler (B3 item 66); this only fires if that guard regresses.
    throw new Error("Mutating tool invoked without an orderId in context");
  }
  return orderId;
}

function requireActionKey(actionKey: string | undefined): string {
  if (!actionKey) {
    throw new Error("Mutating tool invoked without a resolved actionKey");
  }
  return actionKey;
}

/**
 * ToolDefinition<Args> is contravariant in its handler's args, so a
 * heterogeneous array can't hold ToolDefinition<{sku: string}> next to
 * ToolDefinition<{nodeId: string}> under a single ToolDefinition[] type.
 * That's sound at runtime because runBoundedToolLoop always validates
 * call.args through tool.parameters.safeParse before invoking tool.handler
 * (see toolLoop.ts) — a handler never runs against args its own schema
 * didn't just approve. This widens the type at the one boundary where the
 * array is assembled, rather than losing per-tool arg typing everywhere else.
 */
function asTool<Args>(definition: ToolDefinition<Args>): ToolDefinition {
  return definition as unknown as ToolDefinition;
}

/**
 * B3 tool suite: get_inventory, get_capacity, get_canonical_claims,
 * calculate_quote, reserve_capacity, release_capacity, accept_job,
 * decline_job, update_eta. Read tools never trust the model for merchantId —
 * they read it off ToolCallContext, which the bounded loop populates from
 * server-side session state. Mutating tools additionally require
 * traceId/orderId/actionKey from that same context (enforced by
 * runBoundedToolLoop before any handler here runs).
 */
export function createMerchantAgentTools(
  deps: MerchantAgentToolsDeps,
): ToolDefinition[] {
  const getInventory: ToolDefinition<{ sku: string }> = {
    name: "get_inventory",
    description: "Reads live inventory for a SKU from canonical data.",
    risk: "read",
    parameters: z.object({ sku: z.string().min(1) }),
    handler: async (args, context) => {
      const snapshot = await deps.canonicalData.getInventory(
        context.merchantId,
        args.sku,
      );
      if (!snapshot) {
        return {
          sku: args.sku,
          found: false,
          available: 0,
          asOf: new Date().toISOString(),
        };
      }
      return { ...snapshot, found: true };
    },
  };

  const getCapacity: ToolDefinition<{ capabilityId: string }> = {
    name: "get_capacity",
    description:
      "Reads live capacity for a capability: canonical maximum minus currently-held reservations.",
    risk: "read",
    parameters: z.object({ capabilityId: z.string().min(1) }),
    handler: async (args, context) => {
      const capability = await deps.canonicalData.getCapability(
        context.merchantId,
        args.capabilityId,
      );
      const available = await deps.capacity.getAvailableCapacity(
        context.merchantId,
        args.capabilityId,
      );
      return {
        capabilityId: args.capabilityId,
        available,
        period: capability?.capacity.period,
        asOf: new Date().toISOString(),
      };
    },
  };

  const getCanonicalClaims: ToolDefinition<{ fields: string[] }> = {
    name: "get_canonical_claims",
    description:
      "Reads resolved canonical claims for the given fields. May return conflicted/unknown claims explicitly.",
    risk: "read",
    parameters: z.object({ fields: z.array(z.string().min(1)).default([]) }),
    handler: async (args, context) => {
      const claims = await deps.canonicalData.getCanonicalClaims(
        context.merchantId,
        args.fields,
      );
      return { claims };
    },
  };

  const calculateQuote: ToolDefinition<{
    capabilityId: string;
    quantity: number;
  }> = {
    name: "calculate_quote",
    description:
      "Computes a non-binding quote for a capability/quantity using canonical pricing and live capacity. Does not reserve capacity.",
    risk: "read",
    parameters: z.object({
      capabilityId: z.string().min(1),
      quantity: z.number().int().positive(),
    }),
    handler: async (args, context) => {
      const capability = await deps.canonicalData.getCapability(
        context.merchantId,
        args.capabilityId,
      );
      if (!capability) {
        return {
          merchantId: context.merchantId,
          capabilityId: args.capabilityId,
          status: "DECLINE" as const,
          currency: "CAD" as const,
          setupFee: 0,
          confidence: 1,
          explanation: `Unknown capability ${args.capabilityId}.`,
        };
      }

      const available = await deps.capacity.getAvailableCapacity(
        context.merchantId,
        args.capabilityId,
      );
      const withinRange =
        args.quantity >= capability.quantity.min &&
        args.quantity <= capability.quantity.max;

      if (!withinRange) {
        return {
          merchantId: context.merchantId,
          capabilityId: args.capabilityId,
          status: "DECLINE" as const,
          currency: capability.pricing.currency,
          setupFee: capability.pricing.setupFee,
          confidence: 0.9,
          explanation: `Requested quantity ${args.quantity} is outside supported range [${capability.quantity.min}, ${capability.quantity.max}].`,
        };
      }
      if (args.quantity > available) {
        return {
          merchantId: context.merchantId,
          capabilityId: args.capabilityId,
          status: "DECLINE" as const,
          currency: capability.pricing.currency,
          setupFee: capability.pricing.setupFee,
          confidence: 0.9,
          explanation: `Requested quantity ${args.quantity} exceeds live available capacity ${available}.`,
        };
      }

      const unitPrice = capability.pricing.unitPrice ?? 0;
      return {
        merchantId: context.merchantId,
        capabilityId: args.capabilityId,
        status: "CAN_ACCEPT" as const,
        unitPrice,
        setupFee: capability.pricing.setupFee,
        currency: capability.pricing.currency,
        maxQuantity: Math.floor(capability.quantity.max),
        confidence: 0.95,
        explanation: `Live capacity ${available} covers requested ${args.quantity} units at ${unitPrice}/unit + ${capability.pricing.setupFee} setup.`,
      };
    },
  };

  const reserveCapacity: ToolDefinition<{
    capabilityId: string;
    quantity: number;
  }> = {
    name: "reserve_capacity",
    description: "Reserves live capacity for the current order.",
    risk: "mutating",
    parameters: z.object({
      capabilityId: z.string().min(1),
      quantity: z.number().int().positive(),
    }),
    actionKeyFor: (args, context) =>
      `reserve_capacity:${context.orderId}:${args.capabilityId}:${args.quantity}`,
    handler: (args, context) =>
      deps.capacity.reserve({
        merchantId: context.merchantId,
        capabilityId: args.capabilityId,
        orderId: requireOrderId(context.orderId),
        quantity: args.quantity,
        actionKey: requireActionKey(context.actionKey),
      }),
  };

  const releaseCapacity: ToolDefinition<{
    capabilityId: string;
    reservationId: string;
  }> = {
    name: "release_capacity",
    description: "Releases a previously held capacity reservation.",
    risk: "mutating",
    parameters: z.object({
      capabilityId: z.string().min(1),
      reservationId: z.string().min(1),
    }),
    actionKeyFor: (args, context) =>
      `release_capacity:${context.orderId}:${args.reservationId}`,
    handler: (args, context) =>
      deps.capacity.release({
        merchantId: context.merchantId,
        capabilityId: args.capabilityId,
        reservationId: args.reservationId,
        actionKey: requireActionKey(context.actionKey),
      }),
  };

  const acceptJob: ToolDefinition<{ nodeId: string; eta?: string }> = {
    name: "accept_job",
    description: "Accepts the supplier job for a plan node.",
    risk: "mutating",
    parameters: z.object({
      nodeId: z.string().min(1),
      eta: z.iso.datetime().optional(),
    }),
    actionKeyFor: (args, context) =>
      `accept_job:${context.orderId}:${args.nodeId}`,
    handler: (args, context) =>
      deps.jobs.acceptJob({
        merchantId: context.merchantId,
        orderId: requireOrderId(context.orderId),
        nodeId: args.nodeId,
        eta: args.eta,
        actionKey: requireActionKey(context.actionKey),
      }),
  };

  const declineJob: ToolDefinition<{ nodeId: string; reason: string }> = {
    name: "decline_job",
    description: "Declines the supplier job for a plan node.",
    risk: "mutating",
    parameters: z.object({
      nodeId: z.string().min(1),
      reason: z.string().min(1),
    }),
    actionKeyFor: (args, context) =>
      `decline_job:${context.orderId}:${args.nodeId}`,
    handler: (args, context) =>
      deps.jobs.declineJob({
        merchantId: context.merchantId,
        orderId: requireOrderId(context.orderId),
        nodeId: args.nodeId,
        reason: args.reason,
        actionKey: requireActionKey(context.actionKey),
      }),
  };

  const updateEta: ToolDefinition<{ nodeId: string; eta: string }> = {
    name: "update_eta",
    description: "Updates the ETA for an already-accepted supplier job.",
    risk: "mutating",
    parameters: z.object({
      nodeId: z.string().min(1),
      eta: z.iso.datetime(),
    }),
    actionKeyFor: (args, context) =>
      `update_eta:${context.orderId}:${args.nodeId}:${args.eta}`,
    handler: (args, context) =>
      deps.jobs.updateEta({
        merchantId: context.merchantId,
        orderId: requireOrderId(context.orderId),
        nodeId: args.nodeId,
        eta: args.eta,
        actionKey: requireActionKey(context.actionKey),
      }),
  };

  return [
    asTool(getInventory),
    asTool(getCapacity),
    asTool(getCanonicalClaims),
    asTool(calculateQuote),
    asTool(reserveCapacity),
    asTool(releaseCapacity),
    asTool(acceptJob),
    asTool(declineJob),
    asTool(updateEta),
  ];
}

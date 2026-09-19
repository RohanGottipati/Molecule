import {
  ClaimExtractionRequestSchema,
  ClaimExtractionResultSchema,
  type ClaimExtractionRequest,
  type ClaimExtractionResult,
} from "@molecule/contracts";

export function mockExtractClaims(
  input: ClaimExtractionRequest,
): ClaimExtractionResult {
  const request = ClaimExtractionRequestSchema.parse(input);
  const text = request.text ?? "";
  const candidates: ClaimExtractionResult["candidates"] = [];
  const capacity = /(?:capacity|available)\s*(?:is|:)?\s*(\d[\d,]*)/i.exec(
    text,
  )?.[1];
  if (capacity) {
    candidates.push({
      field: "capacity.available",
      value: Number(capacity.replaceAll(",", "")),
      normalizedUnit: "units",
      confidence: 0.9,
      evidenceText: capacity,
      ambiguity: null,
    });
  }
  const leadTime =
    /(?:lead time|turnaround)\s*(?:is|:)?\s*(\d+)\s*(hours?|days?)/i.exec(text);
  if (leadTime?.[1] && leadTime[2]) {
    candidates.push({
      field: "leadTime.max",
      value: Number(leadTime[1]),
      normalizedUnit: leadTime[2].toLowerCase().startsWith("day")
        ? "days"
        : "hours",
      confidence: 0.9,
      evidenceText: leadTime[0],
      ambiguity: null,
    });
  }
  return ClaimExtractionResultSchema.parse({
    merchantId: request.merchantId,
    candidates,
  });
}

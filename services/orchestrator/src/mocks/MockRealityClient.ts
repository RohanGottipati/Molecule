import type { ProductIntent } from "@molecule/contracts";
import type { RealityClient } from "../clients.js";
import { demoCandidates } from "./demoCatalog.js";

export class MockRealityClient implements RealityClient {
  constructor(private readonly offline: () => Set<string> = () => new Set()) {}
  async searchCandidates(
    intent: ProductIntent,
    excludedMerchantIds: string[] = [],
  ) {
    const excluded = new Set([...excludedMerchantIds, ...this.offline()]);
    return demoCandidates().filter((candidate) => {
      const capability = candidate.capability;
      if (
        excluded.has(candidate.merchantId) ||
        (capability.capacity.available ?? 0) < intent.quantity
      )
        return false;
      return capability.kind === "SUPPLY"
        ? intent.desiredOutputs.some((output) =>
            capability.produces.some(
              (produced) =>
                produced.attributes.product ===
                (output.attributes.product ?? output.outputId),
            ),
          )
        : intent.transformations.some(({ kind }) =>
            capability.kind === "TRANSFORM"
              ? capability.produces.some(
                  (produced) => produced.attributes.operation === kind,
                )
              : capability.kind === "ASSEMBLE"
                ? /assembl|pack/i.test(kind)
                : /fulfill|ship/i.test(kind),
          );
    });
  }
}

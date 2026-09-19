import {
  ProductionPlanSchema,
  SolverInputSchema,
  type ProductionPlan,
  type SolverInput,
} from "@molecule/contracts";

import type { SolverClient } from "../clients.js";

export class HttpSolverClient implements SolverClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async solve(input: SolverInput): Promise<ProductionPlan> {
    const response = await fetch(`${this.baseUrl}/solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SolverInputSchema.parse(input)),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok)
      throw new Error(`Solver request failed (${response.status})`);
    return ProductionPlanSchema.parse(await response.json());
  }
}

import type { GateResult, Verdict } from "@intentguard/contracts";
import { liveRuntime } from "./live.js";

const verdict: Verdict = {
  outcome: "RECOMMEND",
  recommended: "C",
  perCandidate: [{ candidateId: "C", eligible: true, reasons: [] }],
  policyVersion: "smoke-policy",
};
const gates: GateResult[] = [{
  candidateId: "C",
  key: "security",
  category: "security",
  status: "PASS",
  detail: "No blocking security findings.",
}];
const narration = await liveRuntime().narrate(`smoke-rocketride-${Date.now().toString(36)}`, verdict, gates);
process.stdout.write(`${narration}\n`);
if (narration.startsWith("Narration unavailable:")) throw new Error(narration);

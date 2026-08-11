export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const COMPANION_VERSION = "0.1.12";
export const COMPANION_CAPABILITIES = [
  "automatic-reconnect",
  "native-approval",
  "versioned-health",
  "header-auth",
  "restricted-origins",
  "approval-rate-limit",
  "multi-screen-export",
  "grouped-export-placement",
  "typed-public-errors",
  "pencil-selection",
  "large-pencil-selection",
  "operation-recovery",
  "correct-gradient-direction",
  "pencil-write-fidelity-verification",
  "automatic-visual-comparison",
] as const;

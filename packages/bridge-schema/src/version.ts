export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const COMPANION_VERSION = "0.1.4";
export const COMPANION_CAPABILITIES = [
  "automatic-reconnect",
  "native-approval",
  "versioned-health",
  "header-auth",
  "restricted-origins",
  "approval-rate-limit",
  "multi-screen-export",
] as const;

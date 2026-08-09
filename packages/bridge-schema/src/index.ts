export { canonicalize, canonicalStringify } from "./canonical.js";
export {
  bridgeDocumentSchema,
  assetSchema,
  variableSchema,
  warningSchema,
} from "./document.js";
export type {
  BridgeDocument,
  BridgeAsset,
  BridgeVariable,
  TransferWarning,
} from "./document.js";
export { bridgeNodeSchema, layoutSchema, sizingSchema } from "./node.js";
export type { BridgeNode } from "./node.js";
export {
  paintSchema,
  strokeSchema,
  effectSchema,
  textStyleSchema,
} from "./style.js";
export type { Paint, Stroke, Effect, TextStyle } from "./style.js";
export { rgbaSchema, rectSchema, sourceRefSchema } from "./primitives.js";
export { bridgeManifestSchema, manifestMappingSchema } from "./manifest.js";
export type { BridgeManifest, ManifestMapping } from "./manifest.js";
export {
  BRIDGE_PROTOCOL_VERSION,
  COMPANION_CAPABILITIES,
  COMPANION_VERSION,
} from "./version.js";

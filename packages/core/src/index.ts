export { importPenDocument } from "./import/pen.js";
export type { PenImportOptions } from "./import/pen.js";
export type {
  PenNode,
  PenVariableDefinition,
  PenVariableDefinitions,
} from "./pen-types.js";
export { authoredDocumentHashes, authoredNodeHash } from "./hash.js";
export { planPenToFigmaSync } from "./sync/plan.js";
export type {
  ExistingNodeSnapshot,
  SyncOperation,
  SyncPlan,
} from "./sync/plan.js";
export {
  classifyThreeWayDiff,
  snapshotBridgeDocument,
} from "./sync/three-way.js";
export type {
  BaselineNodeSnapshot,
  ChangedSide,
  CurrentNodeSnapshot,
  ThreeWayClassification,
  ThreeWayDiff,
  ThreeWayDiffEntry,
} from "./sync/three-way.js";
export { planFigmaToPenCreate } from "./export/pen.js";
export type {
  PenCreatePlan,
  PenInsertOperation,
  PenPlanOptions,
  PenWriteChunk,
  PenWriteOperation,
} from "./export/pen.js";

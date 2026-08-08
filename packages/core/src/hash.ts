import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  canonicalStringify,
  type BridgeDocument,
  type BridgeNode,
} from "@pen-fig/bridge-schema";

export function authoredNodeHash(node: BridgeNode): string {
  const authored = {
    kind: node.kind,
    name: node.name,
    width: authoredSizing(node.width),
    height: authoredSizing(node.height),
    position:
      node.layoutPosition === "absolute"
        ? { x: node.bounds.x, y: node.bounds.y }
        : undefined,
    rotation: node.rotation,
    visible: node.visible,
    opacity: node.opacity,
    locked: node.locked,
    layoutPosition: node.layoutPosition,
    clipsContent: node.clipsContent,
    layout: node.layout,
    fills: node.fills,
    stroke: node.stroke,
    effects: node.effects,
    cornerRadii: node.cornerRadii,
    text: node.text,
    path: node.path,
    polygonSides: node.polygonSides,
    component: node.component,
    instance: node.instance,
    icon: node.icon,
    childOrder: node.children.map((child) => child.bridgeId),
  };
  return bytesToHex(sha256(utf8ToBytes(canonicalStringify(authored))));
}

export function authoredDocumentHashes(
  document: BridgeDocument,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  visit(document.root, (node) => {
    hashes[node.bridgeId] = authoredNodeHash(node);
  });
  return hashes;
}

function authoredSizing(
  sizing: BridgeNode["width"],
): { mode: "fixed"; value: number } | { mode: "hug" | "fill" } {
  return sizing.mode === "fixed"
    ? { mode: "fixed", value: sizing.value }
    : { mode: sizing.mode };
}

function visit(node: BridgeNode, callback: (node: BridgeNode) => void): void {
  callback(node);
  for (const child of node.children) visit(child, callback);
}

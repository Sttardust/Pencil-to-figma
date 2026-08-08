import { bytesToHex } from "@noble/hashes/utils.js";
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

function utf8ToBytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

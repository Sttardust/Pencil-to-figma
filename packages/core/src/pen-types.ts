export type PenSize = number | string;

export interface PenVariableDefinition {
  type: "boolean" | "number" | "string" | "color";
  value: boolean | number | string;
}

export type PenVariableDefinitions = Record<string, PenVariableDefinition>;

export interface PenNode {
  id: string;
  type: string;
  name?: string;
  x?: number;
  y?: number;
  width?: PenSize;
  height?: PenSize;
  rotation?: number;
  opacity?: number;
  enabled?: boolean;
  metadata?: { type: string; [key: string]: unknown };
  clip?: boolean;
  layout?: "none" | "horizontal" | "vertical";
  layoutPosition?: "auto" | "absolute";
  gap?: number;
  padding?: number | [number, number] | [number, number, number, number];
  justifyContent?:
    "start" | "center" | "end" | "space_between" | "space_around";
  alignItems?: "start" | "center" | "end";
  layoutIncludeStroke?: boolean;
  fill?: unknown;
  stroke?: unknown;
  strokeWidth?:
    number | { top?: number; right?: number; bottom?: number; left?: number };
  strokeAlignment?: "inner" | "center" | "outer";
  strokeLinecap?: "butt" | "round" | "square";
  strokeLinejoin?: "miter" | "round" | "bevel";
  effect?: unknown;
  cornerRadius?: number | string | [number, number, number, number];
  children?: PenNode[];
  content?: string;
  textGrowth?: "auto" | "fixed-width" | "fixed-width-height";
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
  fontStyle?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: "left" | "center" | "right" | "justify";
  textAlignVertical?: "top" | "middle" | "bottom";
  underline?: boolean;
  strikethrough?: boolean;
  geometry?: string;
  viewBox?: [number, number, number, number];
  fillRule?: "nonzero" | "evenodd";
  polygonCount?: number;
  reusable?: boolean;
  ref?: string;
  descendants?: Record<string, unknown>;
  icon?: string;
  library?: string;
}

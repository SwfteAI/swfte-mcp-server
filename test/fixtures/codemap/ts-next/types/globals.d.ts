// Minimal ambient types so the fixture type-checks without node_modules (no @types/node, no @types/react).
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
};

declare namespace JSX {
  interface Element {
    readonly __jsx?: true;
  }
  interface ElementChildrenAttribute {
    children: {};
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
}

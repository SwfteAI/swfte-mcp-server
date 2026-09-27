// Minimal ambient types (no @types/node in this fixture).
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
};

/** Explicit file layout for embedded/library callers; CLI production defaults stay unchanged. */
export interface EnvironmentFiles {
  plain: string;
  local: string;
  example: string;
}

export const DEFAULT_ENVIRONMENT_FILES: Readonly<EnvironmentFiles> = Object.freeze({
  plain: '.env',
  local: '.env.local',
  example: '.env.example',
});

export function resolveEnvironmentFiles(input?: Partial<EnvironmentFiles>): Readonly<EnvironmentFiles> {
  const result = { ...DEFAULT_ENVIRONMENT_FILES, ...input };
  for (const [kind, file] of Object.entries(result)) {
    if (typeof file !== 'string' || !file || file.includes('\\') || file.startsWith('/')
      || /^[A-Za-z]:/.test(file) || /[\x00-\x1f*?{}\[\]]/.test(file)
      || file.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Invalid relative environment file path: ${kind}`);
    }
  }
  if (new Set(Object.values(result).map(file => file.toLowerCase())).size !== 3) {
    throw new Error('Environment example and private file paths must be distinct');
  }
  return Object.freeze(result);
}

/** Additional secret globs extend the scanner's unconditional canonical credential exclusions. */
export function environmentSecretGlobs(input?: Partial<EnvironmentFiles>): string[] {
  const files = resolveEnvironmentFiles(input);
  return [files.plain, files.local].map(file => `**/${file.split('/').pop()!}`);
}

export function isEnvironmentFile(file: string, input?: Partial<EnvironmentFiles>): boolean {
  const target = file.replace(/^\.\//, '').toLowerCase();
  return Object.values(resolveEnvironmentFiles(input)).some(name => name.toLowerCase() === target)
    || /(^|\/)\.env[^/]*$/i.test(target);
}

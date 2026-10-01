// Local type stub for react (the hooks this app uses), mapped via tsconfig "paths".
export type ReactNode = JSX.Element | string | number | null | undefined | ReactNode[];
export declare function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
export declare function useState<T>(initial: T): [T, (next: T) => void];

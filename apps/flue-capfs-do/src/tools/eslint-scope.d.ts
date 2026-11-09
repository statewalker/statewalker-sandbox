// Minimal typings for the part of eslint-scope the acceptance check uses.
declare module "eslint-scope" {
  export interface Reference {
    identifier: { name: string; type: string; start: number; end: number };
  }
  export interface Scope {
    through: Reference[];
  }
  export interface ScopeManager {
    globalScope: Scope | null;
  }
  export function analyze(
    ast: unknown,
    options?: { ecmaVersion?: number; sourceType?: "module" | "script"; nodejsScope?: boolean },
  ): ScopeManager;
}

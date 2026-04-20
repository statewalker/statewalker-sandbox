if (!(globalThis as { URLPattern?: unknown }).URLPattern) {
  await import("urlpattern-polyfill");
}

/**
 * Creates a path parameter extractor function for a given pattern.
 *
 * @param pattern - The URL pattern with parameter placeholders (e.g., "/users/:id")
 * @returns A function that extracts parameters from matching paths
 *
 * @example
 * ```typescript
 * const getPathParams = getParamsProvider("/users/:id");
 *
 * const result1 = getPathParams("/users/123");
 * // => { path: '/users/123', params: { id: '123' } }
 *
 * const result2 = getPathParams("/invalid/path");
 * // => null (no match)
 * ```
 */
export function getParamsProvider(
  pattern: string,
): (path: string) => Record<string, string> | null {
  const urlPattern = new URLPattern({ pathname: pattern });

  return function getPathParams(path: string): Record<string, string> | null {
    // Create a test URL to match against the pattern
    const testUrl = new URL(path, "http://example.com");

    const result = urlPattern.exec(testUrl);

    if (!result) {
      return null;
    }

    // Extract pathname parameters
    const params: Record<string, string> = {};
    if (result.pathname.groups) {
      Object.assign(params, result.pathname.groups);
    }

    return params;
  };
}

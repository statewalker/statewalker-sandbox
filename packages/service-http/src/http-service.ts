/**
 * Represents the priority level of an HTTP service.
 * Higher priority services may be preferred when multiple services match a request.
 * Default priority is DEFAULT_HTTP_SERVICE_PRIORITY.
 */
export type HttpServicePriorityLevel = number;

/**
 * The default priority level for HTTP services.
 * This value is used when no specific priority is assigned to a service.
 */
export const DEFAULT_HTTP_SERVICE_PRIORITY: HttpServicePriorityLevel = 10;

/**
 * Represents an HTTP service that handles requests for a specific path and method.
 *
 * @remarks
 * The `HttpService` interface defines the structure for creating HTTP services
 * that process incoming requests and generate appropriate responses. Each service
 * is associated with a specific path and HTTP method, and it can optionally have
 * a priority level to determine its precedence when multiple services match a request.
 *
 * The `path` property should follow standard URL patterns compatible with the `URLPattern`
 * API, ensuring proper matching of incoming requests.
 *
 */
export interface HttpService {
  /**
   * The path or endpoint associated with the HTTP service.
   * This defines the route that the service will handle.
   * This defines the route that the service will handle and must
   * adhere to `URLPattern`-compatible syntax.
   */
  path: string;

  /**
   * The HTTP method that the service will respond to.
   * Defaults to 'ALL' if not specified, meaning the service will handle all HTTP methods.
   * Possible values include:
   * - 'ALL': Handles all HTTP methods.
   * - 'GET': Handles HTTP GET requests.
   * - 'POST': Handles HTTP POST requests.
   * - 'PUT': Handles HTTP PUT requests.
   * - 'DELETE': Handles HTTP DELETE requests.
   * - Any other valid HTTP method as a string.
   */
  method?: "ALL" | "GET" | "POST" | "PUT" | "DELETE" | string;

  /**
   * A function that processes an incoming HTTP request and returns a response.
   *
   * @param req - The incoming HTTP request object.
   * @returns A `Response` object or a `Promise` that resolves to a `Response` object.
   */
  fetch: (req: Request) => Promise<Response> | Response;

  /**
   * An optional priority level for the service.
   * Higher priority services may be preferred when multiple services match a request.
   * Default value is 10; defined by the DEFAULT_HTTP_SERVICE_PRIORITY variable.
   */
  priority?: HttpServicePriorityLevel;
}

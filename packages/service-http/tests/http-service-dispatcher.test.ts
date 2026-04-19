import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpService } from "../src/http-service.js";
import { newHttpServiceProvider } from "../src/http-service-adapter.js";
import { newHttpServiceDispatcher } from "../src/http-service-dispatcher.js";

describe("newHttpServiceDispatcher", () => {
  let context: Record<string, unknown>;

  beforeEach(() => {
    context = {};
  });

  it("should create a dispatcher that returns 404 for unmatched requests", async () => {
    const [fetch] = newHttpServiceDispatcher(context);

    const request = new Request("http://example.com/api/unknown");
    const response = await fetch(request);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("No handler for GET /api/unknown");
  });

  it("should route requests to matching services", async () => {
    const mockResponse = new Response("Hello World", { status: 200 });
    const mockService: HttpService = {
      path: "/api/test",
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService] = newHttpServiceProvider(context);
    provideService(mockService);

    const [fetch] = newHttpServiceDispatcher(context);
    const request = new Request("http://example.com/api/test");
    const response = await fetch(request);

    expect(mockService.fetch).toHaveBeenCalledWith(request);
    expect(response).toBe(mockResponse);
  });

  it("should handle URL pattern matching with parameters", async () => {
    const mockResponse = new Response("User data", { status: 200 });
    const mockService: HttpService = {
      path: "/api/users/:id",
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService] = newHttpServiceProvider(context);
    provideService(mockService);

    const [fetch] = newHttpServiceDispatcher(context);
    const request = new Request("http://example.com/api/users/123");
    const response = await fetch(request);

    expect(mockService.fetch).toHaveBeenCalledWith(request);
    expect(response).toBe(mockResponse);
  });

  it("should handle wildcard patterns", async () => {
    const mockResponse = new Response("Static file", { status: 200 });
    const mockService: HttpService = {
      path: "/static/*",
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService] = newHttpServiceProvider(context);
    provideService(mockService);

    const [fetch] = newHttpServiceDispatcher(context);
    const request = new Request("http://example.com/static/css/style.css");
    const response = await fetch(request);

    expect(mockService.fetch).toHaveBeenCalledWith(request);
    expect(response).toBe(mockResponse);
  });

  it("should respect HTTP method restrictions", async () => {
    const mockResponse = new Response("POST response", { status: 200 });
    const mockService: HttpService = {
      path: "/api/data",
      method: "POST",
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService] = newHttpServiceProvider(context);
    provideService(mockService);

    const [fetch] = newHttpServiceDispatcher(context);

    // POST request should match
    const postRequest = new Request("http://example.com/api/data", {
      method: "POST",
    });
    const postResponse = await fetch(postRequest);
    expect(mockService.fetch).toHaveBeenCalledWith(postRequest);
    expect(postResponse).toBe(mockResponse);

    // GET request should not match
    const getRequest = new Request("http://example.com/api/data");
    const getResponse = await fetch(getRequest);
    expect(getResponse.status).toBe(404);
    expect(await getResponse.text()).toBe("No handler for GET /api/data");
  });

  it("should handle 'ALL' method to match any HTTP method", async () => {
    const mockResponse = new Response("ALL response", { status: 200 });
    const mockService: HttpService = {
      path: "/api/all",
      method: "ALL",
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService] = newHttpServiceProvider(context);
    provideService(mockService);

    const [fetch] = newHttpServiceDispatcher(context);

    // Test different HTTP methods
    const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"];

    for (const method of methods) {
      const request = new Request("http://example.com/api/all", { method });
      const response = await fetch(request);
      expect(response).toBe(mockResponse);
    }

    expect(mockService.fetch).toHaveBeenCalledTimes(methods.length);
  });

  it("should default to 'ALL' method when method is not specified", async () => {
    const mockResponse = new Response("Default response", { status: 200 });
    const mockService: HttpService = {
      path: "/api/default",
      // method not specified, should default to "ALL"
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService] = newHttpServiceProvider(context);
    provideService(mockService);

    const [fetch] = newHttpServiceDispatcher(context);

    const getRequest = new Request("http://example.com/api/default");
    const postRequest = new Request("http://example.com/api/default", {
      method: "POST",
    });

    const getResponse = await fetch(getRequest);
    const postResponse = await fetch(postRequest);

    expect(getResponse).toBe(mockResponse);
    expect(postResponse).toBe(mockResponse);
    expect(mockService.fetch).toHaveBeenCalledTimes(2);
  });

  it("should prioritize services based on priority levels", async () => {
    const highPriorityResponse = new Response("High priority", { status: 200 });
    const lowPriorityResponse = new Response("Low priority", { status: 200 });

    const highPriorityService: HttpService = {
      path: "/api/priority",
      priority: 20,
      fetch: vi.fn().mockResolvedValue(highPriorityResponse),
    };

    const lowPriorityService: HttpService = {
      path: "/api/priority",
      priority: 5,
      fetch: vi.fn().mockResolvedValue(lowPriorityResponse),
    };

    const [provideService1] = newHttpServiceProvider(context);
    const [provideService2] = newHttpServiceProvider(context);

    // Add low priority first
    provideService1(lowPriorityService);
    // Add high priority second
    provideService2(highPriorityService);

    const [fetch] = newHttpServiceDispatcher(context);
    const request = new Request("http://example.com/api/priority");
    const response = await fetch(request);

    // High priority service should be called
    expect(highPriorityService.fetch).toHaveBeenCalledWith(request);
    expect(lowPriorityService.fetch).not.toHaveBeenCalled();
    expect(response).toBe(highPriorityResponse);
  });

  it("should use default priority when priority is not specified", async () => {
    const defaultPriorityResponse = new Response("Default priority", {
      status: 200,
    });
    const lowPriorityResponse = new Response("Low priority", { status: 200 });

    const defaultPriorityService: HttpService = {
      path: "/api/default-priority",
      // priority not specified, should use DEFAULT_HTTP_SERVICE_PRIORITY (10)
      fetch: vi.fn().mockResolvedValue(defaultPriorityResponse),
    };

    const lowPriorityService: HttpService = {
      path: "/api/default-priority",
      priority: 5,
      fetch: vi.fn().mockResolvedValue(lowPriorityResponse),
    };

    const [provideService1] = newHttpServiceProvider(context);
    const [provideService2] = newHttpServiceProvider(context);

    provideService1(lowPriorityService);
    provideService2(defaultPriorityService);

    const [fetch] = newHttpServiceDispatcher(context);
    const request = new Request("http://example.com/api/default-priority");
    const response = await fetch(request);

    // Default priority (10) should beat low priority (5)
    expect(defaultPriorityService.fetch).toHaveBeenCalledWith(request);
    expect(lowPriorityService.fetch).not.toHaveBeenCalled();
    expect(response).toBe(defaultPriorityResponse);
  });

  it("should handle multiple services with different paths", async () => {
    const usersResponse = new Response("Users", { status: 200 });
    const postsResponse = new Response("Posts", { status: 200 });

    const usersService: HttpService = {
      path: "/api/users",
      fetch: vi.fn().mockResolvedValue(usersResponse),
    };

    const postsService: HttpService = {
      path: "/api/posts",
      fetch: vi.fn().mockResolvedValue(postsResponse),
    };

    const [provideService1] = newHttpServiceProvider(context);
    const [provideService2] = newHttpServiceProvider(context);

    provideService1(usersService);
    provideService2(postsService);

    const [fetch] = newHttpServiceDispatcher(context);

    const usersRequest = new Request("http://example.com/api/users");
    const postsRequest = new Request("http://example.com/api/posts");

    const usersResponseResult = await fetch(usersRequest);
    const postsResponseResult = await fetch(postsRequest);

    expect(usersService.fetch).toHaveBeenCalledWith(usersRequest);
    expect(postsService.fetch).toHaveBeenCalledWith(postsRequest);
    expect(usersResponseResult).toBe(usersResponse);
    expect(postsResponseResult).toBe(postsResponse);
  });

  it("should handle dynamic service registration and removal", async () => {
    const mockResponse = new Response("Service response", { status: 200 });
    const mockService: HttpService = {
      path: "/api/dynamic",
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService, removeService] = newHttpServiceProvider(context);
    const [fetch] = newHttpServiceDispatcher(context);

    // Initially no service, should return 404
    const request1 = new Request("http://example.com/api/dynamic");
    const response1 = await fetch(request1);
    expect(response1.status).toBe(404);

    // Add service
    provideService(mockService);
    const request2 = new Request("http://example.com/api/dynamic");
    const response2 = await fetch(request2);
    expect(response2).toBe(mockResponse);

    // Remove service
    removeService();
    const request3 = new Request("http://example.com/api/dynamic");
    const response3 = await fetch(request3);
    expect(response3.status).toBe(404);
  });

  it("should handle case-insensitive HTTP method matching", async () => {
    const mockResponse = new Response("Method response", { status: 200 });
    const mockService: HttpService = {
      path: "/api/method",
      method: "post", // lowercase
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService] = newHttpServiceProvider(context);
    provideService(mockService);

    const [fetch] = newHttpServiceDispatcher(context);
    const request = new Request("http://example.com/api/method", {
      method: "POST", // uppercase
    });
    const response = await fetch(request);

    expect(mockService.fetch).toHaveBeenCalledWith(request);
    expect(response).toBe(mockResponse);
  });

  it("should cleanup properly when remove function is called", async () => {
    const mockResponse = new Response("Service response", { status: 200 });
    const mockService: HttpService = {
      path: "/api/cleanup",
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService, _removeService] = newHttpServiceProvider(context);
    const [fetch, remove] = newHttpServiceDispatcher(context);

    // Add service
    provideService(mockService);

    // Service should work initially
    const request1 = new Request("http://example.com/api/cleanup");
    const response1 = await fetch(request1);
    expect(response1).toBe(mockResponse);

    // Call remove to cleanup the dispatcher's service consumer
    remove();

    // Add a new service after cleanup - it should not be visible to the dispatcher
    const newMockService: HttpService = {
      path: "/api/new-service",
      fetch: vi.fn().mockResolvedValue(new Response("New service", { status: 200 })),
    };

    const [provideService2] = newHttpServiceProvider(context);
    provideService2(newMockService);

    // The new service should not be available since dispatcher is disconnected
    const request2 = new Request("http://example.com/api/new-service");
    const response2 = await fetch(request2);
    expect(response2.status).toBe(404);

    // The original service should still work since it was registered before cleanup
    const request3 = new Request("http://example.com/api/cleanup");
    const response3 = await fetch(request3);
    expect(response3).toBe(mockResponse);
  });

  it("should handle services with overlapping patterns correctly", async () => {
    const generalResponse = new Response("General", { status: 200 });
    const specificResponse = new Response("Specific", { status: 200 });

    const generalService: HttpService = {
      path: "/api/*",
      priority: 5,
      fetch: vi.fn().mockResolvedValue(generalResponse),
    };

    const specificService: HttpService = {
      path: "/api/specific",
      priority: 10,
      fetch: vi.fn().mockResolvedValue(specificResponse),
    };

    const [provideService1] = newHttpServiceProvider(context);
    const [provideService2] = newHttpServiceProvider(context);

    provideService1(generalService);
    provideService2(specificService);

    const [fetch] = newHttpServiceDispatcher(context);

    // Specific path should match the higher priority service
    const specificRequest = new Request("http://example.com/api/specific");
    const specificResponseResult = await fetch(specificRequest);

    expect(specificService.fetch).toHaveBeenCalledWith(specificRequest);
    expect(generalService.fetch).not.toHaveBeenCalled();
    expect(specificResponseResult).toBe(specificResponse);
  });

  it("should handle optional parameters in URL patterns", async () => {
    const mockResponse = new Response("Optional param", { status: 200 });

    // Since URLPattern doesn't support optional parameters like Express.js,
    // we need to register two separate patterns to handle both cases
    const baseService: HttpService = {
      path: "/api/items/:id",
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const editService: HttpService = {
      path: "/api/items/:id/edit",
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService1] = newHttpServiceProvider(context);
    const [provideService2] = newHttpServiceProvider(context);

    provideService1(baseService);
    provideService2(editService);

    const [fetch] = newHttpServiceDispatcher(context);

    // Should match both patterns
    const request1 = new Request("http://example.com/api/items/123");
    const request2 = new Request("http://example.com/api/items/123/edit");

    const response1 = await fetch(request1);
    const response2 = await fetch(request2);

    expect(response1).toBe(mockResponse);
    expect(response2).toBe(mockResponse);
    expect(baseService.fetch).toHaveBeenCalledWith(request1);
    expect(editService.fetch).toHaveBeenCalledWith(request2);
  });

  it("should handle multiple wildcard segments", async () => {
    const mockResponse = new Response("Multiple wildcards", { status: 200 });
    const mockService: HttpService = {
      path: "/files/*/download/*",
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService] = newHttpServiceProvider(context);
    provideService(mockService);

    const [fetch] = newHttpServiceDispatcher(context);
    const request = new Request("http://example.com/files/documents/download/file.pdf");
    const response = await fetch(request);

    expect(mockService.fetch).toHaveBeenCalledWith(request);
    expect(response).toBe(mockResponse);
  });

  it("should handle query parameters in requests", async () => {
    const mockResponse = new Response("With query", { status: 200 });
    const mockService: HttpService = {
      path: "/api/search",
      fetch: vi.fn().mockResolvedValue(mockResponse),
    };

    const [provideService] = newHttpServiceProvider(context);
    provideService(mockService);

    const [fetch] = newHttpServiceDispatcher(context);
    const request = new Request("http://example.com/api/search?q=test&limit=10");
    const response = await fetch(request);

    expect(mockService.fetch).toHaveBeenCalledWith(request);
    expect(response).toBe(mockResponse);
  });
});

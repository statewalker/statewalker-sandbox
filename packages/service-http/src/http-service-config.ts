import { newAdapter } from "@statewalker/shared-adapters";

export type HttpServiceConfig = {
  port: number;
  host: string;
  cors?: {
    origin: string;
    methods?: string[];
    headers?: string[];
    credentials?: boolean;
  };
};
export const [getHttpServiceConfig, setHttpServiceConfig, removeHttpServiceConfig] =
  newAdapter<HttpServiceConfig>("config:http-service", () => {
    const envMap: Record<string, unknown> =
      typeof process !== "undefined" && typeof process.env === "object" ? process.env : {};
    return {
      port: Number(envMap.PORT ?? 3002),
      host: String(envMap.HOST ?? "0.0.0.0"),
      cors: { origin: String(envMap.CORS_ORIGIN ?? "*") },
    };
  });

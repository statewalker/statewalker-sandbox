import { newAdapter } from "@statewalker/shared-adapters";
import { getLogger } from "@statewalker/shared-logger";
import { newRegistry } from "@statewalker/shared-registry";
import { Pool } from "pg";

export function newPool({
  host = process.env.POSTGRES_HOST ?? "localhost",
  port = Number(process.env.POSTGRES_PORT ?? 5432),
  user = process.env.POSTGRES_USER ?? "postgres",
  password = process.env.POSTGRES_PASSWORD ?? "password",
  database = process.env.POSTGRES_DB ?? "decider",
}: {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
} = {}): Pool {
  return new Pool({ host, port, user, password, database });
}

export const [getDbConnectionPool, setDbConnectionPool, removeDbConnectionPool] = newAdapter<Pool>(
  "db:connection-pool",
  () => newPool(),
);

const POOL_ADAPTER_KEY = "db:connection-pool";

export default async function initDbConnectionPool(
  context: Record<string, unknown>,
): Promise<() => Promise<void>> {
  // Already initialized — return no-op to avoid double pool.end()
  if (POOL_ADAPTER_KEY in context) {
    return async () => {};
  }

  const logger = getLogger(context);
  const [register, cleanup] = newRegistry();
  try {
    const pool = getDbConnectionPool(context);
    register(async () => {
      removeDbConnectionPool(context);
      await pool.end();
    });

    // Prevent unhandled 'error' events from crashing the process during shutdown
    pool.on("error", (error) =>
      logger.error("Unexpected error on idle database client", { error }),
    );
    // Test connection
    await pool.query("SELECT 1");
    return cleanup;
  } catch (error) {
    // If the connection fails, ensure we clean up any resources before exiting
    await cleanup();
    logger.error("Failed to connect to the database", { error });
    throw error;
  }
}

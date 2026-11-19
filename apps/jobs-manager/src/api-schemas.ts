import { z } from "@hono/zod-openapi";

/**
 * Zod schemas of the REST API's bodies. They validate requests and generate the OpenAPI document
 * (`GET <basePath>/openapi.json`); the `.openapi(name)` ones become `components.schemas`.
 */

const JsonValue = z.unknown().openapi({ description: "Any JSON value" });

const JsonSchemaPart = z
  .union([z.record(z.string(), z.unknown()), z.boolean()])
  .openapi({ description: "A JSON Schema (draft 2020-12)" });

export const Issue = z
  .object({
    path: z
      .string()
      .openapi({ description: "JSON Pointer into the value; `/` is the value itself" }),
    message: z.string(),
  })
  .openapi("Issue");

export const ErrorBody = z
  .object({
    error: z.object({
      code: z.string().openapi({
        description:
          "invalid_params, task_upload_disabled, unknown_task, unknown_job, not_found, method_not_allowed, internal",
      }),
      message: z.string(),
      issues: z
        .array(Issue)
        .optional()
        .openapi({ description: "Schema violations, when a schema rejected the value" }),
    }),
  })
  .openapi("Error");

export const JobStatus = z
  .enum(["pending", "running", "done", "error", "interrupted"])
  .openapi("JobStatus");

export const JobInfo = z
  .object({
    id: z.string(),
    task: z.string(),
    params: JsonValue,
    status: JobStatus,
    created: z.number().openapi({ description: "Stamp of the `pending` message (epoch ms)" }),
    updated: z.number().openapi({ description: "Stamp of the latest status change" }),
    pid: z.number().int().optional().openapi({ description: "Process group id while running" }),
  })
  .openapi("JobInfo");

export const JobMessage = z
  .object({
    stamp: z.number().openapi({
      description:
        "Epoch ms with microsecond fractions; strictly increasing within a job; the resume cursor",
    }),
    status: JobStatus,
    message: JsonValue.optional().openapi({
      description: "One stdout line: parsed JSON, or the raw string",
    }),
    error: JsonValue.optional().openapi({
      description:
        "One stderr line (parsed JSON or raw string); `{ code: invalid_message | invalid_error, issues, raw }` for a line its schema rejected; the failure of a finished job",
    }),
  })
  .openapi("JobMessage");

export const TaskSchema = z
  .object({
    params: JsonSchemaPart.optional().openapi({ description: "The job's params (JOB_PARAMS)" }),
    body: JsonSchemaPart.optional().openapi({
      description:
        "The input: a JSON Schema means JSONL, each line checked; `{ contentMediaType }` without `type` means opaque bytes",
    }),
    message: JsonSchemaPart.optional().openapi({ description: "Each stdout line" }),
    error: JsonSchemaPart.optional().openapi({ description: "Each stderr line" }),
  })
  .openapi("TaskSchema");

export const TaskInfo = z.object({ name: z.string(), hasCleanup: z.boolean() }).openapi("TaskInfo");

export const TaskUploadBody = z.object({
  ext: z.string().openapi({ description: "Launcher extension: sh, py, js, ts, …" }),
  script: z.string().openapi({ description: "The job script's source" }),
  cleanup: z.string().optional().openapi({ description: "Cleanup script source, same launcher" }),
  schema: TaskSchema.optional(),
});

export const StartResponse = z.object({
  jobId: z.string(),
  statusUrl: z.string(),
  logsUrl: z.string(),
  eventsUrl: z.string(),
});

export const CleanupResult = z.object({
  removed: z.array(z.string()),
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
});

/**
 * The job-start body as plain JSON Schemas, not Zod: the adapter would validate (and so consume)
 * a Zod-typed body, while the handler must read it itself, as JSON params, a multipart form or a
 * raw byte stream.
 */
export const START_BODY = {
  "application/json": {
    schema: { description: "The job's params, any JSON value; no input" },
  },
  "multipart/form-data": {
    schema: {
      type: "object" as const,
      properties: {
        params: { type: "string" as const, description: "The job's params as JSON text" },
        input: {
          type: "string" as const,
          format: "binary",
          description: "The job's input (stdin)",
        },
      },
    },
  },
  "application/octet-stream": {
    schema: {
      type: "string" as const,
      format: "binary",
      description:
        "The job's input (stdin), params in `?params=`. Any content type other than JSON and multipart is taken this way, e.g. image/png or application/x-ndjson",
    },
  },
};

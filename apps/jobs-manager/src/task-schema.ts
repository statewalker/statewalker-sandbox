import { z } from "zod";
import { lines } from "./jsonl.ts";
import { type ByteInput, type Issue, JobsError, type TaskSchema } from "./types.ts";

/**
 * A task's schema compiled into checks. Each part is a JSON Schema that `z.fromJSONSchema` reads;
 * a missing part checks nothing. Checks only report: values are never coerced or defaulted.
 *
 *   params   the job's params (JOB_PARAMS)
 *   body     a JSON Schema: the input is JSONL, each line checked;
 *            `{ contentMediaType }` without `type`: opaque bytes, not checked
 *   message  each stdout line (parsed JSON, or the raw string)
 *   error    each stderr line (parsed JSON, or the raw string)
 */
export type TaskChecks = {
  params?: Check;
  /** Absent for an opaque body. */
  body?: Check;
  message?: Check;
  error?: Check;
};

/** Issues found in a value, or `undefined` when it matches. */
export type Check = (value: unknown) => Issue[] | undefined;

const PARTS = ["params", "body", "message", "error"] as const;

/**
 * Formats whose meaning Zod gets wrong: it reads `uri-reference` as an absolute URL, so a relative
 * reference (`/outputs/…`) would fail. They are left as annotations, which is what JSON Schema
 * 2020-12 makes every format by default.
 */
const ANNOTATION_FORMATS = new Set(["uri-reference", "iri-reference", "uri-template"]);

const compiled = new Map<string, TaskChecks>();

/** Compiles a schema once per distinct content; throws an Error naming the part that is invalid. */
export function compileTaskSchema(schema: TaskSchema): TaskChecks {
  const key = JSON.stringify(schema);
  const cached = compiled.get(key);
  if (cached) return cached;
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error("a task schema must be an object { params?, body?, message?, error? }");
  const checks: TaskChecks = {};
  for (const part of PARTS) {
    const value = schema[part];
    if (value === undefined) continue;
    if (part === "body" && isOpaque(value)) continue;
    try {
      if (
        typeof value !== "boolean" &&
        (typeof value !== "object" || value === null || Array.isArray(value))
      )
        throw new Error("must be a JSON Schema object");
      checks[part] = checkOf(z.fromJSONSchema(withoutAnnotationFormats(value) as never));
    } catch (e) {
      throw new Error(`${part}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  compiled.set(key, checks);
  return checks;
}

/** A body schema that only names a media type: the input is bytes, not JSON lines. */
function isOpaque(body: unknown): boolean {
  return (
    typeof body === "object" && body !== null && "contentMediaType" in body && !("type" in body)
  );
}

function checkOf(schema: z.ZodType): Check {
  return (value) => {
    const result = schema.safeParse(value);
    return result.success ? undefined : result.error.issues.map(toIssue);
  };
}

function toIssue(issue: z.core.$ZodIssue): Issue {
  return { path: `/${issue.path.map(String).join("/")}`, message: issue.message };
}

function withoutAnnotationFormats(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutAnnotationFormats);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "format" && typeof value === "string" && ANNOTATION_FORMATS.has(value)) continue;
    out[key] = withoutAnnotationFormats(value);
  }
  return out;
}

/** "params: /sizes/0: Too small…; /: Unrecognized key…" */
export function describeIssues(what: string, issues: Issue[]): string {
  return `${what}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`;
}

/**
 * Passes the input through unchanged while checking every line against the body schema. A line
 * that is not JSON or does not match throws `invalid_params` naming it, which fails the upload
 * (and with it `start`). Blank lines are skipped.
 */
export async function* checkedJsonl(input: ByteInput, check: Check): AsyncGenerator<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const tee = async function* () {
    for await (const chunk of input as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      yield chunk;
    }
  };
  let number = 0;
  for await (const line of lines(tee())) {
    number++;
    while (chunks.length > 0) yield chunks.shift() as Uint8Array;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new JobsError("invalid_params", `input line ${number} is not JSON`);
    }
    const issues = check(value);
    if (issues)
      throw new JobsError("invalid_params", describeIssues(`input line ${number}`, issues), issues);
  }
  while (chunks.length > 0) yield chunks.shift() as Uint8Array;
}

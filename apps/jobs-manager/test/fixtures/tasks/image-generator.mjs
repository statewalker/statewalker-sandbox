// Stand-in for an image resizer: reads the "image" from stdin and stores one object per size in a
// bucket directory (standing in for S3), reporting each object key as a JSON line.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { bucket, sizes = [64, 128] } = JSON.parse(process.env.JOB_PARAMS);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const image = Buffer.concat(chunks);

await mkdir(bucket, { recursive: true });
for (const size of sizes) {
  const key = `${process.env.JOB_ID}/${size}.bin`;
  await mkdir(join(bucket, process.env.JOB_ID), { recursive: true });
  await writeFile(join(bucket, key), image.subarray(0, size));
  console.log(JSON.stringify({ key, size, bytes: Math.min(size, image.length) }));
}

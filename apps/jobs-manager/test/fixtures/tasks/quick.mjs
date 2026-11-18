// Returns immediately: echoes its parameters and job id as one JSON line.
const params = JSON.parse(process.env.JOB_PARAMS ?? "null");
console.log(JSON.stringify({ hello: "world", params, jobId: process.env.JOB_ID }));

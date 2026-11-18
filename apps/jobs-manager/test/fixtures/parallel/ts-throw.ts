// Fails with an uncaught error after one result line: Node prints the stack to stderr, exit code 1.
console.log(JSON.stringify({ step: 1 }));
throw new Error("ts failure");

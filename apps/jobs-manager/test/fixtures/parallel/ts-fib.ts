// Computes Fibonacci numbers up to params.n with BigInt, one line each (values as strings).
const { n }: { n: number } = JSON.parse(process.env.JOB_PARAMS!);
let [a, b] = [0n, 1n];
for (let i = 1; i <= n; i++) {
  [a, b] = [b, a + b];
  console.log(JSON.stringify({ n: i, fib: a.toString() }));
}

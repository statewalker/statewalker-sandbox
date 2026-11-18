# Reports the length of every input line.
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  echo "{\"n\":$n,\"length\":${#line}}"
done

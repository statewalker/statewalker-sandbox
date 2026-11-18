# Hashes the input stream.
sum=$(sha256sum | cut -d' ' -f1)
echo "{\"sha256\":\"$sum\"}"

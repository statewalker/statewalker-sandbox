# Reference files

From the Hugging Face dataset `xet-team/xet-spec-reference-files` (Apache-2.0), the reference
data of the Xet protocol specification (https://huggingface.co/docs/xet):

- `Electric_Vehicle_Population_Data_20250917.csv.chunks`: the 796 chunks of the reference CSV
  (63,527,244 bytes), one `<chunk hash> <length>` line each;
- `….csv.xet-file-hash`, `….csv.xet-xorb-hash`: its file hash and its xorb's hash;
- `eea25d6e….xorb.range-hash`: the verification hash of the range of all 796 chunks;
- `….csv.shard`, `….csv.shard.verification`, `….csv.shard.verification-no-footer`,
  `….csv.shard.dedupe` (X11b): the reference shards, unchanged;
- `recon.recorded.json`: the reconstruction answer of `cas-server.xethub.hf.co` for the CSV's file
  hash (anonymous read token, 2026-11-12), with each signed URL replaced by `xorb://<hash>`.

The xorb itself (14.7 MB) is downloaded by the tests from the dataset (revision
`c4aa3a3f15b1395fff5ce934784bf6c8f2d62de8`, SHA-256 checked) and cached in the system's temporary
directory (`XET_REFERENCE_CACHE` names another, which CI keeps in its cache keyed by that SHA-256,
so huggingface.co is reached only on a cache miss); it is not committed. The CSV the reference files describe is Washington State's
"Electric Vehicle Population Data" (data.wa.gov, 2025-09-17); only hashes and lengths derived from
it are committed here.

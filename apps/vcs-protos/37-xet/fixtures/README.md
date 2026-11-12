# Reference files

From the Hugging Face dataset `xet-team/xet-spec-reference-files` (Apache-2.0), the reference
data of the Xet protocol specification (https://huggingface.co/docs/xet):

- `Electric_Vehicle_Population_Data_20250917.csv.chunks`: the 796 chunks of the reference CSV
  (63,527,244 bytes), one `<chunk hash> <length>` line each;
- `….csv.xet-file-hash`, `….csv.xet-xorb-hash`: its file hash and its xorb's hash;
- `eea25d6e….xorb.range-hash`: the verification hash of the range of all 796 chunks;
- `recon.recorded.json`: the reconstruction answer of `cas-server.xethub.hf.co` for the CSV's file
  hash (anonymous read token, 2026-11-12), with each signed URL replaced by `xorb://<hash>`.

The xorb itself (14.7 MB) is downloaded by the tests from the dataset and cached in the system's
temporary directory.

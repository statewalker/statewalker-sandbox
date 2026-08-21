import { biscuit, block, AuthorizerBuilder, KeyPair, SignatureAlgorithm, Biscuit } from "@biscuit-auth/biscuit-wasm";
const L = { max_facts: 5000, max_iterations: 200, max_time_micro: 1_000_000 };
const root = new KeyPair(SignatureAlgorithm.Ed25519);
// warm-up
try { new AuthorizerBuilder().buildUnauthenticated().authorizeWithLimits(L); } catch {}

const t = biscuit`
  bound("ALICE");
  check if bound($k), connection_peer($k);
`.build(root.getPrivateKey());

const present = (tok, provenPeer, label) => {
  const b = new AuthorizerBuilder();
  b.addCode(`connection_peer("${provenPeer}"); allow if true;`);
  try { b.buildAuthenticated(Biscuit.fromBase64(tok.toBase64(), root.getPublicKey())).authorizeWithLimits(L);
        console.log(`  ${label.padEnd(46)} -> ALLOWED  *** `); }
  catch { console.log(`  ${label.padEnd(46)} -> denied`); }
};

console.log("attacker-controlled paths:");
// 1. thief appends a plain block asserting the node's fact
present(t.appendBlock(block`connection_peer("THIEF");`), "THIEF", "appended block asserts connection_peer(THIEF)");
// 2. thief appends a block asserting bound(), matching its own key
present(t.appendBlock(block`bound("THIEF");`), "THIEF", "appended block asserts bound(THIEF)");
// 3. control: honest use
present(t, "ALICE", "control: Alice over her own connection");
// 4. control: the hostile-HUB case my check tests
const hubEcho = biscuit`
  bound("ALICE"); connection_peer("ALICE");
  check if bound($k), connection_peer($k);
`.build(root.getPrivateKey());
present(hubEcho, "THIEF", "AUTHORITY block contains connection_peer(ALICE)");

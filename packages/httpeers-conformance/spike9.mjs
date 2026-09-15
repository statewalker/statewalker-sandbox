import { Biscuit, generateKeypair } from "@statewalker/webrun-biscuit";

const root = generateKeypair();

const t = Biscuit.build(
  root.secretKey,
  `
  bound("ALICE");
  check if bound($k), connection_peer($k);
`,
);

const present = (tok, provenPeer, label) => {
  const verdict = Biscuit.fromBase64(tok.toBase64())
    .verify(root.publicKey)
    .authorize("connection_peer({peer}); allow if true;", { params: { peer: provenPeer } });
  console.log(`  ${label.padEnd(46)} -> ${verdict.kind === "ok" ? "ALLOWED  *** " : "denied"}`);
};

console.log("attacker-controlled paths:");
// 1. thief appends a plain block asserting the node's fact
present(
  t.attenuate('connection_peer("THIEF");'),
  "THIEF",
  "appended block asserts connection_peer(THIEF)",
);
// 2. thief appends a block asserting bound(), matching its own key
present(t.attenuate('bound("THIEF");'), "THIEF", "appended block asserts bound(THIEF)");
// 3. control: honest use
present(t, "ALICE", "control: Alice over her own connection");
// 4. control: the hostile-HUB case my check tests
const hubEcho = Biscuit.build(
  root.secretKey,
  `
  bound("ALICE"); connection_peer("ALICE");
  check if bound($k), connection_peer($k);
`,
);
present(hubEcho, "THIEF", "AUTHORITY block contains connection_peer(ALICE)");

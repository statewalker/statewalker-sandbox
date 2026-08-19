/**
 * A-3: the role vocabulary.
 *
 * Written question: can role names be declared once, validated, and kept
 * out of policy — so that a typo is caught rather than silently denying?
 */
import { describe, expect, it } from "vitest";
import { validateAccessTree, withAccessTree } from "../src/access-tree.js";
import type { AccessTree } from "../src/access-tree.js";
import {
  DEFAULT_VOCABULARY,
  VocabularyError,
  assertValid,
  expandRoles,
  validateRoles,
  validateVocabulary,
} from "../src/vocabulary.js";
import type { Vocabulary } from "../src/vocabulary.js";

const usesTransportIdentity = async () => false;

describe("A-3: role expansion", () => {
  it("a role confers its own capabilities", () => {
    expect([...expandRoles(DEFAULT_VOCABULARY, ["member"])].sort()).toEqual([
      "std:mesh.read",
      "std:presence.write",
      "std:test",
    ]);
  });

  it("implication is transitive — admin need not restate member", () => {
    const caps = expandRoles(DEFAULT_VOCABULARY, ["admin"]);
    expect(caps.has("std:mesh.admin")).toBe(true);
    expect(caps.has("std:mesh.read")).toBe(true); // via implies: ['member']
  });

  it("several roles union their capabilities", () => {
    const caps = expandRoles(DEFAULT_VOCABULARY, ["member", "admin"]);
    expect(caps.has("std:mesh.admin")).toBe(true);
  });

  it("an unknown role contributes nothing but does not throw", () => {
    // A peer may hold a role our copy of the vocabulary has not heard of.
    // Version skew degrades to FEWER permissions, never more.
    expect([...expandRoles(DEFAULT_VOCABULARY, ["nonesuch"])]).toEqual([]);
  });

  it("a cycle terminates rather than hanging", () => {
    const v: Vocabulary = {
      version: 1,
      capabilities: { "x:a": {}, "x:b": {} },
      roles: {
        a: { capabilities: ["x:a"], implies: ["b"] },
        b: { capabilities: ["x:b"], implies: ["a"] },
      },
    };
    expect([...expandRoles(v, ["a"])].sort()).toEqual(["x:a", "x:b"]);
  });
});

describe("A-3: vocabulary validation", () => {
  it("accepts the default vocabulary", () => {
    expect(validateVocabulary(DEFAULT_VOCABULARY)).toEqual([]);
  });

  it("rejects a role conferring an undeclared capability", () => {
    const v: Vocabulary = { version: 1, capabilities: {}, roles: { r: { capabilities: ["x:missing"] } } };
    expect(validateVocabulary(v)[0]).toMatch(/undeclared capability 'x:missing'/);
  });

  it("rejects a role implying an unknown role", () => {
    const v: Vocabulary = { version: 1, capabilities: {}, roles: { r: { implies: ["ghost"] } } };
    expect(validateVocabulary(v)[0]).toMatch(/unknown role 'ghost'/);
  });

  it("reports a cycle", () => {
    const v: Vocabulary = {
      version: 1,
      capabilities: {},
      roles: { a: { implies: ["b"] }, b: { implies: ["a"] } },
    };
    expect(validateVocabulary(v).some((p) => /cycle/.test(p))).toBe(true);
  });

  it("catches an unknown role in an invitation", () => {
    expect(validateRoles(DEFAULT_VOCABULARY, ["member", "admni"], "invitation CODE-A")[0]).toMatch(
      /invitation CODE-A: unknown role 'admni'/,
    );
  });
});

describe("A-3: policy validation", () => {
  it("accepts a tree naming declared capabilities", () => {
    const tree: AccessTree = { "/": { anyOf: [] }, "/x/": { anyOf: ["std:test"] } };
    expect(validateAccessTree(DEFAULT_VOCABULARY, tree)).toEqual([]);
  });

  it("catches an undeclared capability, including under a method override", () => {
    const tree: AccessTree = {
      "/a/": { anyOf: ["std:nope"] },
      "/b/": { anyOf: ["std:test"], methods: { PUT: { anyOf: ["std:alsonope"] } } },
    };
    const problems = validateAccessTree(DEFAULT_VOCABULARY, tree);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toMatch(/\[PUT\]: undeclared capability 'std:alsonope'/);
  });

  it("catches a ROLE name used where a capability belongs", () => {
    // The exact mistake the old design invited: policy naming 'admin'.
    const tree: AccessTree = { "/admin/": { anyOf: ["admin"] } };
    expect(validateAccessTree(DEFAULT_VOCABULARY, tree)[0]).toMatch(/undeclared capability 'admin'/);
  });
});

describe("A-3: fail fast, not closed", () => {
  it("withAccessTree THROWS on an invalid policy rather than denying at runtime", () => {
    // A policy that denies everyone because of a typo is indistinguishable
    // from a policy that works. Refusing to start is the better failure.
    expect(() =>
      withAccessTree({ tree: { "/x/": { anyOf: ["std:typo"] } }, usesTransportIdentity }),
    ).toThrow(VocabularyError);
  });

  it("the error names every problem, not just the first", () => {
    try {
      withAccessTree({
        tree: { "/a/": { anyOf: ["std:one"] }, "/b/": { anyOf: ["std:two"] } },
        usesTransportIdentity,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as VocabularyError).problems).toHaveLength(2);
    }
  });

  it("a valid policy constructs cleanly", () => {
    expect(() =>
      withAccessTree({
        tree: { "/": { anyOf: [] }, "/test/": { anyOf: ["std:test"] } },
        usesTransportIdentity,
      }),
    ).not.toThrow();
  });

  it("assertValid is a no-op on an empty problem list", () => {
    expect(() => assertValid([])).not.toThrow();
  });
});

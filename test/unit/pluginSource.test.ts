import { describe, it, expect } from "vitest";
import { parseSource, parseSemverTag, compareSemver, rewriteRef } from "../../src/plugins/source.js";

describe("parseSource — github: sugar", () => {
  it("normalizes github:org/repo@ref to an https remote", () => {
    const { source, errors } = parseSource("github:org/repo@v1.2.3");
    expect(errors).toEqual([]);
    expect(source).toMatchObject({ kind: "git", remote: "https://github.com/org/repo.git", ref: "v1.2.3", refKind: "named" });
    expect(source?.subdir).toBeUndefined();
    expect(source?.spec).toBe("github:org/repo@v1.2.3");
  });

  it("classifies a 40-hex ref as a pinned SHA", () => {
    const sha = "a".repeat(40);
    expect(parseSource(`github:org/repo@${sha}`).source?.refKind).toBe("sha");
  });

  it("accepts an uppercase SHA, classifies it sha, and normalizes to lowercase", () => {
    const { source } = parseSource(`github:org/repo@${"ABCDEF0123".repeat(4)}`);
    expect(source?.refKind).toBe("sha");
    expect(source?.ref).toBe("abcdef0123".repeat(4));
  });

  it("classifies @HEAD as floating", () => {
    expect(parseSource("github:org/repo@HEAD").source?.refKind).toBe("head");
  });

  it("supports a #path= subdir", () => {
    const { source, errors } = parseSource("github:org/repo@main#path=plugins/foo");
    expect(errors).toEqual([]);
    expect(source?.subdir).toBe("plugins/foo");
    expect(source?.ref).toBe("main");
  });
});

describe("parseSource — git+https://", () => {
  it("accepts a generic git+https URL", () => {
    const { source, errors } = parseSource("git+https://git.example.com/team/plug.git@v2");
    expect(errors).toEqual([]);
    expect(source).toMatchObject({ remote: "https://git.example.com/team/plug.git", ref: "v2" });
  });

  it("accepts a host:port", () => {
    expect(parseSource("git+https://host:8443/a/b.git@main").source?.remote).toBe("https://host:8443/a/b.git");
  });

  it("requires the path to end in .git", () => {
    expect(parseSource("git+https://host/a/b@main").errors.some((e) => /end in '\.git'/.test(e))).toBe(true);
  });
});

describe("parseSource — required @ref (D1: no silent default branch)", () => {
  it("rejects a github source with no @ref", () => {
    const { source, errors } = parseSource("github:org/repo");
    expect(source).toBeUndefined();
    expect(errors.some((e) => /missing required '@<ref>'/.test(e))).toBe(true);
  });

  it("rejects a git+https source with no @ref", () => {
    expect(parseSource("git+https://host/a/b.git").errors.some((e) => /missing required '@<ref>'/.test(e))).toBe(true);
  });
});

describe("parseSource — #path= containment (D2)", () => {
  const cases: Array<[string, RegExp]> = [
    ["github:org/repo@v1#path=../escape", /not a contained relative path/],
    ["github:org/repo@v1#path=/abs", /not a contained relative path/],
    ["github:org/repo@v1#path=a\\b", /not a contained relative path/],
    ["github:org/repo@v1#path=", /#path= is empty/],
    ["github:org/repo@v1#frag=x", /unknown fragment/],
  ];
  for (const [spec, re] of cases) {
    it(spec, () => {
      const { source, errors } = parseSource(spec);
      expect(source).toBeUndefined();
      expect(errors.some((e) => re.test(e))).toBe(true);
    });
  }
});

describe("parseSource — ref safety (check-ref-format + arg-injection guard)", () => {
  const badRefs: Array<[string, RegExp]> = [
    ["-cfoo", /not a valid git ref/],
    ["--upload-pack=evil", /invalid characters|not a valid git ref/],
    ["..", /not a valid git ref/],
    ["feature/..", /not a valid git ref/],
    ["/main", /not a valid git ref/],
    ["main/", /not a valid git ref/],
    ["foo.lock", /not a valid git ref/],
    ["a..b", /not a valid git ref/],
  ];
  for (const [ref, re] of badRefs) {
    it(`rejects @${ref}`, () => {
      const { source, errors } = parseSource(`github:org/repo@${ref}`);
      expect(source).toBeUndefined();
      expect(errors.some((e) => re.test(e))).toBe(true);
    });
  }
  it("accepts a normal hierarchical branch name", () => {
    expect(parseSource("github:org/repo@release/v1.2").source?.ref).toBe("release/v1.2");
  });
});

describe("parseSource — github sugar validation", () => {
  it("rejects a repo with the .git suffix (would double to .git.git)", () => {
    expect(parseSource("github:org/repo.git@v1").errors.some((e) => /\.git' suffix/.test(e))).toBe(true);
  });
  for (const owner of [".owner", "owner.", "-owner", "owner-", "ow--ner"]) {
    it(`rejects invalid owner '${owner}'`, () => {
      expect(parseSource(`github:${owner}/repo@v1`).source).toBeUndefined();
    });
  }
});

describe("parseSource — git+https hardening", () => {
  const httpsCases: Array<[string, string, RegExp]> = [
    ["userinfo credential smuggling", "git+https://user:pass@host/a/b.git@v1", /must not contain credentials/],
    ["dot-segment in path", "git+https://host/a/../b.git@v1", /segments|invalid/],
    ["double slash in path", "git+https://host/a//b.git@v1", /segments|invalid/],
    ["invalid host (leading dot)", "git+https://.host/a/b.git@v1", /invalid host/],
    ["invalid port", "git+https://host:99999/a/b.git@v1", /invalid port/],
  ];
  for (const [label, spec, re] of httpsCases) {
    it(label, () => {
      const { source, errors } = parseSource(spec);
      expect(source).toBeUndefined();
      expect(errors.some((e) => re.test(e))).toBe(true);
    });
  }
});

describe("parseSource — rejected forms", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["ssh git+ssh", "git+ssh://host/a/b.git@v1", /ssh sources are not supported/],
    ["ssh scp-style", "git@github.com:org/repo.git@v1", /ssh sources are not supported/],
    ["local relative", "./my-plugin@v1", /local-path sources are not supported/],
    ["local absolute", "/home/x/plugin@v1", /local-path sources are not supported/],
    ["file url", "file:///x@v1", /local-path sources are not supported/],
    ["the org/repo/path shorthand (ambiguous)", "github:org/repo/plugins/foo@v1", /must be 'github:<org>\/<repo>'/],
    ["unknown scheme", "svn://host/x@v1", /unrecognized source/],
    ["empty", "", /required/],
    ["bad ref chars", "github:org/repo@v 1", /invalid characters/],
  ];
  for (const [label, spec, re] of cases) {
    it(label, () => {
      const { source, errors } = parseSource(spec);
      expect(source).toBeUndefined();
      expect(errors.some((e) => re.test(e))).toBe(true);
    });
  }
});

describe("parseSource — robustness", () => {
  it("trims surrounding whitespace and records the trimmed spec", () => {
    expect(parseSource("  github:org/repo@v1  ").source?.spec).toBe("github:org/repo@v1");
  });
  it("never throws on junk input", () => {
    for (const junk of ["@@@", "#path=x", "github:@v1", "git+https://@v1", "github:/@v1"]) {
      expect(() => parseSource(junk)).not.toThrow();
      expect(parseSource(junk).source).toBeUndefined();
    }
  });
});

// ── spec 266 — semver-tag helpers ───────────────────────────────────────────

describe("parseSemverTag", () => {
  it("parses a v-prefixed full semver tag", () => {
    expect(parseSemverTag("v0.6.0")).toEqual({ major: 0, minor: 6, patch: 0 });
    expect(parseSemverTag("V2.10.3")).toEqual({ major: 2, minor: 10, patch: 3 });
  });

  it("parses a bare semver and tolerates a missing minor/patch (→ 0)", () => {
    expect(parseSemverTag("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemverTag("v1.2")).toEqual({ major: 1, minor: 2, patch: 0 });
    expect(parseSemverTag("v3")).toEqual({ major: 3, minor: 0, patch: 0 });
  });

  it("ignores a prerelease/build suffix for the numeric triple", () => {
    expect(parseSemverTag("v0.6.0-rc1")).toEqual({ major: 0, minor: 6, patch: 0 });
    expect(parseSemverTag("1.0.0+build.7")).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it("returns null for a non-semver tag (never mis-ordered)", () => {
    for (const t of ["nightly", "latest", "release-2024", "main", "HEAD", "", "vX.Y.Z", "v-1.0.0"]) {
      expect(parseSemverTag(t)).toBeNull();
    }
  });
});

describe("compareSemver", () => {
  it("orders by major→minor→patch, tolerating a leading v and a plain manifest version", () => {
    expect(compareSemver("v0.6.0", "v0.5.0")).toBeGreaterThan(0);
    expect(compareSemver("v0.5.0", "v0.6.0")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0); // manifest-version form (no v)
    expect(compareSemver("v1.2.0", "1.2.0")).toBe(0); // v-prefix vs bare are equal
    expect(compareSemver("v1.0.0-rc1", "v1.0.0")).toBe(0); // prerelease ignored for ordering
  });

  it("treats a non-semver input as 0.0.0", () => {
    expect(compareSemver("nightly", "v0.0.0")).toBe(0);
    expect(compareSemver("v0.0.1", "garbage")).toBeGreaterThan(0);
  });
});

describe("rewriteRef", () => {
  it("swaps the @ref and preserves a #path= fragment (github sugar)", () => {
    expect(rewriteRef("github:cfpperche/tachyon-plugins@v0.5.0#path=secrets-guard", "v0.6.0")).toBe(
      "github:cfpperche/tachyon-plugins@v0.6.0#path=secrets-guard",
    );
  });

  it("swaps the @ref without a fragment, and for a git+https locator", () => {
    expect(rewriteRef("github:o/r@v1.0.0", "v2.0.0")).toBe("github:o/r@v2.0.0");
    expect(rewriteRef("git+https://example.com/o/r.git@v1.0.0#path=p", "v2.0.0")).toBe(
      "git+https://example.com/o/r.git@v2.0.0#path=p",
    );
  });

  it("rewrites on the LAST @ (the ref delimiter), leaving an earlier @ intact", () => {
    // contrived, but proves we split like parseSource does
    expect(rewriteRef("github:o/r@v1@v1.0.0", "v2.0.0")).toBe("github:o/r@v1@v2.0.0");
  });

  it("is idempotent and returns the spec unchanged when there is no @ref to rewrite", () => {
    expect(rewriteRef("github:o/r@v1.0.0", "v1.0.0")).toBe("github:o/r@v1.0.0");
    expect(rewriteRef("github:o/r", "v2.0.0")).toBe("github:o/r"); // no @ → untouched
  });
});

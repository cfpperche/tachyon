import { describe, it, expect } from "vitest";
import { parseSource } from "../../src/plugins/source.js";

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

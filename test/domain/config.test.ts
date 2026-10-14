import { describe, expect, it } from "bun:test"

import { ConfigError, parseConfig } from "../../src/config.ts"

describe("config", () => {
  it("applies defaults and normalizes names", () => {
    const config = parseConfig({
      slack: { channel: "C0123ABCD" },
      repos: [
        { repo: "Acme/Web" },
        { repo: "acme/api", channel: "C0999ABCD", trunks: ["develop"] },
      ],
      users: { OctoCat: "U0123ABCD" },
    })
    expect(config).toEqual({
      stage: "prod",
      slack: { channel: "C0123ABCD" },
      repos: [
        { repo: "acme/web", channel: "C0123ABCD", trunks: [] },
        { repo: "acme/api", channel: "C0999ABCD", trunks: ["develop"] },
      ],
      users: { octocat: "U0123ABCD" },
      links: "graphite",
      deployEnvironment: "\\bprod(uction)?\\b",
      replies: true,
    })
  })

  it("rejects bad IDs, duplicates, and empty repo lists", () => {
    expect(() =>
      parseConfig({ slack: { channel: "general" }, repos: [{ repo: "a/b" }] }),
    ).toThrow(ConfigError)
    expect(() =>
      parseConfig({
        slack: { channel: "C0123ABCD" },
        repos: [{ repo: "a/b" }, { repo: "A/B" }],
      }),
    ).toThrow("listed twice")
    expect(() =>
      parseConfig({ slack: { channel: "C0123ABCD" }, repos: [] }),
    ).toThrow("empty")
    expect(() =>
      parseConfig({
        slack: { channel: "C0123ABCD" },
        repos: [{ repo: "a/b" }],
        users: { me: "not-an-id" },
      }),
    ).toThrow(ConfigError)
  })
})

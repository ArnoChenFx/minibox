import { describe, expect, test } from "bun:test";

import { createRedactor, REDACTED, redactEvent } from "../src/events/redact";
import type { EventInput } from "../src/events/types";

const ACCESS_KEY = "minibox-access-key-0123456789abcdef";
const redactor = createRedactor({ knownSecrets: [ACCESS_KEY] });

/** Secret samples in the shapes they take in the wild. Each must disappear, whatever surrounds it. */
const FORMAT_SAMPLES = [
  "sk-proj-abcdefghijklmnop0123456789",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "gho_abcdefghijklmnopqrstuvwxyz0123456789",
  "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
  "AKIAIOSFODNN7EXAMPLE",
  "xoxb-1234567890-abcdefghijkl",
  "AIzaSyD-abcdefghijklmnopqrstuvwxyz12345",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123_-x",
];

describe("known secrets", () => {
  test("the access key is replaced wherever it appears, in text and in nested data", () => {
    expect(redactor.text(`logged in with ${ACCESS_KEY} from home`)).toBe(`logged in with ${REDACTED} from home`);
    expect(redactor.value({ a: [{ b: `x${ACCESS_KEY}y` }] })).toEqual({ a: [{ b: `x${REDACTED}y` }] });
  });

  test("a known secret shorter than eight characters is not matched, so ordinary words survive", () => {
    const short = createRedactor({ knownSecrets: ["box"] });
    expect(short.text("box alpha")).toBe("box alpha");
  });
});

describe("credential formats", () => {
  test.each(FORMAT_SAMPLES)("%s is replaced even inside a sentence", (sample) => {
    const out = redactor.text(`used ${sample} for the push`);
    expect(out).toBe(`used ${REDACTED} for the push`);
    expect(out).not.toContain(sample);
  });

  test("a bearer token keeps its scheme and loses its value", () => {
    expect(redactor.text("Authorization: Bearer abcdefghijklmnop.qrst")).toBe("Authorization: Bearer ***");
  });

  test("the password in a URL is replaced and the host is kept", () => {
    expect(redactor.text("clone https://alice:hunter22@example.com/repo.git")).toBe(
      `clone https://${REDACTED}@example.com/repo.git`,
    );
  });

  test("a private key block is removed whole", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactor.text(`key: ${pem} done`)).toBe(`key: ${REDACTED} done`);
  });

  test("identifiers, refs and ordinary words are not mistaken for secrets", () => {
    const ordinary = [
      "01HZX5N8K3V2W4Q7R9T1Y6B0CD",
      "mbtest-snap:nightly-20260101-120000",
      "3f2c9a0b7d8e4f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192",
      "box alpha with a basic configuration",
      "https://example.com/path:8080",
    ];
    for (const text of ordinary) expect(redactor.text(text)).toBe(text);
  });
});

describe("credential fields", () => {
  test("a field named for a credential is replaced whatever its value", () => {
    expect(
      redactor.value({
        password: "hunter2",
        apiKey: "abc",
        authorization: "Basic dXNlcjpwYXNz",
        nested: { client_secret: 42, accessToken: { value: "x" } },
        name: "alpha",
      }),
    ).toEqual({
      password: REDACTED,
      apiKey: REDACTED,
      authorization: REDACTED,
      nested: { client_secret: REDACTED, accessToken: REDACTED },
      name: "alpha",
    });
  });

  test("environment variables are recorded by name only", () => {
    expect(redactor.value({ env: { PATH: "/usr/bin", DATABASE_URL: "postgres://u:p@h/db" } })).toEqual({
      env: ["PATH", "DATABASE_URL"],
    });
  });

  test("the value passed in is not modified", () => {
    const input = { password: "hunter2", note: `key ${ACCESS_KEY}` };
    redactor.value(input);
    expect(input).toEqual({ password: "hunter2", note: `key ${ACCESS_KEY}` });
  });
});

describe("redactEvent", () => {
  const event: EventInput = {
    id: "01HZX5N8K3V2W4Q7R9T1Y6B0CD",
    ts: 1,
    durationMs: 0,
    status: "ok",
    op: "box.create",
    kind: "write",
    principal: { type: "owner", id: "owner", name: `owner ${ACCESS_KEY}` },
    source: "rest",
    hostId: "local",
    summary: `Create a box named ${ACCESS_KEY}`,
    target: { kind: "box", id: "abc", name: "alpha" },
    detail: { name: "alpha", token: "t" },
    run: "run-1",
  };

  test("summary, principal name, target, detail and run are redacted; identifiers are kept", () => {
    const out = redactEvent(event, redactor);
    expect(out).toMatchObject({
      id: event.id,
      ts: 1,
      summary: `Create a box named ${REDACTED}`,
      principal: { type: "owner", id: "owner", name: `owner ${REDACTED}` },
      target: { kind: "box", id: "abc", name: "alpha" },
      detail: { name: "alpha", token: REDACTED },
      run: "run-1",
    });
    expect(JSON.stringify(out)).not.toContain(ACCESS_KEY);
  });

  test("an event without detail, target or run stays without them", () => {
    const bare = redactEvent({ ...event, detail: undefined, target: undefined, run: undefined }, redactor);
    expect(bare.detail).toBeUndefined();
    expect(bare.target).toBeUndefined();
    expect(bare.run).toBeUndefined();
  });
});

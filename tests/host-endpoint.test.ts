import { describe, expect, test } from "bun:test";

import { DEFAULT_REMOTE_SOCKET, endpointLabel, EndpointError, parseEndpoint } from "../src/host/endpoint";

describe("parseEndpoint", () => {
  test("a unix socket is a path with no host", () => {
    expect(parseEndpoint("unix:///var/run/docker.sock")).toEqual({
      kind: "unix",
      socketPath: "/var/run/docker.sock",
    });
  });

  test("tcp defaults to the TLS port and accepts a bracketed IPv6 address", () => {
    expect(parseEndpoint("tcp://engine.example")).toEqual({ kind: "tcp", hostname: "engine.example", port: 2376 });
    expect(parseEndpoint("tcp://10.0.0.5:3000")).toEqual({ kind: "tcp", hostname: "10.0.0.5", port: 3000 });
    expect(parseEndpoint("tcp://[fd00::1]:2376")).toEqual({ kind: "tcp", hostname: "fd00::1", port: 2376 });
  });

  test("ssh takes a user, defaults to port 22 and the system Docker socket", () => {
    expect(parseEndpoint("ssh://dev@lab.example")).toEqual({
      kind: "ssh",
      user: "dev",
      hostname: "lab.example",
      port: 22,
      socketPath: DEFAULT_REMOTE_SOCKET,
    });
    expect(parseEndpoint("ssh://dev@10.0.0.2:2222/run/user/1000/docker.sock")).toEqual({
      kind: "ssh",
      user: "dev",
      hostname: "10.0.0.2",
      port: 2222,
      socketPath: "/run/user/1000/docker.sock",
    });
  });

  test("surrounding white space is ignored", () => {
    expect(parseEndpoint("  tcp://engine.example:2376  ")).toEqual({
      kind: "tcp",
      hostname: "engine.example",
      port: 2376,
    });
  });

  test.each([
    ["a password in the URL", "tcp://user:secret@engine.example", "passwords are not supported"],
    ["a query string", "unix:///var/run/docker.sock?x=1", "query strings and fragments"],
    ["a fragment", "tcp://engine.example#frag", "query strings and fragments"],
    ["an ssh endpoint without a user", "ssh://lab.example", "need a user"],
    ["a user name with a space", "ssh://a%20b@lab.example", "user name has characters that are not allowed"],
    ["a unix endpoint with a host", "unix://lab.example/var/run/docker.sock", "unix endpoints take a path"],
    ["a tcp endpoint with a path", "tcp://engine.example:2376/v1", "tcp endpoints take no path"],
    ["a port of zero", "tcp://engine.example:0", "the port must be 1 to 65535"],
    ["a port above 65535", "tcp://engine.example:70000", "it is not a URL"],
    ["a host name that is not valid", "tcp://-bad-.example", "the host name is not valid"],
    ["an unknown scheme", "http://engine.example:2375", "the scheme must be unix://, tcp:// or ssh://"],
    ["text that is not a URL", "engine.example", "it is not a URL"],
  ])("refuses %s", (_name, raw, reason) => {
    const error = (() => {
      try {
        parseEndpoint(raw);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(EndpointError);
    expect((error as Error).message).toContain(reason);
  });

  test("a socket path longer than the kernel allows is refused", () => {
    expect(() => parseEndpoint(`unix:///${"a".repeat(260)}`)).toThrow("too long");
  });
});

describe("endpointLabel", () => {
  test("writes each endpoint in the form parseEndpoint reads back", () => {
    for (const raw of [
      "unix:///var/run/docker.sock",
      "tcp://engine.example:2376",
      "tcp://[fd00::1]:2376",
      "ssh://dev@lab.example:22/var/run/docker.sock",
      "ssh://dev@[fd00::2]:2200/run/docker.sock",
    ]) {
      const label = endpointLabel(parseEndpoint(raw));
      expect(parseEndpoint(label)).toEqual(parseEndpoint(raw));
    }
  });

  test("never includes a credential, even when the input had one", () => {
    expect(() => parseEndpoint("ssh://dev:pw@lab.example")).toThrow("passwords are not supported");
    expect(endpointLabel(parseEndpoint("ssh://dev@lab.example"))).toBe("ssh://dev@lab.example:22/var/run/docker.sock");
  });
});

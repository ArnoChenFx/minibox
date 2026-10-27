import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { hostsPath } from "../src/data-dir";
import { HostsFileError, HostStore, type StoredHost } from "../src/host/store";
import { removeDir, tempDir } from "./support/engines";

const CREATED_AT = "2026-10-22T00:00:00.000Z";
const lab: StoredHost = {
  id: "lab",
  name: "Lab",
  endpoint: "tcp://lab.example:2376",
  hostKeyFingerprint: null,
  createdAt: CREATED_AT,
};
const edge: StoredHost = {
  id: "edge",
  name: "Edge",
  endpoint: "ssh://dev@edge.example:22/var/run/docker.sock",
  hostKeyFingerprint: "SHA256:c2VjcmV0LWhvc3Qta2V5",
  createdAt: CREATED_AT,
};

let dir: string;
let store: HostStore;

beforeEach(() => {
  dir = tempDir("mbt-store-");
  store = new HostStore(dir);
});

afterEach(() => removeDir(dir));

const mode = (path: string) => statSync(path).mode & 0o777;

describe("hosts.json", () => {
  test("a missing or blank file holds no hosts", () => {
    expect(store.load()).toEqual([]);
    writeFileSync(hostsPath(dir), "  \n");
    expect(store.load()).toEqual([]);
  });

  test("saved hosts are read back in order, in a file only its owner can read, and hold no key material", () => {
    store.save([lab, edge]);
    expect(store.load()).toEqual([lab, edge]);
    expect(mode(hostsPath(dir))).toBe(0o600);
    expect(readFileSync(hostsPath(dir), "utf8")).not.toContain("PRIVATE KEY");
  });

  test("a hosts file that another user can read is tightened to 600 when it is loaded", () => {
    store.save([lab]);
    chmodSync(hostsPath(dir), 0o644);
    expect(store.load()).toEqual([lab]);
    expect(mode(hostsPath(dir))).toBe(0o600);
  });

  test("a file that is not JSON is an error that names the file, never an empty list", () => {
    writeFileSync(hostsPath(dir), "{not json");
    expect(() => store.load()).toThrow(HostsFileError);
    expect(() => store.load()).toThrow(`${hostsPath(dir)} is not valid JSON`);
  });

  test("a file with a field the format does not have is an error", () => {
    writeFileSync(hostsPath(dir), JSON.stringify({ version: 1, hosts: [{ ...lab, password: "hunter2" }] }));
    expect(() => store.load()).toThrow("does not match the hosts format");
  });

  test("an unknown version is an error", () => {
    writeFileSync(hostsPath(dir), JSON.stringify({ version: 2, hosts: [] }));
    expect(() => store.load()).toThrow("does not match the hosts format");
  });

  test("the reserved id local cannot be a stored host, and an id cannot repeat", () => {
    store.save([{ ...lab, id: "local" }]);
    expect(() => store.load()).toThrow("reserved id");
    store.save([lab, lab]);
    expect(() => store.load()).toThrow("more than once");
  });

  test("an endpoint that does not parse is an error", () => {
    store.save([{ ...lab, endpoint: "ftp://lab.example" }]);
    expect(() => store.load()).toThrow("has an endpoint for lab that is not valid");
  });

  test("a host's labels are read back as written, and a file written before labels existed still reads", () => {
    const labelled: StoredHost = { ...lab, labels: { gpu: "true", "org/arch": "amd64", bare: "" } };
    store.save([labelled, edge]);
    expect(store.load()).toEqual([labelled, edge]);

    // The older format has no `labels` at all, which means the host carries none rather than breaking the file.
    writeFileSync(
      hostsPath(dir),
      JSON.stringify({
        version: 1,
        hosts: [
          {
            id: "lab",
            name: "Lab",
            endpoint: "tcp://lab.example:2376",
            hostKeyFingerprint: null,
            createdAt: CREATED_AT,
          },
        ],
      }),
    );
    expect(store.load()).toEqual([lab]);
  });

  test("a label key or value that does not follow the rules is refused, so a typo cannot silently select no host", () => {
    for (const labels of [
      { "Bad Key": "x" },
      { "a/b/c": "x" },
      { 9: "x" },
      { gpu: 1 },
      { gpu: "two\nlines" },
      { gpu: "x".repeat(257) },
    ]) {
      store.save([{ ...lab, labels: labels as unknown as Record<string, string> }]);
      expect(() => store.load()).toThrow("does not match the hosts format");
    }
    store.save([{ ...lab, labels: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`l${index}`, ""])) }]);
    expect(() => store.load()).toThrow("does not match the hosts format");
  });

  test("an SSH host must carry the key it was added with, and no other kind may", () => {
    store.save([{ ...edge, hostKeyFingerprint: null }]);
    expect(() => store.load()).toThrow("does not match its endpoint");
    store.save([{ ...lab, hostKeyFingerprint: "SHA256:unexpected" }]);
    expect(() => store.load()).toThrow("does not match its endpoint");
  });
});

describe("credential files", () => {
  test("each file is written owner-only, read back without its trailing newline, and removed with the host", () => {
    store.writeCredentials("lab", { ca: "CA-PEM\n", cert: "CERT-PEM", key: "KEY-PEM" });
    const dirPath = store.credentialDir("lab");
    for (const name of ["ca.pem", "cert.pem", "key.pem"]) {
      expect(mode(join(dirPath, name))).toBe(0o600);
    }
    expect(mode(dirPath)).toBe(0o700);
    expect(store.readCredential("lab", "ca")).toBe("CA-PEM");
    expect(store.readCredential("lab", "cert")).toBe("CERT-PEM");
    expect(store.readCredential("lab", "key")).toBe("KEY-PEM");
    expect(store.readCredential("lab", "sshKey")).toBeNull();

    store.removeCredentials("lab");
    expect(existsSync(dirPath)).toBe(false);
    expect(store.readCredential("lab", "ca")).toBeNull();
  });

  test("an SSH key is stored as ssh_key, and the hosts file is untouched by writing it", () => {
    store.save([edge]);
    const before = readFileSync(hostsPath(dir), "utf8");
    store.writeCredentials("edge", {
      sshKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    });
    expect(readFileSync(join(store.credentialDir("edge"), "ssh_key"), "utf8")).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(mode(join(store.credentialDir("edge"), "ssh_key"))).toBe(0o600);
    expect(readFileSync(hostsPath(dir), "utf8")).toBe(before);
  });

  test("writing a credential again replaces it", () => {
    store.writeCredentials("lab", { key: "OLD" });
    store.writeCredentials("lab", { key: "NEW" });
    expect(store.readCredential("lab", "key")).toBe("NEW");
  });
});

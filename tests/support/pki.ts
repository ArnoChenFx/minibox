import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PemFiles {
  /** PEM bundle of the CA that signed the certificate. */
  readonly ca: string;
  /** PEM certificate. */
  readonly cert: string;
  /** PEM private key matching `cert`. */
  readonly key: string;
}

export interface TestPki {
  /** The CA that signs the engine's server certificate, and the control plane's client certificate. */
  readonly ca: string;
  /** The engine's certificate, for 127.0.0.1 and localhost. */
  readonly engine: { readonly cert: string; readonly key: string };
  /** The control plane's client certificate, signed by `ca`. */
  readonly client: PemFiles;
  /** A client certificate from a CA the engine does not trust. */
  readonly stranger: PemFiles;
  /** The CA that signed `stranger`. A control plane that trusts only this CA does not trust the engine. */
  readonly otherCa: string;
}

function openssl(dir: string, args: string[]): void {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

function readPem(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf8");
}

/** A CA, with one signed certificate for the engine and one for a client, plus a second CA's client certificate. */
function buildPki(dir: string): TestPki {
  const ca = (name: string) => {
    openssl(dir, [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.pem`,
      "-days",
      "2",
      "-subj",
      `/CN=${name}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
  };
  const sign = (name: string, signer: string, usage: "serverAuth" | "clientAuth", san: string | null) => {
    const ext = join(dir, `${name}.ext`);
    const lines = [`extendedKeyUsage=${usage}`];
    if (san !== null) lines.push(`subjectAltName=${san}`);
    writeFileSync(ext, `${lines.join("\n")}\n`);
    openssl(dir, [
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      `/CN=${name}`,
    ]);
    openssl(dir, [
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      `${signer}.pem`,
      "-CAkey",
      `${signer}.key`,
      "-set_serial",
      String(Math.floor(Math.random() * 2 ** 30) + 1),
      "-days",
      "2",
      "-extfile",
      ext,
      "-out",
      `${name}.pem`,
    ]);
  };
  ca("minibox-test-ca");
  ca("minibox-other-ca");
  sign("engine", "minibox-test-ca", "serverAuth", "IP:127.0.0.1,DNS:localhost");
  sign("client", "minibox-test-ca", "clientAuth", null);
  sign("stranger", "minibox-other-ca", "clientAuth", null);
  return {
    ca: readPem(dir, "minibox-test-ca.pem"),
    engine: { cert: readPem(dir, "engine.pem"), key: readPem(dir, "engine.key") },
    client: {
      ca: readPem(dir, "minibox-test-ca.pem"),
      cert: readPem(dir, "client.pem"),
      key: readPem(dir, "client.key"),
    },
    stranger: {
      ca: readPem(dir, "minibox-test-ca.pem"),
      cert: readPem(dir, "stranger.pem"),
      key: readPem(dir, "stranger.key"),
    },
    otherCa: readPem(dir, "minibox-other-ca.pem"),
  };
}

let cached: TestPki | null = null;

/** Certificates for the TLS tests. Generated once per test process with the openssl CLI, then reused. */
export function testPki(): TestPki {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "mbt-pki-"));
  try {
    cached = buildPki(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}

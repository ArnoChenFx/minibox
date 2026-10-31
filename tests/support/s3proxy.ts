import type Docker from "dockerode";

import type { Runtime } from "../../src/runtime";

/**
 * The S3 service the real-engine copy test runs. Both images are pinned by digest, read from Docker Hub on 2026-10-31:
 * s3proxy was last published 2026-10-30, and the CLI is the one the credentials probe used. A digest keeps CI on the
 * same bytes as the run that proved the copy, while `latest` would move under it.
 */
export const S3PROXY_IMAGE =
  "andrewgaul/s3proxy@sha256:87662b2a5afcdfa5f478a1c61650bae4c87bbd15f6ff2823236bcfd66ef7fe04";
export const AWS_CLI_IMAGE = "amazon/aws-cli@sha256:d557b3524475d70dd3104cf44d96568ee3188897b73a6ece2b37aa50e1af362f";

export interface S3ServiceOptions {
  readonly docker: Docker;
  readonly runtime: Runtime;
  /** The bridge gateway, which is this machine as a container sees it. The service is published there. */
  readonly gateway: string;
  /** Labels every container this makes, so a failed run is swept by the Docker integration script. */
  readonly prefix: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

export interface S3Proxy {
  /** The address restic and the test's S3 client use: the gateway and the published port. */
  readonly endpoint: string;
  /** The Prometheus metrics the service exposes at its own published port, including the requests it served. */
  metrics(): Promise<string>;
  stop(): Promise<void>;
}

/**
 * Starts s3proxy on the bridge, with its S3 port published on the gateway, and waits until it answers. The container
 * configuration is the credentials probe's: AWS V2 or V4 signatures with the test credentials, over an in-memory
 * transient store. Metrics are on, so a copy's PUT requests can be read back from its own port. Nothing is left behind
 * on a failure.
 */
export async function startS3Proxy(options: S3ServiceOptions): Promise<S3Proxy> {
  await options.runtime.pullImage(S3PROXY_IMAGE);
  const created = await options.docker.createContainer({
    name: `${options.prefix}-s3proxy`,
    Image: S3PROXY_IMAGE,
    Env: [
      "S3PROXY_AUTHORIZATION=aws-v2-or-v4",
      "S3PROXY_ENDPOINT=http://0.0.0.0:80",
      `S3PROXY_IDENTITY=${options.accessKeyId}`,
      `S3PROXY_CREDENTIAL=${options.secretAccessKey}`,
      "JCLOUDS_PROVIDER=transient",
      "JCLOUDS_IDENTITY=local-identity",
      "JCLOUDS_CREDENTIAL=local-credential",
      "S3PROXY_METRICS_ENABLED=true",
      "S3PROXY_METRICS_HOST=0.0.0.0",
      "S3PROXY_METRICS_PORT=9090",
    ],
    Labels: { [options.prefix]: "s3proxy" },
    ExposedPorts: { "80/tcp": {}, "9090/tcp": {} },
    HostConfig: {
      NetworkMode: "bridge",
      PortBindings: {
        "80/tcp": [{ HostIp: options.gateway, HostPort: "0" }],
        "9090/tcp": [{ HostIp: options.gateway, HostPort: "0" }],
      },
    },
  });
  const container = options.docker.getContainer(created.id);
  try {
    await container.start();
    const port = await publishedPort(container, "80/tcp");
    const metricsPort = await publishedPort(container, "9090/tcp");
    const endpoint = `http://${options.gateway}:${port}`;
    const metricsUrl = `http://${options.gateway}:${metricsPort}/metrics`;
    await untilReady(`${endpoint}/healthz`, "the S3 service");
    return {
      endpoint,
      metrics: async () => (await fetch(metricsUrl)).text(),
      stop: async () => {
        await container.remove({ force: true }).catch(() => undefined);
      },
    };
  } catch (e) {
    await container.remove({ force: true }).catch(() => undefined);
    throw e;
  }
}

/**
 * Creates the bucket with the probe's one-shot `amazon/aws-cli` container: the image is already the one the credentials
 * probe ran, and its `s3 mb` speaks the signatures s3proxy checks. Bun's S3 client has no bucket create, so the test
 * process cannot do it with the dependencies it has. The container runs on the bridge and reaches the service at the
 * gateway. It is removed whether the call worked or not.
 */
export async function createS3Bucket(options: S3ServiceOptions & { endpoint: string }): Promise<void> {
  await options.runtime.pullImage(AWS_CLI_IMAGE);
  const created = await options.docker.createContainer({
    name: `${options.prefix}-aws-cli`,
    Image: AWS_CLI_IMAGE,
    Cmd: ["--endpoint-url", options.endpoint, "s3", "mb", `s3://${options.bucket}`],
    Env: [
      `AWS_ACCESS_KEY_ID=${options.accessKeyId}`,
      `AWS_SECRET_ACCESS_KEY=${options.secretAccessKey}`,
      "AWS_DEFAULT_REGION=us-east-1",
    ],
    Labels: { [options.prefix]: "aws-cli" },
    HostConfig: { NetworkMode: "bridge" },
  });
  const container = options.docker.getContainer(created.id);
  try {
    await container.start();
    const status = await container.wait();
    if (status.StatusCode !== 0) {
      const logs = await container.logs({ stdout: true, stderr: true }).catch(() => Buffer.alloc(0));
      throw new Error(`aws s3 mb exited with ${status.StatusCode}: ${logs.toString("utf8")}`);
    }
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

/** The host port Docker published for a container port. It appears once the container starts. */
async function publishedPort(container: Docker.Container, key: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const info = await container.inspect();
    const port = info.NetworkSettings.Ports?.[key]?.[0]?.HostPort;
    if (port) return port;
    if (Date.now() > deadline) throw new Error(`timed out waiting for the host port of ${key}`);
    await Bun.sleep(100);
  }
}

async function untilReady(url: string, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The service has not started listening yet.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

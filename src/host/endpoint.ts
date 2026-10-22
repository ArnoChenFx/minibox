/**
 * A host's connection, parsed. An endpoint never carries a credential: keys and certificates are files under
 * DATA_DIR, so the endpoint text is safe to show and to store in hosts.json.
 */
export type Endpoint =
  | { readonly kind: "unix"; readonly socketPath: string }
  | { readonly kind: "tcp"; readonly hostname: string; readonly port: number }
  | {
      readonly kind: "ssh";
      readonly user: string;
      readonly hostname: string;
      readonly port: number;
      readonly socketPath: string;
    };

export const DEFAULT_TLS_PORT = 2376;
export const DEFAULT_SSH_PORT = 22;
/** The Docker socket of a system-wide daemon, as the SSH host's own filesystem sees it. */
export const DEFAULT_REMOTE_SOCKET = "/var/run/docker.sock";

const USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/;
const IPV6_RE = /^[0-9A-Fa-f:.]+$/;
const MAX_SOCKET_PATH = 255;

/** The reason an endpoint string is refused. The message is shown to the caller as is. */
export class EndpointError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EndpointError";
  }
}

export function parseEndpoint(raw: string): Endpoint {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EndpointError("it is not a URL such as tcp://host:2376 or ssh://user@host");
  }
  if (url.search !== "" || url.hash !== "") throw new EndpointError("query strings and fragments are not supported");
  if (url.password !== "") throw new EndpointError("passwords are not supported; SSH hosts use a key");
  switch (url.protocol) {
    case "unix:":
      return unixEndpoint(url);
    case "tcp:":
      return tcpEndpoint(url);
    case "ssh:":
      return sshEndpoint(url);
    default:
      throw new EndpointError("the scheme must be unix://, tcp:// or ssh://");
  }
}

/** The endpoint as text without any credential, in the form `parseEndpoint` accepts back. */
export function endpointLabel(endpoint: Endpoint): string {
  switch (endpoint.kind) {
    case "unix":
      return `unix://${endpoint.socketPath}`;
    case "tcp":
      return `tcp://${bracketed(endpoint.hostname)}:${endpoint.port}`;
    case "ssh":
      return `ssh://${endpoint.user}@${bracketed(endpoint.hostname)}:${endpoint.port}${endpoint.socketPath}`;
  }
}

function unixEndpoint(url: URL): Endpoint {
  if (url.host !== "") throw new EndpointError("unix endpoints take a path, such as unix:///var/run/docker.sock");
  return { kind: "unix", socketPath: absolutePath(decodePath(url.pathname)) };
}

function tcpEndpoint(url: URL): Endpoint {
  if (url.pathname !== "" && url.pathname !== "/") throw new EndpointError("tcp endpoints take no path");
  const hostname = hostnameOf(url.hostname);
  const port = url.port === "" ? DEFAULT_TLS_PORT : portOf(url.port);
  return { kind: "tcp", hostname, port };
}

function sshEndpoint(url: URL): Endpoint {
  if (url.username === "") throw new EndpointError("ssh endpoints need a user, such as ssh://user@host");
  if (!USER_RE.test(url.username)) throw new EndpointError("the SSH user name has characters that are not allowed");
  const socketPath = url.pathname === "" || url.pathname === "/" ? DEFAULT_REMOTE_SOCKET : decodePath(url.pathname);
  return {
    kind: "ssh",
    user: url.username,
    hostname: hostnameOf(url.hostname),
    port: url.port === "" ? DEFAULT_SSH_PORT : portOf(url.port),
    socketPath: absolutePath(socketPath),
  };
}

function hostnameOf(raw: string): string {
  const bare = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (bare === "") throw new EndpointError("the host name is missing");
  if (bare.includes(":")) {
    if (!IPV6_RE.test(bare)) throw new EndpointError("the IPv6 address is not valid");
    return bare;
  }
  if (!HOSTNAME_RE.test(bare)) throw new EndpointError("the host name is not valid");
  return bare;
}

function portOf(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EndpointError("the port must be 1 to 65535");
  return port;
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw new EndpointError("the socket path is not valid");
  }
}

function absolutePath(path: string): string {
  if (!path.startsWith("/")) throw new EndpointError("the socket path must be absolute");
  if (path.length > MAX_SOCKET_PATH) throw new EndpointError("the socket path is too long");
  if (path.split("/").includes("..")) throw new EndpointError("the socket path must not contain ..");
  return path;
}

function bracketed(hostname: string): string {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

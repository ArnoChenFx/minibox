import { isIP } from "node:net";

/**
 * Subdomain previews. Each preview has its own origin, `<port>-<label>.<base>`, where `<base>` is PREVIEW_BASE_DOMAIN and
 * `<label>` names the box. The label is a DNS label, so a preview host is a valid hostname.
 */

/** 57 characters: the port and its dash take the rest of a 63-character DNS label. */
const BOX_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,55}[a-z0-9])?$/;
const BASE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PREVIEW_HEAD = /^([1-9]\d{0,4})-([a-z0-9](?:[a-z0-9-]{0,55}[a-z0-9])?)$/;
const MAX_BASE_LENGTH = 180;

/**
 * `PREVIEW_BASE_DOMAIN`. Blank means path mode. The value must be a domain of at least two labels, such as
 * `minibox-preview.net`: an address or a single label would make previews indistinguishable from the console.
 */
export function parsePreviewBaseDomain(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const base = raw.toLowerCase();
  const labels = base.split(".");
  const valid =
    base.length <= MAX_BASE_LENGTH &&
    labels.length >= 2 &&
    labels.every((label) => BASE_LABEL.test(label)) &&
    /[a-z]/.test(labels.at(-1) ?? "") &&
    isIP(base) === 0;
  if (!valid) {
    throw new Error(
      `PREVIEW_BASE_DOMAIN: "${raw}" must be a domain name such as minibox-preview.net, without a scheme, port or path`,
    );
  }
  return base;
}

/** The label that names a box in its preview hosts: its name when that is a DNS label, otherwise its stable id. */
export function boxLabel(name: string, boxId: string): string {
  return BOX_LABEL.test(name) ? name : boxId.replace("_", "-");
}

export function previewHostname(port: number, label: string, base: string): string {
  return `${port}-${label}.${base}`;
}

/** The hostname lies under the base domain, though it is not the base domain itself. */
export function inPreviewNamespace(hostname: string, base: string): boolean {
  return hostname.endsWith(`.${base}`);
}

export interface PreviewHost {
  readonly port: number;
  readonly label: string;
}

/** The port and box label of a `<port>-<label>.<base>` hostname, or null for any other shape. */
export function parsePreviewHost(hostname: string, base: string): PreviewHost | null {
  if (!inPreviewNamespace(hostname, base)) return null;
  const head = hostname.slice(0, -(base.length + 1));
  const match = PREVIEW_HEAD.exec(head);
  if (!match) return null;
  const port = Number(match[1]);
  const label = match[2] ?? "";
  if (port > 65535) return null;
  return { port, label };
}

/** Where the console sends a preview request that needs a sign-in first. Only a browser session may call it. */
export function previewLaunchPath(boxId: string, port: number): string {
  return `/api/boxes/${boxId}/ports/${port}/preview`;
}

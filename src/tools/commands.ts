import { TOOLS_PREFIX, type CatalogEntry, type ToolAction } from "./types";

/** Values substituted into catalog command templates. */
export interface CommandContext {
  version: string;
  prefix?: string;
}

/**
 * Builds the package argument for npm (`pkg` / `pkg@1.2.3` / `pkg@latest`) and pip
 * (`pkg` / `pkg==1.2.3`). A requested version of `latest` means the registry's latest.
 */
export function packageSpec(entry: CatalogEntry, version: string): string {
  const pin = version.trim() || "latest";
  if (entry.source === "npm") {
    return pin === "latest" ? `${entry.package}@latest` : `${entry.package}@${pin}`;
  }
  if (entry.source === "pip") {
    return pin === "latest" ? entry.package : `${entry.package}==${pin}`;
  }
  return entry.package;
}

/** Fills `{{prefix}}`, `{{version}}`, `{{package}}`, `{{package_spec}}` and `{{bin}}` in a template. */
export function renderCommand(template: string, entry: CatalogEntry, ctx: CommandContext): string {
  const prefix = ctx.prefix ?? TOOLS_PREFIX;
  const version = ctx.version.trim() || "latest";
  const spec = packageSpec(entry, version);
  return template
    .replaceAll("{{prefix}}", prefix)
    .replaceAll("{{package_spec}}", spec)
    .replaceAll("{{package}}", entry.package)
    .replaceAll("{{version}}", version)
    .replaceAll("{{bin}}", entry.bin);
}

export function commandFor(entry: CatalogEntry, action: ToolAction, version: string): string {
  const template = action === "install" ? entry.install : action === "upgrade" ? entry.upgrade : entry.uninstall;
  return renderCommand(template, entry, { version });
}

export function detectCommand(entry: CatalogEntry): string {
  return renderCommand(entry.detect, entry, { version: "latest" });
}

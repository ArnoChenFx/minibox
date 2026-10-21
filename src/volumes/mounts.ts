/** Absolute mount path: no spaces, no empty or `..` segments. `/` itself is not a useful mount point. */
export function validMountPath(path: string): boolean {
  if (!path.startsWith("/") || path.length < 2 || path.length > 200) return false;
  if (path.includes("//") || /[\s\0]/.test(path)) return false;
  return path.split("/").every((part, index) => index === 0 || (part !== "." && part !== ".."));
}

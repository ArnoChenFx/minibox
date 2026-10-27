/** Mount-list helpers for the create and rebuild dialogs. No DOM and no imports, so the tests load them directly. */

/** Most mounts one box takes. Mirrors `MOUNT_MAX` in src/operations/validation.ts. */
export const MOUNT_MAX = 16;

/** The mounts a box gets when a create names none. Mirrors `ROLE_MOUNT` in src/volumes/types.ts. */
export const DEFAULT_MOUNTS = [
  { role: "workspace", path: "/workspace", mode: "rw" },
  { role: "home", path: "/home/dev", mode: "rw" },
  { role: "tools", path: "/opt/minibox/tools", mode: "ro" },
  { role: "cache", path: "/home/dev/.cache", mode: "rw" },
];

/**
 * The value a create row holds for a role whose volume MiniBox creates for this box. The server reads the same entry as
 * `{ role }`, and takes the role's own path and mode, which the row shows and does not let you change.
 */
export const ROLE_PREFIX = "role:";

/** The role a row would create, or null when the row mounts a volume that already exists. */
export function roleOfValue(value) {
  if (typeof value !== "string" || !value.startsWith(ROLE_PREFIX)) return null;
  const role = value.slice(ROLE_PREFIX.length);
  return DEFAULT_MOUNTS.some((mount) => mount.role === role) ? role : null;
}

/** The value a row holds to create `role`. */
export function roleValue(role) {
  return `${ROLE_PREFIX}${role}`;
}

/** The role mount `role` describes, as the default list holds it. Null for a name that is not a role. */
export function roleMount(role) {
  return DEFAULT_MOUNTS.find((mount) => mount.role === role) ?? null;
}

/**
 * The choices a create row offers: one per role, which MiniBox creates for the box, then the volumes that exist. The
 * tools role mounts the host's shared tools volume when there is one, so its label says so, and its own volume when
 * there is none. `sharedTools` is a boolean for the whole dialog, or a Map of role to whether that role's volume already
 * exists: the shared tools volume is one per pool, so the answer follows the pool the tools role goes to.
 *
 * `preview` is what `roleVolumeNames` predicted for the box being created. Without it the roles carry no name, and the
 * dialog falls back to naming the role.
 */
export function createMountChoices(volumes, sharedTools, preview = null) {
  // A shared tools volume is one per pool, so a create can mount one for each pool it puts a tools volume on.
  const shared = sharedTools instanceof Map ? sharedTools : new Map([["tools", Boolean(sharedTools)]]);
  const roles = DEFAULT_MOUNTS.map((mount) => {
    const usesShared = mount.role === "tools" && Boolean(shared.get(mount.role) ?? shared.get("tools"));
    return {
      value: roleValue(mount.role),
      role: mount.role,
      shared: usesShared,
      noShared: mount.role === "tools" && !usesShared,
      preview: preview?.[mount.role] ?? null,
    };
  });
  return [
    ...roles,
    ...volumes.map((volume) => ({
      value: volume.id,
      role: null,
      shared: false,
      noShared: false,
      preview: null,
      volume,
    })),
  ];
}

/**
 * The names MiniBox would give this box's role volumes, as the create dialog shows them before anything exists. Mirrors
 * `defaultRolePlans` in src/volumes/engine.ts: a role volume is `<box>-<role>`, and the tools role is the host's one
 * shared volume of its pool, `<prefix>-tools-<host>`. Nothing is created here, and nothing is written.
 *
 * `taken` is the display names the host already uses. A name among them is marked `exact: false`, because the server
 * makes a free name with `freeName` (`-<pool>`, then `-2`, `-3`…), and display names are unique per host rather than per
 * pool: a name another pool uses is still taken, so the suffix applies and the dialog cannot know which one. `hostKnown`
 * is false for automatic placement, which picks the host inside the create, so the shared tools volume cannot be named.
 */
export function roleVolumeNames({ boxName, hostId, labelPrefix, sharedTools, taken = [], hostKnown = true }) {
  const names = {};
  const box = typeof boxName === "string" ? boxName.trim() : "";
  const takenSet = new Set(taken);
  for (const mount of DEFAULT_MOUNTS) {
    if (mount.role === "tools") {
      if (sharedTools) {
        names.tools = { name: sharedTools.name, exists: true, exact: true, hostKnown };
        continue;
      }
      if (!hostKnown) {
        names.tools = { name: null, exists: false, exact: false, hostKnown: false };
        continue;
      }
      const name = `${labelPrefix}-tools-${hostId}`;
      names.tools = { name, exists: false, exact: !takenSet.has(name), hostKnown: true };
      continue;
    }
    // Without a box name the server has nothing to name the volume after, and the dialog says so instead of guessing.
    const name = box ? `${box}-${mount.role}` : null;
    names[mount.role] = { name, exists: false, exact: name !== null && !takenSet.has(name), hostKnown };
  }
  return names;
}

/**
 * The names a create would give the role volumes its rows still name, in row order. A row that mounts a volume that
 * exists, or that was removed, contributes nothing: MiniBox creates no volume for it.
 */
export function previewRoleNames(rows, names) {
  const out = [];
  for (const row of rows) {
    const role = roleOfValue(row.volume);
    if (!role) continue;
    out.push({ role, ...(names?.[role] ?? { name: null, exists: false, exact: false, hostKnown: true }) });
  }
  return out;
}

/**
 * The lines the Volumes section says under its rows: what the create would make, one line per role a row still names.
 * Each line is an i18n key, its parameters, and the role it is about, so the dialog can name the pool the row picked. A
 * volume that is already there (the shared tools volume) says so, and a name the host already uses says the server may
 * add a suffix, so the dialog never promises a name it cannot know.
 */
export function previewNoteLines(rows, names) {
  return previewRoleNames(rows, names).map(({ role, name, exists, exact, hostKnown }) => {
    if (exists) return { key: "cb.previewShared", params: { name }, role };
    if (name === null && !hostKnown) return { key: "cb.previewHostUnknown", params: { role }, role };
    if (name === null) return { key: "cb.previewUnnamed", params: { role }, role };
    return { key: exact ? "cb.previewCreate" : "cb.previewCreateInexact", params: { name }, role };
  });
}

/** Mirrors `validMountPath` in src/volumes/mounts.ts, the rule the server applies to every mount path. */
export function validMountPath(path) {
  if (!path.startsWith("/") || path.length < 2 || path.length > 200) return false;
  if (path.includes("//") || /[\s\0]/.test(path)) return false;
  return path.split("/").every((part, index) => index === 0 || (part !== "." && part !== ".."));
}

/** Order-independent JSON of a mount list. A rebuild sends its mounts only when they differ from the box's. */
export function canonicalMounts(mounts) {
  return JSON.stringify(
    [...(mounts ?? [])]
      .map((mount) => ({ volume: mount.volume, path: mount.path, mode: mount.mode }))
      .toSorted((a, b) => `${a.path}\0${a.volume}`.localeCompare(`${b.path}\0${b.volume}`)),
  );
}

/** Whether a server error key concerns volumes or mounts. The create dialog shows those in its Volumes section. */
export function isVolumeErrorKey(key) {
  return typeof key === "string" && (key.startsWith("mount_") || key.startsWith("volume_"));
}

/**
 * The volumes a mount row offers. A volume another box owns is listed but disabled, because the server refuses to mount
 * it while that box exists (`ownedByAnotherBox` in src/volumes/engine.ts).
 */
export function volumeChoices(volumes, liveBoxIds) {
  return volumes.map((volume) => ({
    id: volume.id,
    name: volume.name,
    hostId: volume.hostId ?? null,
    pool: volume.pool ?? null,
    role: volume.role ?? null,
    ownership: volume.ownership,
    rwMounts: volume.rwMounts,
    disabled: volume.ownership === "owned" && volume.ownerBoxId !== null && liveBoxIds.has(volume.ownerBoxId),
  }));
}

/** The names the volumes of one host already use. A create on that host has to avoid them. */
export function namesOnHost(choices, hostId) {
  return choices.filter((choice) => choice.hostId === hostId).map((choice) => choice.name);
}

/**
 * The pool each role volume goes to when the create names none, as the server's rule has it: cache on the local pool,
 * every other role on the default pool. Mirrors `poolForRole` in src/volumes/pools.ts. `local` is always a pool, even
 * when the server did not list it, because the local pool is the built-in one.
 */
export function rulePoolOf(role, { pools = [], roles = {} } = {}) {
  const named = roles?.[role];
  const chosen = named ? pools.find((pool) => pool.name === named) : undefined;
  if (chosen) return chosen.name;
  if (role === "cache") {
    const local = pools.find((pool) => pool.name === "local") ?? pools.find((pool) => pool.backend === "local");
    if (local) return local.name;
  }
  return pools.find((pool) => pool.default)?.name ?? pools[0]?.name ?? "local";
}

/**
 * The pool each of the four roles goes to, once the dialog's picks are applied. `picks` is what the operator chose per
 * role; a role left out of it follows the rule, and so does a role whose pick names no pool the host has. The dialog
 * offers only the pools it read, so a pick it cannot use is one that disappeared while the dialog was open.
 */
export function rolePoolPicks(roles, { picks = {}, pools = [], roleRules = {} } = {}) {
  const resolved = {};
  for (const role of roles) {
    const picked = picks?.[role];
    const usable = picked && pools.some((pool) => pool.name === picked);
    resolved[role] = usable ? picked : rulePoolOf(role, { pools, roles: roleRules });
  }
  return resolved;
}

/**
 * The host's shared tools volume, the one its boxes mount. Mirrors `isSharedTools` in src/volumes/engine.ts: a tools
 * volume that is independent, so an owned tools volume of another box is not the host's shared one and the create makes
 * a new one. There is one per pool, so `pool` narrows the answer to that pool's shared volume. Null when the host has
 * none yet, when it has none on that pool, or when the host is not known.
 */
export function sharedToolsOnHost(choices, hostId, pool = null) {
  return (
    choices.find(
      (choice) =>
        choice.role === "tools" &&
        choice.hostId === hostId &&
        choice.ownership === "independent" &&
        (pool === null || choice.pool === pool),
    ) ?? null
  );
}

/**
 * The shared tools volume of the host, if it has one. The tools role mounts it instead of creating a second one, so the
 * dialog says which volume that is and whether it already exists.
 */
export function sharedToolsChoice(choices) {
  return choices.find((choice) => choice.role === "tools" && !choice.disabled) ?? null;
}

/**
 * Checks the rows of a custom mount list before it is sent. Returns the mounts, or the first row the server would
 * refuse: a row with no volume and no role, a role listed twice, or a path that is invalid or repeated. Those use the
 * server's own message keys. A row that creates a role is sent as `{ role }`, because the server takes that role's own
 * path and mode, with the pool the row picked when it picked one.
 */
export function checkMountRows(rows) {
  const paths = new Set();
  const roles = new Set();
  const mounts = [];
  for (const row of rows) {
    const role = roleOfValue(row.volume);
    if (role) {
      if (roles.has(role)) return { problem: { code: "mount_create_role_duplicate", role } };
      roles.add(role);
      const fixed = roleMount(role);
      if (!fixed) return { problem: { code: "volume" } };
      if (row.path !== fixed.path) {
        return { problem: { code: "mount_create_role_path", role, path: row.path, expected: fixed.path } };
      }
      if (paths.has(fixed.path)) return { problem: { code: "mount_duplicate", path: fixed.path } };
      paths.add(fixed.path);
      mounts.push(row.pool ? { role, pool: row.pool } : { role });
      continue;
    }
    if (!row.volume) return { problem: { code: "volume" } };
    if (!validMountPath(row.path)) return { problem: { code: "mount_path_invalid", path: row.path } };
    if (paths.has(row.path)) return { problem: { code: "mount_duplicate", path: row.path } };
    paths.add(row.path);
    mounts.push({ volume: row.volume, path: row.path, mode: row.mode });
  }
  return { mounts };
}

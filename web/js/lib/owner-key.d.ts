export interface OwnerKeySystem {
  mcpOwnerKey?: { outcome: "accepted" | "refused"; lastUsedAt: string } | null;
}

export function ownerKeyNotice(system: OwnerKeySystem | null | undefined): "accepted" | "refused" | null;

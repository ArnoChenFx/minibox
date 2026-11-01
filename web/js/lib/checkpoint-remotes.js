import { api, enc } from "./api.js";
import { hostsNow } from "./hosts.js";

/**
 * The hosts whose checkpoints are kept only on their remote repository. A read that fails leaves its host out: the
 * badges then fall back to what the records say, which is what the page showed before modes existed.
 */
export async function onlyHostsNow() {
  const hosts = hostsNow();
  const remotes = await Promise.all(
    hosts.map((host) =>
      api(`/api/hosts/${enc(host.id)}/checkpoint-remote`).then(
        (reply) => reply.remote ?? null,
        () => null,
      ),
    ),
  );
  return new Set(hosts.filter((_host, index) => remotes[index]?.mode === "only").map((host) => host.id));
}

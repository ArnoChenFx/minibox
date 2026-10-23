import type { Readable } from "node:stream";

import { abortError } from "../lib/abort";
import { RuntimeError, isRuntimeError, type Runtime } from "../runtime";
import { call, labelFilter, type Engine } from "./engine";

/** The registry's answer for a reference it does not serve, or will not serve without a login, is `not_found`. */
const PULL_NOT_FOUND = /not found|manifest unknown|pull access denied|repository does not exist/i;

function pullFailure(message: string): RuntimeError {
  return new RuntimeError(PULL_NOT_FOUND.test(message) ? "not_found" : "engine", message);
}

type ImageMethods = Pick<
  Runtime,
  "listImages" | "inspectImage" | "pullImage" | "removeImage" | "saveImage" | "loadImage" | "buildImage"
>;

export function imageMethods(engine: Engine): ImageMethods {
  const { docker } = engine;

  return {
    async listImages({ labels }) {
      const images = await call(() => docker.listImages({ filters: { label: labelFilter(labels) } }));
      return images.map((img) => ({
        id: img.Id,
        repoTags: img.RepoTags ?? [],
        labels: img.Labels ?? {},
        createdAt: new Date(img.Created * 1000).toISOString(),
        size: img.Size,
      }));
    },

    async inspectImage(ref) {
      const info = await call(() => docker.getImage(ref).inspect());
      return {
        id: info.Id,
        tags: (info.RepoTags ?? []).filter((tag) => tag !== "<none>:<none>"),
        labels: info.Config?.Labels ?? {},
        env: info.Config?.Env ?? [],
      };
    },

    async pullImage(ref, opts) {
      try {
        await call(() => docker.getImage(ref).inspect());
        return;
      } catch (e) {
        if (!isRuntimeError(e, "not_found")) throw e;
      }
      await call(async () => {
        const stream = await docker.pull(ref);
        await new Promise<void>((resolve, reject) => {
          const statuses = new Map<string, string>();
          docker.modem.followProgress(
            stream,
            (err: Error | null) => (err ? reject(pullFailure(err.message)) : resolve()),
            (ev: { id?: string; status?: string; error?: string }) => {
              if (ev.error) reject(pullFailure(ev.error));
              if (!ev.status || !opts?.onLog) return;
              const layer = ev.id ?? "";
              if (statuses.get(layer) === ev.status) return;
              statuses.set(layer, ev.status);
              opts.onLog(layer ? `${layer}: ${ev.status}\n` : `${ev.status}\n`);
            },
          );
        });
      });
    },

    async removeImage(ref, { force }) {
      await call(() => docker.getImage(ref).remove({ force }));
    },

    async saveImage(ref) {
      return call(async () => (await docker.getImage(ref).get()) as Readable);
    },

    async loadImage(archive) {
      await call(async () => {
        const stream = await docker.loadImage(archive);
        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(
            stream,
            (err: Error | null) => (err ? reject(new RuntimeError("engine", err.message)) : resolve()),
            (ev: { error?: string }) => {
              if (ev.error) reject(new RuntimeError("engine", ev.error));
            },
          );
        });
      });
    },

    async buildImage(spec) {
      if (spec.signal?.aborted) throw abortError();
      return call(async () => {
        const stream = await docker.buildImage(
          { context: spec.contextDir, src: spec.src ?? [spec.dockerfile] },
          { t: spec.tag, labels: spec.labels, dockerfile: spec.dockerfile, buildargs: spec.args },
        );
        return await new Promise<string>((resolve, reject) => {
          let out = "";
          let settled = false;
          const finish = (error: unknown) => {
            if (settled) return;
            settled = true;
            spec.signal?.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve(out);
          };
          const onAbort = () => {
            const closable = stream as { destroy?: () => void; cancel?: () => void };
            // The engine keeps building until this connection closes, so the build has not ended before then.
            stream.once("close", () => finish(abortError()));
            closable.destroy?.();
            closable.cancel?.();
          };
          if (spec.signal) spec.signal.addEventListener("abort", onAbort, { once: true });
          docker.modem.followProgress(
            stream,
            (err: Error | null) => finish(spec.signal?.aborted ? abortError() : err),
            (ev: { stream?: string; error?: string }) => {
              if (ev.stream) {
                out += ev.stream;
                spec.onLog?.(ev.stream);
              }
              if (ev.error) finish(spec.signal?.aborted ? abortError() : new Error(ev.error));
            },
          );
        });
      });
    },
  };
}

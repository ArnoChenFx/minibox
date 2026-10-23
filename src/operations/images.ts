import { z } from "zod";

import { assertImageAvailable, pullImageInto } from "../services/images";
import { defineOperation } from "./define";
import { hostNamed, refuseAgent } from "./routing";
import { ImagePulledSchema } from "./schemas";
import { hostId, pullRef } from "./validation";

export const imagePull = defineOperation({
  name: "image.pull",
  tag: "templates",
  summary: "Pull an image from its registry",
  kind: "write",
  scope: "template:build",
  async: true,
  conflicts: true,
  input: z.object({ ref: pullRef(), host: hostId().optional() }),
  output: z.object({ image: ImagePulledSchema }),
  rest: [{ method: "POST", path: "/api/images/pull", body: true, status: 202 }],
  cli: "image pull",
  mcp: {
    toolset: "tools",
    name: "pull_image",
    description:
      "Pull an image from its registry onto this engine, so a box or a template can start from it. An image that is already present is left alone. MiniBox's own template, snapshot and checkpoint images are never pulled. Owner only. Returns a task id; the task log shows each layer.",
  },
  hostFor: (ctx, input) => hostNamed(ctx, input.host),
  precondition: async ({ host }) => refuseAgent(host, "templates"),
  beforeTask: async ({ host }, input) => assertImageAvailable(host, input.ref),
  exclusive: ({ host }, input) => `image.pull:${host.host.id}:${input.ref}`,
  subject: (input) => input.ref,
  activity: { action: () => "image.pull", target: (input) => input.ref },
  audit: { target: (input) => ({ kind: "image", name: input.ref }) },
  run: async ({ host, task }, input) => {
    const id = await pullImageInto(host, input.ref, { log: (text) => task?.log(text), field: "ref" });
    return { image: { ref: input.ref, id } };
  },
});

export const imageOperations = [imagePull];

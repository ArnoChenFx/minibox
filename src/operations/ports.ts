import { z } from "zod";

import { getBox } from "../services/boxes";
import { exposeBoxPort, listBoxPorts, unexposeBoxPort } from "../services/ports";
import { boxTarget } from "./boxes";
import { defineOperation } from "./define";
import { hostOfBox } from "./routing";
import { boxId } from "./validation";

const PortSchema = z.object({
  port: z.number().int(),
  source: z.enum(["listening", "manual"]),
  url: z.string(),
});

const portNumber = () =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .meta({ description: "TCP port inside the box (1–65535). Not published on the host." });

export const portList = defineOperation({
  name: "port.list",
  tag: "ports",
  summary: "List listening and manually exposed ports on a box",
  kind: "read",
  scope: "box:read",
  async: false,
  input: z.object({ id: boxId() }),
  output: z.object({ ports: z.array(PortSchema) }),
  rest: [{ method: "GET", path: "/api/boxes/:id/ports" }],
  cli: "port list",
  mcp: {
    toolset: "network",
    name: "list_ports",
    description:
      "List TCP ports listening inside a running box (from /proc/net/tcp) plus ports you exposed manually for preview. Each entry's url opens the port in a browser signed in to MiniBox: a path under /box/<name>/<port>/ in path mode, or a sign-in link that redirects to the port's own preview host when PREVIEW_BASE_DOMAIN is set.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  run: async (ctx, input) => {
    const { ports } = await listBoxPorts(ctx.host, input.id, ctx.previewBaseDomain ?? null);
    return { ports };
  },
});

export const portExpose = defineOperation({
  name: "port.expose",
  tag: "ports",
  summary: "Remember a port for preview",
  kind: "write",
  scope: "port:expose",
  async: false,
  input: z.object({ id: boxId(), port: portNumber() }),
  output: z.object({ port: PortSchema }),
  rest: [{ method: "POST", path: "/api/boxes/:id/ports", body: true }],
  cli: "port expose",
  mcp: {
    toolset: "network",
    name: "expose_port",
    description:
      "Add a TCP port to the box's manual preview list. Does not publish a host port. Open the returned url in a browser signed in to MiniBox. Automatic discovery still lists listening ports without this call.",
  },
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "port.expose", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box), detail: (input) => ({ port: input.port }) },
  run: async (ctx, input) => {
    const { port } = await exposeBoxPort(ctx.host, input.id, input.port, ctx.previewBaseDomain ?? null);
    return { port };
  },
});

export const portUnexpose = defineOperation({
  name: "port.unexpose",
  tag: "ports",
  summary: "Remove a manually exposed preview port",
  kind: "destructive",
  scope: "port:expose",
  async: false,
  input: z.object({ id: boxId(), port: portNumber() }),
  output: z.object({ port: z.number().int() }),
  rest: [{ method: "DELETE", path: "/api/boxes/:id/ports/:port" }],
  cli: "port unexpose",
  hostFor: (ctx, input) => hostOfBox(ctx, input.id),
  resolve: ({ host }, input) => getBox(host, input.id),
  activity: { action: () => "port.unexpose", target: (_input, box) => box.name },
  audit: { target: (_input, box) => box && boxTarget(box), detail: (input) => ({ port: input.port }) },
  run: async ({ host }, input) => {
    const { port } = await unexposeBoxPort(host, input.id, input.port);
    return { port };
  },
});

export const portOperations = [portList, portExpose, portUnexpose];

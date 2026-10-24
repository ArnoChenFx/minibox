import { OPERATIONS } from "../operations/registry";
import { agentRoutes } from "./agent";
import { authRoutes } from "./auth";
import { boxLogRoutes } from "./box-logs";
import { checkpointPackageRoutes } from "./checkpoint-packages";
import { eventRoutes } from "./events";
import { operationRoutes } from "./operations";
import { previewRoutes } from "./preview";
import type { Route } from "./router";
import { sshRoutes } from "./ssh";
import { systemRoutes } from "./system";
import { taskRoutes } from "./tasks";
import { tokenRoutes } from "./tokens";

export const routes: Route[] = [
  ...authRoutes,
  ...agentRoutes,
  ...systemRoutes,
  ...eventRoutes,
  ...taskRoutes,
  ...sshRoutes,
  ...tokenRoutes,
  ...boxLogRoutes,
  ...previewRoutes,
  ...checkpointPackageRoutes,
  ...operationRoutes(OPERATIONS),
];

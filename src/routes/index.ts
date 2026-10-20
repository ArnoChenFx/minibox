import { OPERATIONS } from "../operations/registry";
import { authRoutes } from "./auth";
import { eventRoutes } from "./events";
import { operationRoutes } from "./operations";
import type { Route } from "./router";
import { systemRoutes } from "./system";

export const routes: Route[] = [...authRoutes, ...systemRoutes, ...eventRoutes, ...operationRoutes(OPERATIONS)];

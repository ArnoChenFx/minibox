import { OPERATIONS } from "../operations/registry";
import { authRoutes } from "./auth";
import { imageRoutes } from "./images";
import { operationRoutes } from "./operations";
import type { Route } from "./router";
import { systemRoutes } from "./system";

export const routes: Route[] = [...authRoutes, ...systemRoutes, ...operationRoutes(OPERATIONS), ...imageRoutes];

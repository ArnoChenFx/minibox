import { authRoutes } from "./auth";
import { boxRoutes } from "./boxes";
import { imageRoutes } from "./images";
import type { Route } from "./router";
import { systemRoutes } from "./system";

export const routes: Route[] = [...authRoutes, ...systemRoutes, ...boxRoutes, ...imageRoutes];

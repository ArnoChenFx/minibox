import { json } from "../lib/http";
import { tokenCatalog } from "../tokens/model";
import { type Route, route } from "./router";

/** The scope groups and preset definitions the new-token dialog shows. Owner only, like the rest of token management. */
export const tokenRoutes: Route[] = [route("GET", "/api/tokens/presets", () => json(tokenCatalog()))];

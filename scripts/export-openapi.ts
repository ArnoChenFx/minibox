import { writeFileSync } from "node:fs";
import { join } from "node:path";

import pkg from "../package.json";
import { renderOpenApi } from "../src/operations/openapi";
import { OPERATIONS } from "../src/operations/registry";

const target = join(import.meta.dir, "..", "docs", "openapi.json");
writeFileSync(target, renderOpenApi(OPERATIONS, pkg.version));
console.log(`wrote ${target}`);

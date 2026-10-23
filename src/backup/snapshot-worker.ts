import { workerData } from "node:worker_threads";

import { copySqlite } from "./snapshot";

const { livePath, target } = workerData as { livePath: string; target: string };
copySqlite(livePath, target);

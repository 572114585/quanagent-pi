import { createRequire } from "node:module";
import { run } from "vue-tsc";

// Resolve the frontend's compiler even when npm hoists vue-tsc next to the root's TS 7.
const require = createRequire(import.meta.url);
run(require.resolve("typescript/lib/tsc.js"));

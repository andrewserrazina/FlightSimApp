// tsc does not copy .js sources; place the generated validators next to the compiled output.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
cpSync(join(root, "src", "generated"), join(root, "dist", "generated"), { recursive: true });

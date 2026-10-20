// Hosts one proxy instance so two separate `claude` invocations share it, which is what an
// interactive session does. Prints the port, then stays up until killed.
import { startProxy } from "../src/proxy.mjs";
import { userEnvFiles } from "../src/codex-cli.mjs";

for (const f of userEnvFiles()) {
  try {
    process.loadEnvFile(f);
  } catch {}
}

const { port } = await startProxy();
console.log(`PORT=${port}`);

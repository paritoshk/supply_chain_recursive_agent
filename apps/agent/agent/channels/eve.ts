import { eveChannel } from "eve/channels/eve";
import { localDev, none, vercelOidc } from "eve/channels/auth";

// Public demo: the web chat and REPL can reach the agent. All data is synthetic.
export default eveChannel({
  auth: [vercelOidc(), localDev(), none()],
});

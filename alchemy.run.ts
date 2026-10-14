import { loadConfigFile } from "./src/configFile.ts"
import { stackping } from "./src/stack.ts"

/**
 * Entry point for `alchemy deploy`. The `stackping` CLI runs it with
 * STACKPING_CONFIG_PATH pointing at the user's stackping.json; from a clone of
 * this repository it reads ./stackping.json.
 */
export default stackping(loadConfigFile())

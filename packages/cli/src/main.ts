#!/usr/bin/env node
/** The `aumohta` executable. */

import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2));

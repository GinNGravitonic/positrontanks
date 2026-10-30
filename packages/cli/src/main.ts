#!/usr/bin/env node
/** The `positrontanks` executable. */

import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2));

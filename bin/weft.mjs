#!/usr/bin/env node
import { main } from '../src/v2/cli.ts';

const code = await main(process.argv.slice(2));
process.exit(code);

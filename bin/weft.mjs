#!/usr/bin/env node
import { installUtf8Stdio } from '../src/platform/win/stdio-utf8.mjs';
import { main } from '../src/v2/cli.ts';

installUtf8Stdio();

const code = await main(process.argv.slice(2));
process.exit(code);

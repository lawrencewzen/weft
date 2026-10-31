#!/usr/bin/env node
/*
 * Copied by scripts/bundle-antigravity-acp.mjs from pi-antigravity-acp-provider@0.1.17 src/acp/supervisor.mjs. Do not edit.
 *
 * Regenerate: npm run bundle:antigravity-acp
 *
 * ACP starts this process as `node <this directory>/supervisor.mjs --command <agent>`. It is not bundled; it only depends on node:child_process.
 *
 * MIT License
 *
 * Copyright (c) 2026 pi-gemini-acp-provider contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { spawn } from "node:child_process";

// SSL_CERT_FILE is resolved by AntigravityProcess.applyDefaultTlsEnvironment
// before this supervisor is spawned; the supervisor passes its environment
// through to the agent unchanged.

const forwarded = process.argv.slice(2);
const genericCommand = forwarded[0] === "--command";
if (genericCommand) forwarded.shift();
const [entryOrCommand, ...forwardedArgs] = forwarded;
if (!entryOrCommand) {
	process.stderr.write("Antigravity ACP supervisor: missing agent command\n");
	process.exit(64);
}
const agentCommand = genericCommand ? entryOrCommand : process.execPath;
const agentArgs = genericCommand ? forwardedArgs : [entryOrCommand, ...forwardedArgs];

const parentPid = process.ppid;
const agent = spawn(agentCommand, agentArgs, {
	stdio: ["pipe", "pipe", "pipe"],
	shell: false,
	windowsHide: true,
	// Give Antigravity and every tool it starts a group separate from the watchdog.
	detached: process.platform !== "win32",
	env: process.env,
});

let shuttingDown = false;
let hardKillTimer;

process.stdin.pipe(agent.stdin);
agent.stdout.pipe(process.stdout);
agent.stderr.pipe(process.stderr);

const parentWatch = setInterval(() => {
	try {
		process.kill(parentPid, 0);
	} catch {
		shutdown("parent exited", 0);
	}
}, 500);
parentWatch.unref();

process.stdin.once("end", () => shutdown("ACP stdin closed", 0));
process.stdin.once("error", () => shutdown("ACP stdin failed", 1));
process.once("SIGTERM", () => shutdown("SIGTERM", 0));
process.once("SIGINT", () => shutdown("SIGINT", 0));
process.once("SIGHUP", () => shutdown("SIGHUP", 0));

agent.once("error", (error) => {
	process.stderr.write(`Antigravity ACP supervisor: ${error.message}\n`);
	shutdown("agent spawn failed", 1);
});
agent.once("exit", (code, signal) => {
	clearInterval(parentWatch);
	if (hardKillTimer) clearTimeout(hardKillTimer);
	process.stdin.unpipe(agent.stdin);
	process.stdin.destroy();
	if (!shuttingDown && signal) process.stderr.write(`Antigravity ACP agent exited on ${signal}\n`);
	const exitCode = code ?? (signal ? 1 : 0);
	// End forwarded stdout so the parent SDK closes immediately, then exit even
	// though the original parent may still hold its pipe descriptors open.
	process.stdout.end(() => process.exit(exitCode));
});

function shutdown(_reason, exitCode) {
	if (shuttingDown) return;
	shuttingDown = true;
	clearInterval(parentWatch);
	process.exitCode = exitCode;
	try {
		process.stdin.unpipe(agent.stdin);
		agent.stdin.end();
	} catch {
		// Agent input already closed.
	}
	signalAgent("SIGTERM");
	hardKillTimer = setTimeout(() => {
		signalAgent("SIGKILL");
		process.exit(exitCode);
	}, 750);
	// This timer must remain referenced: the watchdog owns killing the detached
	// agent process group before it is allowed to exit.
}

function signalAgent(signal) {
	try {
		if (process.platform === "win32" && agent.pid) {
			const args = ["/PID", String(agent.pid), "/T"];
			if (signal === "SIGKILL") args.push("/F");
			spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
			return;
		}
		if (agent.pid) process.kill(-agent.pid, signal);
		else agent.kill(signal);
	} catch {
		// ESRCH means the process tree is already gone.
	}
}

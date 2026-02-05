#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const watchPaths = [cwd];
const ignore = new Set(["node_modules", ".git"]);

let child = null;
let restartTimer = null;
let restarting = false;

function startServer() {
  if (child) return;
  console.log("[dev-watch] starting server...");
  child = spawn("node", ["index.js"], {
    stdio: "inherit",
  });
  child.on("exit", () => {
    child = null;
  });
}

function stopServer() {
  if (!child) return;
  console.log("[dev-watch] stopping server...");
  const proc = child;
  child = null;
  proc.kill("SIGTERM");
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill("SIGKILL");
    } catch {}
  }, 1000);
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (restarting) return;
    restarting = true;
    stopServer();
    setTimeout(() => {
      startServer();
      restarting = false;
    }, 250);
  }, 200);
}

function shouldIgnore(p) {
  return [...ignore].some((dir) => p.includes(`${path.sep}${dir}${path.sep}`));
}

function watchDir(dir) {
  try {
    fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const full = path.join(dir, filename);
      if (shouldIgnore(full)) return;
      scheduleRestart();
    });
  } catch (err) {
    console.error("Watcher error:", err);
  }
}

for (const p of watchPaths) watchDir(p);
startServer();

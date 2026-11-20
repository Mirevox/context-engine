#!/usr/bin/env node
// Turns fixtures/sample-repo into a real git repository with one commit (idempotent).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../fixtures/sample-repo", import.meta.url));
const git = (...args) =>
  execFileSync("git", ["-C", dir, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Mirevox Fixture",
      GIT_AUTHOR_EMAIL: "fixture@mirevox.invalid",
      GIT_COMMITTER_NAME: "Mirevox Fixture",
      GIT_COMMITTER_EMAIL: "fixture@mirevox.invalid",
    },
  }).toString();

if (!existsSync(`${dir}/.git`)) {
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "Initial sample commit");
}
console.log(dir);

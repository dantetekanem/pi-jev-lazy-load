// Resolve Pi peers from the installed Pi instead of installing another host for tests.
// Set PI_PACKAGE_ROOT to the @earendil-works/pi-coding-agent directory, or keep the pnpm `pi` shim on PATH.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function installedPiRoot(): string {
  if (process.env.PI_PACKAGE_ROOT) return resolve(process.env.PI_PACKAGE_ROOT);
  const shim = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  const target = readFileSync(shim, "utf8").match(/"\$basedir\/([^"]*@earendil-works\/pi-coding-agent)\/dist\/[^"]*cli\.js"/)?.[1];
  if (!target) throw new Error(`Cannot find the Pi package behind ${shim}; set PI_PACKAGE_ROOT`);
  const root = realpathSync(join(dirname(shim), target));
  process.env.PI_PACKAGE_ROOT = root;
  return root;
}

// Block the network paths used by Pi providers before loading the test or measurement.
// This guards accidental requests, not hostile code or subprocesses.
globalThis.fetch = async () => {
  throw new Error("Network disabled in offline checks");
};
Socket.prototype.connect = function () {
  throw new Error("Network disabled in offline checks");
};

// Credentials are stripped as a second precaution, not as network isolation.
for (const name of Object.keys(process.env)) {
  if (/_(API_KEY|ACCOUNT_ID|TOKEN)$/.test(name)) delete process.env[name];
}

const host = pathToFileURL(join(installedPiRoot(), "package.json")).href;
const peers = new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"]);

registerHooks({
  resolve(specifier, context, next) {
    const peer = peers.has(specifier) || specifier.startsWith("typebox/") || specifier.startsWith("@earendil-works/pi-ai/");
    return next(specifier, peer ? { ...context, parentURL: host } : context);
  },
});

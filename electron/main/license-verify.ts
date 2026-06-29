import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { machineIdPath, prefsPath } from "./app-paths.js";

const SECRET_SALT = "video_clone_secret_salt_2026";
const MACHINE_ID_RE = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;
const FP_RE = /^[0-9A-F]{64}$/;

function collectMacs(): string[] {
  const interfaces = os.networkInterfaces();
  const macs: string[] = [];
  for (const name of Object.keys(interfaces).sort()) {
    const netInterface = interfaces[name];
    if (!netInterface) continue;
    for (const item of netInterface) {
      if (!item.internal && item.mac && item.mac !== "00:00:00:00:00:00") {
        macs.push(item.mac.toUpperCase());
      }
    }
  }
  return [...new Set(macs)].sort();
}

function readWindowsMachineGuid(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: "utf-8", windowsHide: true }
    );
    const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
    return match?.[1]?.trim().toUpperCase() ?? null;
  } catch {
    return null;
  }
}

function readPlatformMachineId(): string | null {
  if (process.platform === "win32") {
    return readWindowsMachineGuid();
  }
  if (process.platform === "darwin") {
    try {
      const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice", {
        encoding: "utf-8",
        windowsHide: true
      });
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return match?.[1]?.trim().toUpperCase() ?? null;
    } catch {
      return null;
    }
  }
  try {
    return readFileSync("/etc/machine-id", "utf-8").trim().toUpperCase() || null;
  } catch {
    return null;
  }
}

/** Live hardware fingerprint ΓÇö cannot be reused by copying data files to another PC. */
export function getHardwareFingerprint(): string {
  const parts: string[] = [];
  const platformId = readPlatformMachineId();
  if (platformId) parts.push(`platform:${platformId}`);
  const macs = collectMacs();
  if (macs.length > 0) parts.push(`mac:${macs.join("|")}`);
  if (parts.length === 0) {
    parts.push(
      `fallback:${os.hostname()}|${os.userInfo().username}|${os.platform()}|${os.arch()}`
    );
  }
  return crypto.createHash("sha256").update(parts.join("\n"), "utf8").digest("hex").toUpperCase();
}

function computeMachineIdFromHardware(): string {
  const macs = collectMacs();
  const seed = macs.length > 0
    ? macs.join("")
    : os.hostname() + os.userInfo().username + os.platform() + os.arch();
  const hash = crypto.createHash("sha256").update(seed).digest("hex").toUpperCase();
  return `${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}`;
}

function readPrefsSync(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(prefsPath(), "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readStoredHardwareFingerprint(): string | null {
  const prefs = readPrefsSync();
  const fp = prefs.license_hardware_fp;
  if (typeof fp !== "string") return null;
  const normalized = fp.trim().toUpperCase();
  return FP_RE.test(normalized) ? normalized : null;
}

function hardwareFingerprintMatches(stored: string | null): boolean {
  if (!stored) return true;
  return stored === getHardwareFingerprint();
}

function readPersistedMachineId(): string | null {
  try {
    const lines = readFileSync(machineIdPath(), "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const id = lines[0]?.toUpperCase() ?? "";
    const boundFp = lines[1]?.toUpperCase() ?? "";
    if (!MACHINE_ID_RE.test(id)) return null;
    if (boundFp && FP_RE.test(boundFp) && boundFp !== getHardwareFingerprint()) {
      console.warn("machine.id belongs to another machine ΓÇö ignoring copied file");
      return null;
    }
    return id;
  } catch {
    return null;
  }
}

function persistMachineId(id: string) {
  const normalized = id.trim().toUpperCase();
  if (!MACHINE_ID_RE.test(normalized)) return;
  const target = machineIdPath();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${normalized}\n${getHardwareFingerprint()}\n`, "utf-8");
}

export function getMachineId(): string {
  const prefs = readPrefsSync();
  const savedKey = typeof prefs.license_key === "string" ? prefs.license_key.trim() : "";
  if (!savedKey) {
    return computeMachineIdFromHardware();
  }
  return readPersistedMachineId() ?? computeMachineIdFromHardware();
}

export function verifyLicenseKey(key: string, options?: { forActivation?: boolean }): boolean {
  if (!key) return false;

  const normalizedKey = key.replace(/-/g, "").replace(/\s/g, "").toUpperCase();
  if (normalizedKey.length !== 16) return false;

  if (!options?.forActivation) {
    const storedFp = readStoredHardwareFingerprint();
    if (!hardwareFingerprintMatches(storedFp)) {
      console.warn("License hardware fingerprint mismatch — activation rejected");
      return false;
    }
  }

  const machineId = options?.forActivation
    ? computeMachineIdFromHardware()
    : getMachineId();
  const normalizedMachine = machineId.replace(/-/g, "").replace(/\s/g, "").toUpperCase();
  const hashInput = normalizedMachine + SECRET_SALT;
  const sha256Hash = crypto.createHash("sha256").update(hashInput, "utf8").digest("hex").toUpperCase();
  const expectedKey = sha256Hash.slice(0, 16);

  if (normalizedKey === expectedKey) {
    persistMachineId(machineId);
    ensureActivationBound();
    return true;
  }
  return false;
}

/** Write Electron's machine ID for the Python backend before first activation. */
export function ensureMachineIdSynced() {
  const prefs = readPrefsSync();
  const savedKey = typeof prefs.license_key === "string" ? prefs.license_key.trim() : "";
  if (savedKey) {
    return;
  }

  const computed = computeMachineIdFromHardware();
  const target = machineIdPath();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${computed}\n`, "utf-8");
}

function ensureActivationBound() {
  const prefs = readPrefsSync();
  const fp = prefs.license_hardware_fp;
  if (typeof fp === "string" && FP_RE.test(fp.trim().toUpperCase())) return;
  prefs.license_hardware_fp = getHardwareFingerprint();
  mkdirSync(path.dirname(prefsPath()), { recursive: true });
  writeFileSync(prefsPath(), `${JSON.stringify(prefs, null, 2)}\n`, "utf-8");
}

export function getActivationHardwareFingerprint(): string {
  return getHardwareFingerprint();
}

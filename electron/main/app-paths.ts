import { app } from "electron";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** Fixed userData path — dev (`video-dubbing-desktop`) and packaged (`Video Clone`) used different folders before. */
export const USER_DATA_DIR = path.join(app.getPath("appData"), "VideoCloneDouyin");

export function initUserDataPath() {
  app.setPath("userData", USER_DATA_DIR);
}

export function prefsPath() {
  return path.join(USER_DATA_DIR, "data", "prefs.json");
}

export function machineIdPath() {
  return path.join(USER_DATA_DIR, "data", "machine.id");
}

/** Copy prefs/models from legacy Electron userData folders on first run after the path fix. */
export async function migrateLegacyUserData() {
  const newPrefs = prefsPath();
  if (existsSync(newPrefs)) return;

  const legacyRoots = [
    path.join(app.getPath("appData"), "video-dubbing-desktop"),
    path.join(app.getPath("appData"), "Video Clone"),
  ];

  for (const oldRoot of legacyRoots) {
    const oldPrefs = path.join(oldRoot, "data", "prefs.json");
    if (!existsSync(oldPrefs)) continue;
    const newDataDir = path.join(USER_DATA_DIR, "data");
    await fs.mkdir(newDataDir, { recursive: true });
    await fs.copyFile(oldPrefs, newPrefs);
    const oldModels = path.join(oldRoot, "models");
    const newModels = path.join(USER_DATA_DIR, "models");
    if (existsSync(oldModels) && !existsSync(newModels)) {
      await fs.cp(oldModels, newModels, { recursive: true });
    }
    console.log(`Migrated user data from ${oldRoot} -> ${USER_DATA_DIR}`);
    return;
  }
}

export async function readPrefs(): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(prefsPath(), "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function writePrefs(prefs: Record<string, unknown>) {
  const target = prefsPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(prefs, null, 2), "utf-8");
}

export async function saveLicenseKey(key: string) {
  const { getActivationHardwareFingerprint, getMachineId } = await import("./license-verify.js");
  const prefs = await readPrefs();
  prefs.license_key = key;
  prefs.license_hardware_fp = getActivationHardwareFingerprint();
  await writePrefs(prefs);
  const target = machineIdPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(
    target,
    `${getMachineId().trim().toUpperCase()}\n${getActivationHardwareFingerprint()}\n`,
    "utf-8"
  );
}

import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { readPrefs, USER_DATA_DIR } from "./app-paths.js";
import { verifyLicenseKey, ensureMachineIdSynced } from "./license-verify.js";

let backend: ChildProcessWithoutNullStreams | null = null;
let apiBase = "";
export let sessionToken = "";


const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.unref();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 3930;
    server.close(() => resolve(port));
  });
});

function appRoot() {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function pythonExecutable(root: string) {
  if (process.env.VIDEO_DUBBING_PYTHON) return process.env.VIDEO_DUBBING_PYTHON;
  const venvPython = process.platform === "win32"
    ? path.join(root, "backend", ".venv", "Scripts", "python.exe")
    : path.join(root, "backend", ".venv", "bin", "python");
  const embedPython = process.platform === "win32"
    ? path.join(root, "backend", "python311", "python.exe")
    : "";
  const sitePackages = path.join(root, "backend", ".venv", "Lib", "site-packages");

  // Dev: full venv has all deps and avoids embed-python path quirks.
  if (!app.isPackaged && existsSync(venvPython)) return venvPython;

  // Packaged portable: embed python + site-packages tree copied alongside.
  if (embedPython && existsSync(embedPython) && existsSync(sitePackages)) return embedPython;

  const candidates = process.platform === "win32"
    ? [
        venvPython,
        embedPython,
        path.join(root, ".venv", "Scripts", "python.exe"),
        path.join(root, "..", ".venv", "Scripts", "python.exe")
      ]
    : [
        venvPython,
        path.join(root, ".venv", "bin", "python"),
        path.join(root, "..", ".venv", "bin", "python")
      ];
  return candidates.find((p) => p && existsSync(p)) || (process.platform === "win32" ? "python" : "python3");
}

async function waitForBackend(url: string, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // Backend is still importing its runtime.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("FastAPI không khởi động trong thời gian cho phép.");
}

export async function startBackend() {
  if (backend && apiBase) return apiBase;
  const root = appRoot();
  const backendDir = path.join(root, "backend");
  const port = await freePort();
  apiBase = `http://127.0.0.1:${port}`;
  sessionToken = crypto.randomUUID();

  ensureMachineIdSynced();

  // Read and verify license key from prefs.json
  let isActivated = false;
  try {
    const prefs = await readPrefs();
    const savedKey = typeof prefs.license_key === "string" ? prefs.license_key : "";
    if (savedKey) {
      isActivated = verifyLicenseKey(savedKey);
      if (!isActivated) {
        console.warn("Saved license key did not verify for this machine — activation required.");
      }
    }
  } catch (e) {
    console.warn("Could not read license prefs:", e);
  }

  const userData = USER_DATA_DIR;

  const pythonPath = pythonExecutable(root);
  const isPortablePython = pythonPath.includes("python311");
  const binDir = path.join(root, "backend", "bin");
  const ffmpegPath = path.join(binDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const ffprobePath = path.join(binDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const pathPrefix = existsSync(binDir) ? `${binDir}${path.delimiter}` : "";

  const env: Record<string, string> = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    OMNIVOICE_DATA_DIR: path.join(userData, "data"),
    OMNIVOICE_CACHE_DIR: path.join(userData, "models"),
    HF_HOME: path.join(userData, "models"),
    HF_HUB_CACHE: path.join(userData, "models"),
    TORCH_HOME: path.join(userData, "models"),
    OMNIVOICE_MCP_DISABLE: "1",
    OMNIVOICE_UI_PORT: "5174",
    OMNIVOICE_ALLOWED_ORIGINS: "http://127.0.0.1:5174,http://localhost:5174,null",
    VIDEO_DUBBING_DISABLE_MODEL_PRELOAD: "1",
    OMNIVOICE_ACTIVATED: isActivated ? "1" : "0",
    OMNIVOICE_SESSION_TOKEN: sessionToken,
    PATH: `${pathPrefix}${process.env.PATH ?? ""}`,
  };

  if (existsSync(ffmpegPath)) {
    env.FFMPEG_PATH = ffmpegPath;
  }
  if (existsSync(ffprobePath)) {
    env.FFPROBE_PATH = ffprobePath;
    env.OMNIVOICE_FFPROBE_PATH = ffprobePath;
  }

  if (isPortablePython) {
    env.PYTHONHOME = path.join(root, "backend", "python311");
    env.PYTHONPATH = path.join(root, "backend", ".venv", "Lib", "site-packages");
  }

  const uvicornArgs = [
    "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(port)
  ];
  // No --reload: uvicorn reload can drop in-flight routes mid-request and leave
  // a stale worker without newer API endpoints (e.g. OCR detect-text).

  backend = spawn(pythonPath, uvicornArgs, {
    cwd: backendDir,
    windowsHide: true,
    env
  });
  backend.stdout.on("data", (data) => console.log(`[backend] ${data}`));
  backend.stderr.on("data", (data) => console.error(`[backend] ${data}`));
  backend.on("exit", (code) => {
    console.log(`Video Clone backend exited with code ${code}`);
    backend = null;
    apiBase = "";
  });
  await waitForBackend(apiBase);
  return apiBase;
}

export function stopBackend() {
  backend?.kill();
  backend = null;
  apiBase = "";
}

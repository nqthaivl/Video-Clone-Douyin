import { app, BrowserWindow, dialog, ipcMain, Menu, shell, session } from "electron";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { initUserDataPath, migrateLegacyUserData, prefsPath, readPrefs, saveLicenseKey, USER_DATA_DIR } from "./app-paths.js";
import { startBackend, stopBackend, sessionToken } from "./backend-process.js";
import { verifyLicenseKey, getMachineId, ensureMachineIdSynced } from "./license-verify.js";
import "./douyin-downloader.js";

initUserDataPath();

let window: BrowserWindow | null = null;
let backendUrl = "";
const COLAB_NOTEBOOK_URL = "https://colab.research.google.com/github/nqthaivl/videocolab/blob/main/Video_Clone_Douyin_Colab.ipynb";

type BackendConfig = {
  backendMode: "local" | "colab";
  colabUrl: string;
};

function configPath() {
  return path.join(USER_DATA_DIR, "data", "backend-config.json");
}

function normalizeBackendUrl(url: string) {
  return url.trim().replace(/\/+$/, "");
}

async function readBackendConfig(): Promise<BackendConfig> {
  try {
    const content = await fs.readFile(configPath(), "utf-8");
    const json = JSON.parse(content);
    return {
      backendMode: json.backendMode === "colab" ? "colab" : "local",
      colabUrl: typeof json.colabUrl === "string" ? normalizeBackendUrl(json.colabUrl) : ""
    };
  } catch {
    return { backendMode: "local", colabUrl: "" };
  }
}

async function writeBackendConfig(config: BackendConfig) {
  const clean = {
    backendMode: config.backendMode === "colab" ? "colab" : "local",
    colabUrl: normalizeBackendUrl(config.colabUrl || "")
  } satisfies BackendConfig;
  const target = configPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(clean, null, 2), "utf-8");
  return clean;
}

async function createWindow() {
  await migrateLegacyUserData();
  const config = await readBackendConfig();
  if (config.backendMode === "colab") {
    backendUrl = config.colabUrl;
    console.log("Using remote Colab backend URL:", backendUrl || "(not configured yet)");
  } else {
    try {
      backendUrl = await startBackend();
    } catch (err) {
      console.error("Could not start local backend while opening app:", err);
      backendUrl = "";
    }
  }
  window = new BrowserWindow({
    width: 1480,
    height: 930,
    minWidth: 1080,
    minHeight: 720,
    title: "Video Clone",
    backgroundColor: "#f6f8fc",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.once("ready-to-show", () => {
    window?.maximize();
    window?.show();
  });
  if (process.env.VITE_DEV_SERVER_URL) await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await window.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
}

ipcMain.handle("video-dubbing:api-base", () => backendUrl);
ipcMain.handle("video-dubbing:get-backend-config", async () => readBackendConfig());
ipcMain.handle("video-dubbing:save-backend-config", async (_, config: BackendConfig) => {
  const next = await writeBackendConfig(config);
  if (next.backendMode === "colab") {
    stopBackend();
    backendUrl = next.colabUrl;
    console.log("Switched to remote Colab backend:", backendUrl || "(not configured yet)");
  } else {
    backendUrl = await startBackend();
    console.log("Switched to local backend:", backendUrl);
  }
  return { ...next, apiBase: backendUrl };
});
ipcMain.handle("video-dubbing:open-colab-notebook", async () => {
  await shell.openExternal(COLAB_NOTEBOOK_URL);
});
ipcMain.handle("video-dubbing:get-machine-id", () => getMachineId());
ipcMain.handle("video-dubbing:save-file", async (_, suggestedName: string, sourceUrl: string, defaultDir?: string) => {
  const extension = path.extname(suggestedName).slice(1) || "mp4";
  let filePath = "";
  let useDefault = false;
  
  if (defaultDir) {
    try {
      const stats = await fs.stat(defaultDir);
      if (stats.isDirectory()) {
        filePath = path.join(defaultDir, suggestedName);
        useDefault = true;
      }
    } catch {
      // directory does not exist, fallback to dialog
    }
  }

  if (!useDefault) {
    const result = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath("downloads"), suggestedName),
      filters: [{name: "Tệp xuất", extensions: [extension]}]
    });
    if (result.canceled || !result.filePath) return "";
    filePath = result.filePath;
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error("Không thể đọc tệp xuất từ backend.");
  if (!response.body) throw new Error("Không thể đọc tệp xuất từ backend.");

  const contentLength = Number(response.headers.get("content-length")) || 0;
  let receivedLength = 0;

  const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream);
  nodeStream.on("data", (chunk: Buffer) => {
    receivedLength += chunk.length;
    if (contentLength > 0) {
      const percent = Math.min(100, Math.round((receivedLength / contentLength) * 100));
      window?.webContents.send("video-dubbing:download-progress", { percent, status: "downloading" });
    }
  });

  const fileStream = createWriteStream(filePath);
  await pipeline(nodeStream, fileStream);
  window?.webContents.send("video-dubbing:download-progress", { percent: 100, status: "done" });
  return filePath;
});
ipcMain.handle("video-dubbing:open-path", async (_, target: string) => {
  await shell.showItemInFolder(target);
});
ipcMain.handle("video-dubbing:open-item", async (_, target: string) => {
  await shell.openPath(target);
});
ipcMain.handle("video-dubbing:select-directory", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return "";
  return result.filePaths[0];
});
ipcMain.handle("video-dubbing:activate-license", async (_, key: string) => {
  ensureMachineIdSynced();
  const isValid = verifyLicenseKey(key, { forActivation: true });
  if (!isValid) {
    return { success: false, message: "Mã kích hoạt không đúng hoặc không hợp lệ." };
  }

  try {
    const response = await fetch(`${backendUrl}/api/license/activate-internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_token: sessionToken,
        key: key
      })
    });

    if (response.ok) {
      await saveLicenseKey(key);
      return { success: true };
    } else {
      let errorMsg = "Không thể lưu trạng thái kích hoạt ở backend.";
      try {
        const errJson = await response.json();
        errorMsg = errJson.message || errorMsg;
      } catch {}
      return { success: false, message: errorMsg };
    }
  } catch (e: any) {
    return { success: false, message: `Lỗi kết nối tới backend: ${e.message || e}` };
  }
});

function getPrefsPath() {
  return prefsPath();
}

async function getDouyinCookieInternal() {
  const prefs = await readPrefs();
  return typeof prefs.douyin_cookie === "string" ? prefs.douyin_cookie : "";
}

async function saveDouyinCookieInternal(cookie: string) {
  const prefs = await readPrefs();
  prefs.douyin_cookie = cookie;
  const target = prefsPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(prefs, null, 2), "utf-8");
}

function blockCustomProtocols(win: BrowserWindow) {
  const contents = win.webContents;
  const isBlocked = (url: string) => {
    const lower = url.toLowerCase();
    return ["bytedance:", "snssdk:", "aweme:"].some(p => lower.startsWith(p));
  };
  contents.on("will-navigate", (event, url) => {
    if (isBlocked(url)) event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    if (isBlocked(event.url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isBlocked(url) || !["http:", "https:", "mailto:"].some(p => url.toLowerCase().startsWith(p))) {
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

ipcMain.handle("video-dubbing:get-douyin-cookie", async () => {
  return await getDouyinCookieInternal();
});

ipcMain.handle("video-dubbing:save-douyin-cookie", async (_, cookie: string) => {
  await saveDouyinCookieInternal(cookie);
});

ipcMain.handle("video-dubbing:fetch-douyin-cookie", async () => {
  return new Promise<string>((resolve, reject) => {
    const partition = "persist:douyin-login";
    const ses = session.fromPartition(partition);
    
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: "Đăng nhập Douyin - đóng cửa sổ này sau khi đăng nhập",
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    
    blockCustomProtocols(win);
    win.loadURL("https://www.douyin.com").catch(err => {
      console.error("Failed to load Douyin URL", err);
    });
    
    win.on("closed", async () => {
      try {
        const cookies = await ses.cookies.get({ domain: ".douyin.com" });
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join("; ");
        if (cookieString) {
          await saveDouyinCookieInternal(cookieString);
        }
        resolve(cookieString);
      } catch (error) {
        reject(error);
      }
    });
  });
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  void createWindow();
});
app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
app.on("before-quit", stopBackend);

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("videoDubbingDesktop", {
  getApiBase: () => ipcRenderer.invoke("video-dubbing:api-base") as Promise<string>,
  getBackendConfig: () =>
    ipcRenderer.invoke("video-dubbing:get-backend-config") as Promise<{ backendMode: "local" | "colab"; colabUrl: string }>,
  saveBackendConfig: (config: { backendMode: "local" | "colab"; colabUrl: string }) =>
    ipcRenderer.invoke("video-dubbing:save-backend-config", config) as Promise<{ backendMode: "local" | "colab"; colabUrl: string; apiBase: string }>,
  getMachineId: () =>
    ipcRenderer.invoke("video-dubbing:get-machine-id") as Promise<string>,
  openColabNotebook: () =>
    ipcRenderer.invoke("video-dubbing:open-colab-notebook") as Promise<void>,
  saveFile: (suggestedName: string, sourceUrl: string, defaultDir?: string) =>
    ipcRenderer.invoke("video-dubbing:save-file", suggestedName, sourceUrl, defaultDir) as Promise<string>,
  openPath: (target: string) =>
    ipcRenderer.invoke("video-dubbing:open-path", target) as Promise<void>,
  openItem: (target: string) =>
    ipcRenderer.invoke("video-dubbing:open-item", target) as Promise<void>,
  selectDirectory: () =>
    ipcRenderer.invoke("video-dubbing:select-directory") as Promise<string>,
  onDownloadProgress: (callback: (event: any, data: { percent: number; status: string }) => void) => {
    ipcRenderer.on("video-dubbing:download-progress", callback);
    return () => {
      ipcRenderer.removeListener("video-dubbing:download-progress", callback);
    };
  },
  activateLicense: (key: string) =>
    ipcRenderer.invoke("video-dubbing:activate-license", key) as Promise<{ success: boolean; message?: string }>,
  fetchDouyinCookie: () =>
    ipcRenderer.invoke("video-dubbing:fetch-douyin-cookie") as Promise<string>,
  getDouyinCookie: () =>
    ipcRenderer.invoke("video-dubbing:get-douyin-cookie") as Promise<string>,
  saveDouyinCookie: (cookie: string) =>
    ipcRenderer.invoke("video-dubbing:save-douyin-cookie", cookie) as Promise<void>,
  douyinStartDownload: (url: string, downloadPath: string, onlyMp4: boolean, isUser: boolean) =>
    ipcRenderer.invoke("video-dubbing:douyin-start-download", { url, downloadPath, onlyMp4, isUser }) as Promise<void>,
  douyinCancelDownload: () =>
    ipcRenderer.invoke("video-dubbing:douyin-cancel-download") as Promise<void>,
  onDouyinDownloadProgress: (callback: (event: any, data: { downloaded: number; total: number; status: string; message: string }) => void) => {
    ipcRenderer.on("video-dubbing:douyin-download-progress", callback);
    return () => {
      ipcRenderer.removeListener("video-dubbing:douyin-download-progress", callback);
    };
  }
});

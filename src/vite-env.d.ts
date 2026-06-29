/// <reference types="vite/client" />

interface Window {
  videoDubbingDesktop?: {
    getApiBase(): Promise<string>;
    getBackendConfig(): Promise<{ backendMode: "local" | "colab"; colabUrl: string }>;
    saveBackendConfig(config: { backendMode: "local" | "colab"; colabUrl: string }): Promise<{ backendMode: "local" | "colab"; colabUrl: string; apiBase: string }>;
    getMachineId(): Promise<string>;
    openColabNotebook(): Promise<void>;
    saveFile(suggestedName: string, sourceUrl: string, defaultDir?: string): Promise<string>;
    openPath(target: string): Promise<void>;
    openItem(target: string): Promise<void>;
    selectDirectory(): Promise<string>;
    onDownloadProgress(callback: (event: any, data: { percent: number; status: string }) => void): () => void;
    activateLicense(key: string): Promise<{ success: boolean; message?: string }>;
    fetchDouyinCookie(): Promise<string>;
    getDouyinCookie(): Promise<string>;
    saveDouyinCookie(cookie: string): Promise<void>;
    douyinStartDownload(url: string, downloadPath: string, onlyMp4: boolean, isUser: boolean): Promise<void>;
    douyinCancelDownload(): Promise<void>;
    onDouyinDownloadProgress(callback: (event: any, data: { downloaded: number; total: number; status: string; message: string; downloadedItems?: Array<{ id: string; title: string; path: string; isFolder: boolean }> }) => void): () => void;
  };
}

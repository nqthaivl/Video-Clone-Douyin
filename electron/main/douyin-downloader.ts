import { app, BrowserWindow, ipcMain } from "electron";
import { DouyinHandler, DouyinDownloader, getSecUserId, getAwemeId, setConfig } from "dy-downloader";
import path from "node:path";
import fs from "node:fs/promises";
import { prefsPath, readPrefs } from "./app-paths.js";

// Cấu hình mã hoá chữ ký A-Bogus mặc định
setConfig({ encryption: "ab" });

let isDownloading = false;
let cancelRequested = false;

async function getDouyinCookie() {
  const prefs = await readPrefs();
  return typeof prefs.douyin_cookie === "string" ? prefs.douyin_cookie : "";
}

ipcMain.handle("video-dubbing:douyin-start-download", async (
  _,
  { url, downloadPath, onlyMp4, isUser }: { url: string; downloadPath: string; onlyMp4: boolean; isUser: boolean }
) => {
  if (isDownloading) {
    throw new Error("Có một tác vụ tải xuống đang chạy.");
  }
  
  const cookie = await getDouyinCookie();
  if (!cookie) {
    throw new Error("Vui lòng cấu hình Cookie Douyin trước.");
  }

  isDownloading = true;
  cancelRequested = false;

  const win = BrowserWindow.getAllWindows()[0];
  const downloadedItems: Array<{ id: string; title: string; path: string; isFolder: boolean }> = [];
  
  const sendProgress = (downloaded: number, total: number, status: string, message: string) => {
    win?.webContents.send("video-dubbing:douyin-download-progress", {
      downloaded,
      total,
      status,
      message,
      downloadedItems
    });
  };

  try {
    sendProgress(0, 0, "starting", "Đang phân tích liên kết...");

    const handler = new DouyinHandler({ cookie });

    if (isUser) {
      // 1. Tải toàn bộ video của người dùng
      const secUserId = await getSecUserId(url);
      if (!secUserId) {
        throw new Error("Không thể trích xuất ID người dùng (sec_user_id) từ liên kết.");
      }

      sendProgress(0, 0, "fetching_list", "Đang quét danh sách video từ Douyin...");
      const videos: any[] = [];
      for await (const postFilter of handler.fetchUserPostVideos(secUserId, { maxCounts: 0 })) {
        if (cancelRequested) break;
        const awemeList = postFilter.toAwemeDataList();
        for (const awemeData of awemeList) {
          if (awemeData.awemeId) {
            videos.push(awemeData);
          }
        }
      }

      if (videos.length === 0) {
        throw new Error("Không tìm thấy video nào của người dùng này hoặc lỗi kết nối.");
      }

      const total = videos.length;
      sendProgress(0, total, "downloading", `Đã tìm thấy ${total} video. Bắt đầu tải...`);

      const downloader = new DouyinDownloader({
        cookie,
        downloadPath,
        naming: "{aweme_id}",
        folderize: !onlyMp4,
        cover: !onlyMp4,
        music: !onlyMp4,
        desc: !onlyMp4
      });

      let downloaded = 0;
      for (const awemeData of videos) {
        if (cancelRequested) {
          sendProgress(downloaded, total, "cancelled", "Đã hủy tác vụ tải xuống.");
          break;
        }

        const title = awemeData.desc || awemeData.caption || awemeData.awemeId;
        sendProgress(downloaded, total, "downloading", `Đang tải video: ${title}`);

        try {
          await downloader.createDownloadTasks(awemeData, downloadPath);

          // Rename downloaded video to remove '_video' suffix
          const rawVideoPath = onlyMp4 
            ? path.join(downloadPath, `${awemeData.awemeId}_video.mp4`)
            : path.join(downloadPath, awemeData.awemeId, `${awemeData.awemeId}_video.mp4`);
          const cleanVideoPath = onlyMp4
            ? path.join(downloadPath, `${awemeData.awemeId}.mp4`)
            : path.join(downloadPath, awemeData.awemeId, `${awemeData.awemeId}.mp4`);

          try {
            await fs.rename(rawVideoPath, cleanVideoPath);
          } catch (renameErr) {
            console.warn(`Could not rename video file from ${rawVideoPath} to ${cleanVideoPath}:`, renameErr);
          }

          downloaded++;
          const itemPath = onlyMp4 
            ? path.join(downloadPath, `${awemeData.awemeId}.mp4`)
            : path.join(downloadPath, awemeData.awemeId);
          downloadedItems.push({
            id: awemeData.awemeId,
            title,
            path: itemPath,
            isFolder: !onlyMp4
          });
          sendProgress(downloaded, total, "downloading", `Đã tải xong: ${title}`);
        } catch (err: any) {
          console.error(`Failed to download ${awemeData.awemeId}:`, err);
        }
      }

      if (!cancelRequested) {
        sendProgress(downloaded, total, "done", `Đã tải thành công ${downloaded}/${total} video.`);
      }
    } else {
      // 2. Tải video đơn lẻ
      const awemeId = await getAwemeId(url);
      if (!awemeId) {
        throw new Error("Không thể trích xuất ID video (aweme_id) từ liên kết.");
      }

      sendProgress(0, 1, "downloading", "Đang tải dữ liệu chi tiết video...");
      const awemeData = await handler.fetchOneVideo(awemeId);
      if (!awemeData || !awemeData.awemeId) {
        throw new Error("Không thể tải thông tin chi tiết video.");
      }

      const downloader = new DouyinDownloader({
        cookie,
        downloadPath,
        naming: "{aweme_id}",
        folderize: !onlyMp4,
        cover: !onlyMp4,
        music: !onlyMp4,
        desc: !onlyMp4
      });

      sendProgress(0, 1, "downloading", "Đang tải tệp về máy...");
      await downloader.createDownloadTasks(awemeData as any, downloadPath);

      // Rename downloaded video to remove '_video' suffix
      const rawVideoPath = onlyMp4 
        ? path.join(downloadPath, `${awemeData.awemeId}_video.mp4`)
        : path.join(downloadPath, awemeData.awemeId, `${awemeData.awemeId}_video.mp4`);
      const cleanVideoPath = onlyMp4
        ? path.join(downloadPath, `${awemeData.awemeId}.mp4`)
        : path.join(downloadPath, awemeData.awemeId, `${awemeData.awemeId}.mp4`);

      try {
        await fs.rename(rawVideoPath, cleanVideoPath);
      } catch (renameErr) {
        console.warn(`Could not rename video file from ${rawVideoPath} to ${cleanVideoPath}:`, renameErr);
      }
      
      const title = awemeData.desc || (awemeData as any).caption || awemeData.awemeId;
      const itemPath = onlyMp4 
        ? path.join(downloadPath, `${awemeData.awemeId}.mp4`)
        : path.join(downloadPath, awemeData.awemeId);
      downloadedItems.push({
        id: awemeData.awemeId,
        title,
        path: itemPath,
        isFolder: !onlyMp4
      });
      
      sendProgress(1, 1, "done", "Tải video thành công!");
    }
  } catch (err: any) {
    sendProgress(0, 0, "failed", err.message || "Tải xuống thất bại.");
    throw err;
  } finally {
    isDownloading = false;
  }
});

ipcMain.handle("video-dubbing:douyin-cancel-download", () => {
  cancelRequested = true;
});

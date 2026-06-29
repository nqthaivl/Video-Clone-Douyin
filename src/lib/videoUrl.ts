/** True when the URL should use the Douyin-specific downloader (not yt-dlp). */
export function isDouyinUrl(url: string): boolean {
  const trimmed = (url || "").trim();
  if (!trimmed) return false;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    return (
      host.includes("douyin.com") ||
      host.includes("iesdouyin.com") ||
      host.includes("douyin.cn")
    );
  } catch {
    return /douyin\.com|iesdouyin\.com|douyin\.cn/i.test(trimmed);
  }
}

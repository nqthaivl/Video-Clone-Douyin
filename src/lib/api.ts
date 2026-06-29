export type ModelInfo = {
  repo_id: string;
  label: string;
  role: string;
  size_gb: number;
  required: boolean;
  installed: boolean;
  partial?: boolean;
  supported: boolean;
  note?: string;
  hf_repo_id?: string;
  gguf_file?: string;
  llama_model?: string;
  engine?: string;
};

export type Segment = {
  id: string | number;
  start: number;
  end: number;
  text: string;
  text_original?: string;
  speaker_id?: string;
  profile_id?: string;
  speed?: number;
};

export type VoiceProfile = {
  id: string;
  name: string;
  ref_audio_path?: string;
  ref_text?: string;
  instruct?: string;
  language?: string;
  seed?: number;
  personality?: string;
  kind: "clone" | "design";
  created_at: number;
};

export type AsrBackendInfo = {
  id: string;
  display_name: string;
  available: boolean;
  reason?: string | null;
  install_hint?: string | null;
};

export type AsrEnginesResponse = {
  active: string;
  backends: AsrBackendInfo[];
};

let base = "";

export type BackendConfig = {
  backendMode: "local" | "colab";
  colabUrl: string;
};

export type DriveExportResult = {
  saved: boolean;
  destination: string;
  drive_path: string;
  filename: string;
  folder_url: string;
  file_search_url: string;
  open_url: string;
  size?: number;
  media_type?: string;
};

const normalizeBase = (url: string) => url.trim().replace(/\/+$/, "");

export async function initApi() {
  base = window.videoDubbingDesktop
    ? await window.videoDubbingDesktop.getApiBase()
    : localStorage.getItem("videoCloneColabUrl") || "http://127.0.0.1:3900";
  base = normalizeBase(base);
  return base;
}

export const apiUrl = (path: string) => `${base}${path}`;

export function setApiBase(nextBase: string) {
  base = normalizeBase(nextBase);
  return base;
}

export async function getBackendConfig(): Promise<BackendConfig> {
  if (window.videoDubbingDesktop) {
    return window.videoDubbingDesktop.getBackendConfig();
  }
  const colabUrl = localStorage.getItem("videoCloneColabUrl") || "";
  return {
    backendMode: colabUrl ? "colab" : "local",
    colabUrl
  };
}

export async function saveBackendConfig(config: BackendConfig): Promise<BackendConfig & { apiBase: string }> {
  const clean = {
    backendMode: config.backendMode,
    colabUrl: normalizeBase(config.colabUrl || "")
  };
  if (window.videoDubbingDesktop) {
    const result = await window.videoDubbingDesktop.saveBackendConfig(clean);
    setApiBase(result.apiBase);
    return result;
  }
  if (clean.backendMode === "colab") {
    localStorage.setItem("videoCloneColabUrl", clean.colabUrl);
    setApiBase(clean.colabUrl);
  } else {
    localStorage.removeItem("videoCloneColabUrl");
    setApiBase("http://127.0.0.1:3900");
  }
  return { ...clean, apiBase: base };
}

function formatApiError(status: number, statusText: string, detail: unknown, path?: string): string {
  const raw = typeof detail === "string" ? detail : "";
  if (status === 404 && raw === "Job not found") {
    return "Phiên làm việc đã hết hạn hoặc backend vừa khởi động lại. Hãy phân tích lại video rồi thử OCR.";
  }
  if (status === 404 && path?.includes("detect-text") && (!raw || raw === "Not Found")) {
    return "Backend chưa có API quét OCR. Hãy đóng hoàn toàn ứng dụng rồi mở lại; nếu dùng bản cài (.exe), chạy lại npm run package:dir để cập nhật backend.";
  }
  if (status === 404 && (!raw || raw === "Not Found")) {
    return `API không tồn tại (${path || "unknown"}). Hãy đóng và mở lại ứng dụng để nạp backend mới.`;
  }
  if (raw) return raw;
  return `${status} ${statusText}`;
}

/** Turn opaque fetch/Electron failures into actionable Vietnamese messages. */
export function formatFetchError(err: unknown, context?: string): Error {
  const raw = err instanceof Error ? err.message : String(err || "unknown");
  const lower = raw.toLowerCase();
  const looksLikeNetwork =
    lower.includes("network error") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("load failed") ||
    lower.includes("connection refused") ||
    lower.includes("econnrefused");
  if (looksLikeNetwork) {
    const prefix = context ? `${context}: ` : "";
    return new Error(
      `${prefix}Không kết nối được backend AI. Hãy đóng và mở lại ứng dụng, ` +
      "kiểm tra cửa sổ Terminal/backend còn chạy, rồi thử lại. " +
      "Nếu dùng trình duyệt (npm run dev), chạy backend tại cổng 3900."
    );
  }
  return err instanceof Error ? err : new Error(raw);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), init);
  } catch (cause) {
    throw formatFetchError(cause, "Yêu cầu API thất bại");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      message = formatApiError(response.status, response.statusText, body.detail || body.error, path);
    } catch { /* use HTTP status */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{
    status: string;
    device: string;
    version?: string;
    features?: {
      ocr_detect?: boolean;
    };
  }>("/health"),
  colabDriveStatus: () => request<{colab_runtime: boolean; drive_ready: boolean; folder_url: string; folder_label: string; export_dir?: string}>("/colab/drive-status"),
  exportToDrive: async (endpoint: string): Promise<DriveExportResult> => {
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await fetch(apiUrl(`${endpoint}${separator}save_to_drive=true`));
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        message = body.detail || body.error || message;
      } catch { /* use HTTP status */ }
      throw new Error(message);
    }
    return response.json() as Promise<DriveExportResult>;
  },
  models: () => request<{models: ModelInfo[]; hf_cache_dir: string; platform_tags?: string[]}>("/models"),
  installModel: (repo_id: string) => request("/models/install", {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({repo_id})
  }),
  upload: (
    file: File,
    jobId: string,
    options?: boolean | { skipDemucs?: boolean; srtMode?: boolean },
  ) => {
    const opts = typeof options === "boolean" ? { skipDemucs: options } : (options ?? {});
    const srtMode = opts.srtMode ?? false;
    const skipDemucs = opts.skipDemucs ?? srtMode;
    const form = new FormData();
    form.set("video", file);
    form.set("job_id", jobId);
    form.set("input_type", "video");
    form.set("skip_demucs", String(skipDemucs));
    form.set("srt_mode", String(srtMode));
    return request<{job_id: string; task_id: string; filename: string}>("/dub/upload", {method: "POST", body: form});
  },
  uploadOverlayLogo: (jobId: string, file: File) => {
    const form = new FormData();
    form.set("logo", file);
    return request<{logo_path: string}>(`/dub/overlay-logo/${jobId}`, {method: "POST", body: form});
  },
  detectVideoTextRegions: (jobId: string, params?: { max_frames?: number; sample_fps?: number }) => {
    const q = new URLSearchParams();
    if (params?.max_frames) q.set("max_frames", String(params.max_frames));
    if (params?.sample_fps) q.set("sample_fps", String(params.sample_fps));
    const qs = q.toString();
    return request<{
      regions: Array<{ x: number; y: number; w: number; h: number }>;
      timed_regions: Array<{ start: number; end: number; x: number; y: number; w: number; h: number }>;
      video_width: number;
      video_height: number;
      frames_analyzed?: number;
      error?: string | null;
    }>(`/dub/detect-text/${jobId}${qs ? `?${qs}` : ""}`, { method: "POST" });
  },
  translate: (jobId: string, segments: Segment[], target: string, provider: string) =>
    request<{translated: {id: string | number; text: string; error?: string}[]}>("/dub/translate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        job_id: jobId,
        target_lang: target,
        provider,
        quality: "fast",
        segments: segments.map((s) => ({
          id: String(s.id), text: s.text_original || s.text, slot_seconds: s.end - s.start
        }))
      })
    }),
  generate: (jobId: string, segments: Segment[], language: string, languageCode: string, timing: string) =>
    request<{task_id: string}>(`/dub/generate/${jobId}`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        language,
        language_code: languageCode,
        timing_strategy: timing,
        num_step: 16,
        guidance_scale: 2,
        speed: 1,
        segment_ids: segments.map((s) => String(s.id)),
        segments: segments.map((s) => ({
          start: s.start, end: s.end, text: s.text, profile_id: s.profile_id || "",
          speed: s.speed || 1, effect_preset: "broadcast"
        }))
      })
    }),
  history: () => request<Array<Record<string, unknown>>>("/dub/history"),

  // Hugging Face settings
  getHfTokenState: () => request<{ active: boolean; sources: any[] }>("/api/settings/hf-token/state"),
  saveHfToken: (token: string) => request<{ active: boolean; sources: any[] }>("/api/settings/hf-token", {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({token})
  }),
  clearHfToken: (alsoClearHfCli: boolean = false) => request<{ active: boolean; sources: any[] }>(`/api/settings/hf-token?also_clear_hf_cli=${alsoClearHfCli}`, {
    method: "DELETE"
  }),

  getLlmEndpoint: () => request<{ base_url: string; model: string; available: boolean; reason?: string }>("/api/settings/llm-endpoint"),
  setLlmEndpoint: (body: { base_url?: string; model?: string; api_key?: string }) =>
    request<{ base_url: string; model: string; available: boolean }>("/api/settings/llm-endpoint", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
  ensureLlamaServer: () =>
    request<{ ok: boolean; reason: string; running: boolean; base_url: string }>("/api/settings/llama-server/ensure", {
      method: "POST"
    }),

  getTranslateCloud: () => request<{
    openai: { api_key_masked?: string; model: string; base_url: string; configured: boolean };
    gemini: { api_key_masked?: string; model: string; base_url: string; configured: boolean };
    deepseek: { api_key_masked?: string; model: string; base_url: string; configured: boolean };
    "9router": { api_key_masked?: string; model: string; base_url: string; configured: boolean };
  }>("/api/settings/translate-cloud"),
  setTranslateCloud: (body: {
    openai?: { api_key?: string; model?: string; base_url?: string };
    gemini?: { api_key?: string; model?: string };
    deepseek?: { api_key?: string; model?: string; base_url?: string };
    "9router"?: { api_key?: string; model?: string; base_url?: string };
  }) =>
    request<{
      openai: { api_key_masked?: string; model: string; base_url: string; configured: boolean };
      gemini: { api_key_masked?: string; model: string; base_url: string; configured: boolean };
      deepseek: { api_key_masked?: string; model: string; base_url: string; configured: boolean };
      "9router": { api_key_masked?: string; model: string; base_url: string; configured: boolean };
    }>("/api/settings/translate-cloud", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
  getTranslateCloudModels: (
    provider: "openai" | "gemini" | "deepseek" | "9router",
    params?: { api_key?: string; base_url?: string }
  ) => {
    const q = new URLSearchParams();
    if (params?.api_key) q.set("api_key", params.api_key);
    if (params?.base_url) q.set("base_url", params.base_url);
    const qs = q.toString();
    return request<{ models: string[]; source: "api" | "fallback"; error: string | null }>(
      `/api/settings/translate-cloud/models/${provider}${qs ? `?${qs}` : ""}`
    );
  },

  // Voice Profiles settings
  getProfiles: () => request<VoiceProfile[]>("/profiles"),
  createProfile: (formData: FormData) => request<VoiceProfile>("/profiles", {
    method: "POST", body: formData
  }),
  updateProfile: (id: string, name: string) => request<VoiceProfile>(`/profiles/${id}`, {
    method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name})
  }),
  deleteProfile: (id: string) => request<{ deleted: string }>(`/profiles/${id}`, {
    method: "DELETE"
  }),
  describeVoice: (description: string) => request<{
    attrs: Record<string, string>;
    instruct: string;
    matched: Array<{ category: string; token: string; phrase: string }>;
    unmatched: string[];
  }>("/design/describe", {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({description})
  }),

  // License settings
  getLicenseStatus: () => request<{activated: boolean}>("/api/license/status"),
  activateLicense: (key: string) => request<{success: boolean; message: string}>("/api/license/activate", {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({key})
  }),

  getAsrEngines: () => request<AsrEnginesResponse>("/engines/asr"),
  selectAsrEngine: (backendId: string, modelRepoId?: string) =>
    request<{family: string; active: string}>(
      "/engines/select",
      {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          family: "asr",
          backend_id: backendId,
          model_repo_id: modelRepoId || null,
        }),
      },
    ),

  // Batch Clone (Clone Hàng loạt) settings
  enqueueLocalBatch: (params: {
    input_dir: string;
    output_dir: string;
    langs: string;
    voice_id?: string;
    translation_provider?: string;
    timing_strategy?: string;
    preserve_bg?: boolean;
  }) => request<{ batch_group_id: string; job_ids: string[]; count: number }>("/batch/enqueue-local", {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(params)
  }),
  getBatchJobs: (batchGroupId: string) => request<any[]>(`/batch/jobs?batch_group_id=${batchGroupId}`),

  createSrtJob: (jobId: string, filename: string, duration: number) =>
    request<{job_id: string}>("/dub/create-srt-job", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({job_id: jobId, filename, duration})
    }),
  importSrt: (jobId: string, file: File) => {
    const form = new FormData();
    form.set("file", file);
    return request<{
      segments: Segment[];
      stats: {
        imported: number;
        skipped_malformed: number;
        dropped_overlap: number;
        clamped_to_duration: number;
      };
    }>(`/dub/import-srt/${jobId}`, {
      method: "POST",
      body: form
    });
  },
  downloadVideoUrl: (url: string, outputDir: string, mp4Only = true) =>
    request<{
      success: boolean;
      id: string;
      title: string;
      path: string;
      filename: string;
      is_folder: boolean;
    }>("/download/video-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, output_dir: outputDir, mp4_only: mp4Only }),
    }),
};

async function consumeSseBody(body: ReadableStream<Uint8Array>, onEvent: (event: Record<string, any>) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const eventName = frame.split("\n").find((line) => line.startsWith("event:"))
        ?.slice(6).trim();
      const data = frame.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()).join("\n");
      if (!data) continue;
      try {
        const payload = JSON.parse(data);
        onEvent(eventName && !payload.type ? {...payload, type: eventName} : payload);
      } catch (cause) {
        if (cause instanceof Error && cause.message !== "Unexpected end of JSON input") {
          throw cause;
        }
        /* heartbeat or non-json frame */
      }
    }
  }
}

export async function readSse(path: string, onEvent: (event: Record<string, any>) => void) {
  let response: Response;
  try {
    response = await fetch(apiUrl(path));
  } catch (cause) {
    throw formatFetchError(cause, "Luồng xử lý SSE bị gián đoạn");
  }
  if (!response.ok || !response.body) throw new Error(`Luồng xử lý không khả dụng (${response.status}).`);
  try {
    await consumeSseBody(response.body, onEvent);
  } catch (cause) {
    throw formatFetchError(cause, "Luồng xử lý SSE bị gián đoạn");
  }
}

/** Open SSE and resolve once connected; events are parsed in the background. */
export async function startSseStream(
  path: string,
  onEvent: (event: Record<string, any>) => void,
): Promise<() => void> {
  const controller = new AbortController();
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { signal: controller.signal });
  } catch (cause) {
    throw formatFetchError(cause, "Luồng xử lý SSE bị gián đoạn");
  }
  if (!response.ok || !response.body) {
    throw new Error(`Luồng xử lý không khả dụng (${response.status}).`);
  }
  void consumeSseBody(response.body, onEvent).catch(() => {
    /* stream closed */
  });
  return () => controller.abort();
}

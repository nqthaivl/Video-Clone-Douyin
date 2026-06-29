import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight, Check, ChevronRight, Clock3, Download, Film, FolderOpen, Gauge,
  HardDrive, Languages, LoaderCircle, Mic2, Play, RefreshCw, Save, Settings, Sparkles, UploadCloud,
  Trash2, Video, WandSparkles, X, BookOpen, Music, FileText, Cloud, Headphones
} from "lucide-react";
import {
  api,
  apiUrl,
  getBackendConfig,
  initApi,
  readSse,
  startSseStream,
  saveBackendConfig,
  setApiBase,
  type BackendConfig,
  type DriveExportResult,
  type ModelInfo,
  type Segment,
  type VoiceProfile,
  type AsrBackendInfo
} from "./lib/api";
import { isDouyinUrl } from "./lib/videoUrl";
import { splitSegmentByTime } from "./lib/segmentSplit";
import { SegmentTimeline } from "./components/SegmentTimeline";
import { SourceVideoPanel } from "./components/SourceVideoPanel";
import {
  PrefKeys,
  readPref,
  writePref,
  readBoolPref,
  writeBoolPref,
  exportAudioQueryParams,
  exportAudioModeLabel,
  type ExportAudioMode,
} from "./lib/prefs";
import {
  buildAsrSelectOptions,
  decodeAsrSelection,
  encodeAsrSelection,
  pickAsrSelection,
  resolveAsrBackend,
  routeAsrRepo,
} from "./lib/asr_routing";
import {
  previewSubtitleFontPx as computePreviewSubtitleFontPx,
  previewSubtitlePadPx as computePreviewSubtitlePadPx,
  SUBTITLE_FONT_OPTIONS,
  subtitleBoxHeightNorm,
  videoExportPolishParams,
} from "./lib/export_polish";

const LANGUAGES = [
  ["vi", "Vietnamese", "Tiếng Việt"], ["en", "English", "Tiếng Anh"],
  ["zh", "Chinese", "Tiếng Trung"], ["ja", "Japanese", "Tiếng Nhật"],
  ["ko", "Korean", "Tiếng Hàn"], ["fr", "French", "Tiếng Pháp"],
  ["de", "German", "Tiếng Đức"], ["es", "Spanish", "Tiếng Tây Ban Nha"],
  ["pt", "Portuguese", "Tiếng Bồ Đào Nha"], ["it", "Italian", "Tiếng Ý"],
  ["ru", "Russian", "Tiếng Nga"], ["th", "Thai", "Tiếng Thái"],
  ["id", "Indonesian", "Tiếng Indonesia"], ["hi", "Hindi", "Tiếng Hindi"],
  ["ar", "Arabic", "Tiếng Ả Rập"]
] as const;

const LLAMA_CPP_PREFIX = "llama_cpp:";
const MARIAN_ZH_VI_REPO = "Helsinki-NLP/opus-mt-zh-vi";
const NLLB_1_3B_REPO = "facebook/nllb-200-distilled-1.3B";

function llamaCppProviderValue(repoId: string) {
  return `${LLAMA_CPP_PREFIX}${repoId}`;
}

function parseTranslateProvider(value: string) {
  if (value.startsWith(LLAMA_CPP_PREFIX)) {
    return { apiProvider: "llama_cpp", llamaModelId: value.slice(LLAMA_CPP_PREFIX.length) };
  }
  return { apiProvider: value, llamaModelId: undefined as string | undefined };
}

type Stage = "idle" | "preparing" | "transcribing" | "editing" | "translating" | "generating" | "done";

type BlurRegion = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  start?: number;
  end?: number;
};

function blurRegionVisible(region: BlurRegion, time: number) {
  if (region.start == null || region.end == null) return true;
  return time >= region.start && time <= region.end;
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fitVideoStageStyle(ratio: number) {
  const landscape = ratio >= 1;
  return {
    aspectRatio: String(ratio),
    width: landscape ? "100%" : "auto",
    height: landscape ? "auto" : "100%",
    maxWidth: "100%",
    maxHeight: "100%"
  };
}

function clamp01(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function newJobId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function installProgressPercent(event: Record<string, any>): number | undefined {
  if (typeof event.overall_pct === "number") {
    return event.overall_pct <= 1 ? event.overall_pct * 100 : event.overall_pct;
  }
  if (typeof event.total_bytes === "number" && event.total_bytes > 0 && typeof event.bytes_done === "number") {
    return (event.bytes_done / event.total_bytes) * 100;
  }
  if (typeof event.files_total === "number" && event.files_total > 0 && typeof event.files_done === "number") {
    return (event.files_done / event.files_total) * 100;
  }
  if (typeof event.pct === "number" && event.phase !== "resolving") {
    return event.pct <= 1 ? event.pct * 100 : event.pct;
  }
  if (event.phase === "resolving") {
    const step = typeof event.step === "number" ? event.step : 1;
    return Math.min(5, step * 0.8);
  }
  if (event.phase === "install_start") {
    return 1;
  }
  return undefined;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [device, setDevice] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [cacheDir, setCacheDir] = useState("");
  const [installing, setInstalling] = useState("");
  const [installProgress, setInstallProgress] = useState(0);
  const [stage, setStage] = useState<Stage>("idle");
  const [stageLabel, setStageLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [jobId, setJobId] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [languageCode, setLanguageCode] = useState(() => readPref(PrefKeys.targetLanguage, "vi"));
  const [provider, setProvider] = useState(() => readPref(PrefKeys.translateProvider, "google"));
  const [timing, setTiming] = useState(() => readPref(PrefKeys.dubTiming, "concise"));
  const [tracks, setTracks] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const overlayStageRef = useRef<HTMLDivElement>(null);
  const editPreviewStageRef = useRef<HTMLDivElement>(null);
  const logoFileRef = useRef<HTMLInputElement>(null);
  const [burnVideoSubs, setBurnVideoSubs] = useState(false);
  const [subtitlePos, setSubtitlePos] = useState({ x: 0.12, y: 0.8, w: 0.76 });
  const [videoRatio, setVideoRatio] = useState<number>(16 / 9);
  const [srtVideoRatio, setSrtVideoRatio] = useState<number>(16 / 9);
  const [videoTime, setVideoTime] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [srtVideoTime, setSrtVideoTime] = useState(0);
  const [srtVideoPlaying, setSrtVideoPlaying] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [blurExistingSubs, setBlurExistingSubs] = useState(false);
  const [blurBox, setBlurBox] = useState({ x: 0.12, y: 0.78, w: 0.76, h: 0.14 });
  const [logoOverlayEnabled, setLogoOverlayEnabled] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState("");
  const [logoBox, setLogoBox] = useState({ x: 0.78, y: 0.08, w: 0.16, h: 0.09 });
  const [logoAspect, setLogoAspect] = useState(1);
  const [subtitleFontSize, setSubtitleFontSize] = useState(42);
  const [subtitleColor, setSubtitleColor] = useState("#ffffff");
  const [subtitleBgColor, setSubtitleBgColor] = useState("#000000");
  const [subtitleBgTransparent, setSubtitleBgTransparent] = useState(() =>
    readBoolPref(PrefKeys.exportSubBgTransparent, false),
  );
  const [subtitleFontFamily, setSubtitleFontFamily] = useState(() =>
    readPref(PrefKeys.exportSubFontFamily, "Arial"),
  );
  const [bgVolume, setBgVolume] = useState(() => Number(readPref(PrefKeys.exportBgVolume, "80")) || 80);
  const [dubVolume, setDubVolume] = useState(() => Number(readPref(PrefKeys.exportDubVolume, "120")) || 120);
  const [videoNativeSize, setVideoNativeSize] = useState({ width: 1080, height: 1920 });
  const [stageDisplaySize, setStageDisplaySize] = useState({ width: 0, height: 0 });
  const [editStageDisplaySize, setEditStageDisplaySize] = useState({ width: 0, height: 0 });
  const [ocrScanning, setOcrScanning] = useState(false);
  const [blurRegions, setBlurRegions] = useState<BlurRegion[]>([{ id: "blur-1", x: 0.12, y: 0.78, w: 0.76, h: 0.14 }]);
  const [activeBlurRegionId, setActiveBlurRegionId] = useState("blur-1");
  const [subtitleOverlayActive, setSubtitleOverlayActive] = useState(true);
  const [dubPreviewOpen, setDubPreviewOpen] = useState(false);
  const [editPreviewTime, setEditPreviewTime] = useState(0);
  const [editPreviewPlaying, setEditPreviewPlaying] = useState(false);
  const [sourceLanguageCode, setSourceLanguageCode] = useState(() => readPref(PrefKeys.sourceLanguage, "auto"));
  const [asrSelection, setAsrSelection] = useState(() =>
    encodeAsrSelection(
      readPref(PrefKeys.asrBackend, "whisperx"),
      readPref(PrefKeys.asrModelRepo, ""),
    ),
  );
  const [asrBackends, setAsrBackends] = useState<AsrBackendInfo[]>([]);
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const segmentListRef = useRef<HTMLDivElement>(null);

  // States for Clone Phim (SRT-based dubbing)
  const [srtFile, setSrtFile] = useState<File | null>(null);
  const [srtVideoFile, setSrtVideoFile] = useState<File | null>(null);
  const [srtSegments, setSrtSegments] = useState<Segment[]>([]);
  const [srtSelectedId, setSrtSelectedId] = useState<string | null>(null);
  const [srtStage, setSrtStage] = useState<"idle" | "preparing" | "editing" | "translating" | "generating" | "done">("idle");
  const [srtPrepProgress, setSrtPrepProgress] = useState(0);
  const [srtPrepLabel, setSrtPrepLabel] = useState("");
  const [srtError, setSrtError] = useState("");
  const [srtJobId, setSrtJobId] = useState("");
  const [srtLanguageCode, setSrtLanguageCode] = useState(() => readPref(PrefKeys.srtTargetLanguage, "vi"));
  const [srtProvider, setSrtProvider] = useState(() => readPref(PrefKeys.translateProvider, "google"));
  const [srtVoiceId, setSrtVoiceId] = useState(() => readPref(PrefKeys.srtVoiceId, ""));
  const [srtBurnSubs, setSrtBurnSubs] = useState(false);
  const [srtOutFormat, setSrtOutFormat] = useState("wav");
  const [exportAudioMode, setExportAudioMode] = useState<ExportAudioMode>(() => {
    const saved = readPref(PrefKeys.exportAudioMode, "dub_with_bg");
    if (saved === "dub_only" || saved === "dub_with_bg" || saved === "dub_with_original") {
      return saved;
    }
    return "dub_with_bg";
  });
  const [srtTiming, setSrtTiming] = useState(() => readPref(PrefKeys.srtTiming, "strict_slot"));
  const [srtVideoPreviewUrl, setSrtVideoPreviewUrl] = useState("");
  const [srtProgressCurrent, setSrtProgressCurrent] = useState(0);
  const [srtProgressTotal, setSrtProgressTotal] = useState(0);
  const [srtProgressText, setSrtProgressText] = useState("");
  const [srtTracks, setSrtTracks] = useState<string[]>([]);
  const srtSrtFileRef = useRef<HTMLInputElement>(null);
  const srtVideoFileRef = useRef<HTMLInputElement>(null);
  const srtSegmentListRef = useRef<HTMLDivElement>(null);

  // New states for voice management and HF token
  const [activeMainTab, setActiveMainTab] = useState<"clone" | "srt_dub" | "douyin_download" | "batch" | "config" | "guide">("clone");
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  
  // States for Douyin Download Tab
  const [dyUrl, setDyUrl] = useState("");
  const [dyDownloadDir, setDyDownloadDir] = useState(localStorage.getItem("dyDownloadDir") || "");
  const [dyOnlyMp4, setDyOnlyMp4] = useState(false);
  const [dyIsUser, setDyIsUser] = useState(false);
  const [dyIsDownloading, setDyIsDownloading] = useState(false);
  const [dyDownloadedCount, setDyDownloadedCount] = useState(0);
  const [dyTotalCount, setDyTotalCount] = useState(0);
  const [dyStatusText, setDyStatusText] = useState("");
  const [dyStatusType, setDyStatusType] = useState("");
  const [dyError, setDyError] = useState("");
  const [dyDownloadedItems, setDyDownloadedItems] = useState<Array<{ id: string; title: string; path: string; isFolder: boolean }>>([]);
  const [hfActive, setHfActive] = useState(false);
  const [hfToken, setHfToken] = useState("");
  const [showHfToken, setShowHfToken] = useState(false);
  const [hfStatusText, setHfStatusText] = useState("");
  const [translateCloud, setTranslateCloud] = useState({
    openai: { model: "gpt-4o-mini", base_url: "", configured: false, api_key_masked: "" as string | undefined },
    gemini: { model: "gemini-2.0-flash", base_url: "", configured: false, api_key_masked: "" as string | undefined },
    deepseek: { model: "deepseek-chat", base_url: "", configured: false, api_key_masked: "" as string | undefined },
    "9router": { model: "", base_url: "http://localhost:20128/v1", configured: false, api_key_masked: "" as string | undefined }
  });
  const [openaiTranslateKey, setOpenaiTranslateKey] = useState("");
  const [openaiTranslateModel, setOpenaiTranslateModel] = useState("gpt-4o-mini");
  const [openaiTranslateBaseUrl, setOpenaiTranslateBaseUrl] = useState("");
  const [geminiTranslateKey, setGeminiTranslateKey] = useState("");
  const [geminiTranslateModel, setGeminiTranslateModel] = useState("gemini-2.0-flash");
  const [deepseekTranslateKey, setDeepseekTranslateKey] = useState("");
  const [deepseekTranslateModel, setDeepseekTranslateModel] = useState("deepseek-chat");
  const [deepseekTranslateBaseUrl, setDeepseekTranslateBaseUrl] = useState("");
  const [ninerouterTranslateKey, setNinerouterTranslateKey] = useState("");
  const [ninerouterTranslateModel, setNinerouterTranslateModel] = useState("");
  const [ninerouterTranslateBaseUrl, setNinerouterTranslateBaseUrl] = useState("http://localhost:20128/v1");
  const [savingTranslateCloud, setSavingTranslateCloud] = useState(false);
  const [openaiModelOptions, setOpenaiModelOptions] = useState<string[]>([]);
  const [geminiModelOptions, setGeminiModelOptions] = useState<string[]>([]);
  const [deepseekModelOptions, setDeepseekModelOptions] = useState<string[]>([]);
  const [ninerouterModelOptions, setNinerouterModelOptions] = useState<string[]>([]);
  const [openaiModelsSource, setOpenaiModelsSource] = useState<"api" | "fallback" | "">("");
  const [geminiModelsSource, setGeminiModelsSource] = useState<"api" | "fallback" | "">("");
  const [deepseekModelsSource, setDeepseekModelsSource] = useState<"api" | "fallback" | "">("");
  const [ninerouterModelsSource, setNinerouterModelsSource] = useState<"api" | "fallback" | "">("");
  const [openaiModelsError, setOpenaiModelsError] = useState("");
  const [geminiModelsError, setGeminiModelsError] = useState("");
  const [deepseekModelsError, setDeepseekModelsError] = useState("");
  const [ninerouterModelsError, setNinerouterModelsError] = useState("");
  const [loadingOpenaiModels, setLoadingOpenaiModels] = useState(false);
  const [loadingGeminiModels, setLoadingGeminiModels] = useState(false);
  const [loadingDeepseekModels, setLoadingDeepseekModels] = useState(false);
  const [loadingNinerouterModels, setLoadingNinerouterModels] = useState(false);
  const [douyinCookie, setDouyinCookie] = useState("");
  const [settingsTab, setSettingsTab] = useState<"general" | "colab" | "hf_token" | "translate_api" | "voice_profiles" | "models" | "translate_models" | "douyin">("general");
  const [deletingModel, setDeletingModel] = useState("");
  const [defaultSaveDir, setDefaultSaveDir] = useState<string>(localStorage.getItem("defaultSaveDir") || "");
  const [autoSave, setAutoSave] = useState<boolean>(localStorage.getItem("autoSave") === "true");
  const [newVoiceName, setNewVoiceName] = useState("");
  const [newVoiceFile, setNewVoiceFile] = useState<File | null>(null);
  const [isCloning, setIsCloning] = useState(false);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<"clone" | "design">("clone");
  const [voiceDescription, setVoiceDescription] = useState("");
  const [isDesigning, setIsDesigning] = useState(false);

  // States for Batch Clone (Clone Hàng loạt)
  const [batchInputDir, setBatchInputDir] = useState(localStorage.getItem("batchInputDir") || "");
  const [batchOutputDir, setBatchOutputDir] = useState(localStorage.getItem("batchOutputDir") || "");
  const [batchLanguageCode, setBatchLanguageCode] = useState(() => readPref(PrefKeys.batchTargetLanguage, "vi"));
  const [batchProvider, setBatchProvider] = useState(() => readPref(PrefKeys.translateProvider, "google"));
  const [batchVoiceId, setBatchVoiceId] = useState(() => readPref(PrefKeys.batchVoiceId, ""));
  const [batchTiming, setBatchTiming] = useState(localStorage.getItem("batchTiming") || "concise");
  const [batchGroupId, setBatchGroupId] = useState(localStorage.getItem("batchGroupId") || "");
  const [batchJobs, setBatchJobs] = useState<any[]>([]);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchError, setBatchError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [defaultVoiceId, setDefaultVoiceId] = useState<string>(() => readPref(PrefKeys.defaultVoiceId, ""));

  const [platformTags, setPlatformTags] = useState<string[]>([]);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportPercent, setExportPercent] = useState(0);
  const [exportModalStatus, setExportModalStatus] = useState("");
  const [exportSuccess, setExportSuccess] = useState(false);
  const [driveExportResult, setDriveExportResult] = useState<DriveExportResult | null>(null);
  const [isActivated, setIsActivated] = useState<boolean | null>(null);
  const [machineId, setMachineId] = useState("");
  const [licenseKeyInput, setLicenseKeyInput] = useState("");
  const [activationError, setActivationError] = useState("");
  const [isActivating, setIsActivating] = useState(false);
  const [backendConfig, setBackendConfig] = useState<BackendConfig>({ backendMode: "local", colabUrl: "" });
  const [colabUrlInput, setColabUrlInput] = useState("");
  const [colabStatus, setColabStatus] = useState("");
  const [testingColab, setTestingColab] = useState(false);
  const [savingBackendConfig, setSavingBackendConfig] = useState(false);
  const [colabSessionReady, setColabSessionReady] = useState(false);
  const colabNotebookUrl = "https://colab.research.google.com/github/nqthaivl/videocolab/blob/main/Video_Clone_Douyin_Colab.ipynb";
  const isColabBackend = backendConfig.backendMode === "colab";

  function openExternalUrl(url: string) {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const requiredRepos = useMemo(() => {
    const isMacArm = platformTags.includes("darwin-arm64");
    if (isMacArm) {
      return new Set(["k2-fsa/OmniVoice", "mlx-community/whisper-large-v3-mlx"]);
    } else {
      return new Set(["k2-fsa/OmniVoice", "Systran/faster-whisper-large-v3"]);
    }
  }, [platformTags]);

  const requiredModels = useMemo(
    () => models.filter((model) => requiredRepos.has(model.repo_id)),
    [models, requiredRepos]
  );
  const llamaCppModels = useMemo(
    () => models.filter((model) => model.role === "Translation" && model.engine === "llama_cpp"),
    [models]
  );
  const installedLlamaCppModels = useMemo(
    () => llamaCppModels.filter((model) => model.installed),
    [llamaCppModels]
  );
  const translationModels = useMemo(
    () => models.filter((model) => model.role === "Translation"),
    [models]
  );
  const marianInstalled = useMemo(
    () => translationModels.some((model) => model.repo_id === MARIAN_ZH_VI_REPO && model.installed),
    [translationModels]
  );
  const nllb1_3bInstalled = useMemo(
    () => translationModels.some((model) => model.repo_id === NLLB_1_3B_REPO && model.installed),
    [translationModels]
  );
  const asrSelectOptions = useMemo(
    () => buildAsrSelectOptions(models, asrBackends),
    [models, asrBackends],
  );
  const localModelsInstalled = requiredModels.length === 2 && requiredModels.every((model) => model.installed);
  const showStartupSetup = backendConfig.backendMode === "colab" ? !colabSessionReady : !localModelsInstalled;
  const selected = segments.find((segment) => String(segment.id) === selectedId) || segments[0];
  const language = LANGUAGES.find(([code]) => code === languageCode) || LANGUAGES[0];
  const hasDubbedTracks = tracks.length > 0;

  const previewVideoUrl = useMemo(() => {
    if (!jobId) return previewUrl;
    if (hasDubbedTracks) {
      const audioParams = exportAudioQueryParams(exportAudioMode, languageCode);
      const params = new URLSearchParams({
        lang: languageCode,
        preserve_bg: audioParams.preserve_bg,
        bg_volume: String(bgVolume),
        dub_volume: String(dubVolume),
        v: String(previewVersion),
      });
      if (audioParams.mix_original) {
        params.set("mix_original", "true");
      }
      return apiUrl(`/dub/preview-video/${jobId}?${params.toString()}`);
    }
    return previewUrl;
  }, [jobId, hasDubbedTracks, languageCode, previewUrl, previewVersion, exportAudioMode, bgVolume, dubVolume]);

  const srtPreviewVideoUrl = useMemo(() => {
    if (!srtJobId || srtStage !== "done") return srtVideoPreviewUrl;
    const audioParams = exportAudioQueryParams(exportAudioMode, srtLanguageCode);
    const params = new URLSearchParams({
      lang: srtLanguageCode,
      preserve_bg: audioParams.preserve_bg,
      bg_volume: String(bgVolume),
      dub_volume: String(dubVolume),
      v: String(previewVersion),
      ...(audioParams.mix_original ? { mix_original: "true" } : {}),
    });
    return apiUrl(`/dub/preview-video/${srtJobId}?${params.toString()}`);
  }, [srtJobId, srtStage, srtLanguageCode, srtVideoPreviewUrl, previewVersion, exportAudioMode, bgVolume, dubVolume]);

  const subtitleTextAtTime = useCallback((time: number, playing: boolean) => {
    if (time > 0) {
      const activeSeg = segments.find((seg) => time >= seg.start && time <= seg.end);
      if (activeSeg) return activeSeg.text || activeSeg.text_original || "";
      if (playing) return "";
    }
    return selected?.text || selected?.text_original || "";
  }, [segments, selected]);

  const currentSubtitleText = useMemo(
    () => subtitleTextAtTime(videoTime, videoPlaying),
    [subtitleTextAtTime, videoTime, videoPlaying]
  );

  const previewSubtitleFontPx = useMemo(
    () => computePreviewSubtitleFontPx(subtitleFontSize, videoNativeSize.height, stageDisplaySize.height),
    [subtitleFontSize, videoNativeSize.height, stageDisplaySize.height]
  );

  const previewSubtitlePad = useMemo(
    () => computePreviewSubtitlePadPx(videoNativeSize.height, stageDisplaySize.height),
    [videoNativeSize.height, stageDisplaySize.height]
  );

  const subtitleHeightNorm = useMemo(
    () => subtitleBoxHeightNorm(subtitleFontSize, videoNativeSize.height),
    [subtitleFontSize, videoNativeSize.height],
  );

  const subtitleBox = useMemo(
    () => ({
      ...subtitlePos,
      h: subtitleHeightNorm,
      y: clamp01(subtitlePos.y, 0, Math.max(0, 1 - subtitleHeightNorm)),
    }),
    [subtitlePos, subtitleHeightNorm],
  );

  const editPreviewSubtitleFontPx = useMemo(
    () => computePreviewSubtitleFontPx(subtitleFontSize, videoNativeSize.height, editStageDisplaySize.height),
    [subtitleFontSize, videoNativeSize.height, editStageDisplaySize.height]
  );

  const editPreviewSubtitleText = useMemo(
    () => subtitleTextAtTime(editPreviewTime, editPreviewPlaying),
    [subtitleTextAtTime, editPreviewTime, editPreviewPlaying]
  );

  const currentSrtSubtitleText = useMemo(() => {
    if (srtVideoTime > 0) {
      const activeSeg = srtSegments.find(
        (seg) => srtVideoTime >= seg.start && srtVideoTime <= seg.end
      );
      if (activeSeg) {
        return activeSeg.text || activeSeg.text_original || "";
      }
      if (srtVideoPlaying) {
        return "";
      }
    }
    const srtSelected = srtSegments.find((seg) => String(seg.id) === srtSelectedId) || srtSegments[0];
    return srtSelected?.text || srtSelected?.text_original || "";
  }, [srtVideoTime, srtVideoPlaying, srtSegments, srtSelectedId]);

  const overlaySubtitleText = selected?.text || selected?.text_original || "Phu de mau";

  const updateOverlayDrag = (kind: "subtitle" | "blur" | "logo", clientX: number, clientY: number) => {
    const rect = overlayStageRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const nx = clamp01((clientX - rect.left) / rect.width);
    const ny = clamp01((clientY - rect.top) / rect.height);
    if (kind === "blur") setBlurBox((box) => ({ ...box, x: clamp01(nx - box.w / 2, 0, 1 - box.w), y: clamp01(ny - box.h / 2, 0, 1 - box.h) }));
    else setLogoBox((box) => ({ ...box, x: clamp01(nx - box.w / 2, 0, 1 - box.w), y: clamp01(ny - box.w / 2, 0, 0.96) }));
  };

  const startOverlayDrag = (kind: "blur" | "logo") => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    updateOverlayDrag(kind, event.clientX, event.clientY);
    const move = (moveEvent: PointerEvent) => updateOverlayDrag(kind, moveEvent.clientX, moveEvent.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startSubtitleDrag = (stageRef?: React.RefObject<HTMLDivElement | null>) => (event: React.PointerEvent) => {
    const rect = (stageRef?.current || overlayStageRef.current)?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    setSubtitleOverlayActive(true);
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...subtitleBox };
    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - startX) / rect.width;
      const dy = (moveEvent.clientY - startY) / rect.height;
      setSubtitlePos((pos) => ({
        ...pos,
        x: clamp01(start.x + dx, 0, 1 - start.w),
        y: clamp01(start.y + dy, 0, 1 - start.h),
      }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const addBlurRegion = () => {
    const id = "blur-" + Date.now();
    setBlurRegions((current) => [...current, { id, x: 0.18, y: 0.72, w: 0.64, h: 0.14 }]);
    setActiveBlurRegionId(id);
    setBlurExistingSubs(true);
  };

  const fetchOcrBlurRegions = useCallback(async (targetJobId: string) => {
    const res = await api.detectVideoTextRegions(targetJobId, { max_frames: 40, sample_fps: 1 });
    if (res.video_width && res.video_height) {
      setVideoNativeSize({ width: res.video_width, height: res.video_height });
      setVideoRatio(res.video_width / res.video_height);
    }
    if (!res.timed_regions?.length) {
      return { ok: false as const, message: res.error || "Không phát hiện vùng chữ trên video." };
    }
    const regions: BlurRegion[] = res.timed_regions.map((region, index) => ({
      id: `blur-ocr-${Date.now()}-${index}`,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
      start: region.start,
      end: region.end,
    }));
    return { ok: true as const, regions };
  }, []);

  const runOcrBlurDetect = async () => {
    if (!jobId) {
      alert("Chưa có video để quét.");
      return;
    }
    setOcrScanning(true);
    try {
      await initApi();
      const health = await api.health();
      if (health.features?.ocr_detect === false) {
        throw new Error(
          "Backend hiện tại không hỗ trợ OCR. Hãy đóng hoàn toàn ứng dụng rồi mở lại để nạp backend mới."
        );
      }
      const result = await fetchOcrBlurRegions(jobId);
      if (!result.ok) {
        alert(result.message);
        return;
      }
      setBlurRegions(result.regions);
      setActiveBlurRegionId(result.regions[0]?.id || "");
      setBlurExistingSubs(true);
    } catch (e: any) {
      alert(e?.message || "Không thể quét OCR trên video.");
    } finally {
      setOcrScanning(false);
    }
  };

  useEffect(() => {
    const el = overlayStageRef.current;
    if (!el || stage !== "done") return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setStageDisplaySize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [stage, videoRatio, previewVideoUrl]);

  useEffect(() => {
    const el = editPreviewStageRef.current;
    if (!el || !dubPreviewOpen) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setEditStageDisplaySize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [dubPreviewOpen, videoRatio, previewVideoUrl]);

  const removeBlurRegion = (id: string) => {
    setBlurRegions((current) => {
      const next = current.filter((region) => region.id !== id);
      if (activeBlurRegionId === id) setActiveBlurRegionId(next[0]?.id || "");
      return next;
    });
  };

  const startBlurRegionDrag = (id: string, mode: "move" | "resize") => (event: React.PointerEvent) => {
    const rect = overlayStageRef.current?.getBoundingClientRect();
    const region = blurRegions.find((item) => item.id === id);
    if (!rect || !region) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveBlurRegionId(id);
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...region };
    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - startX) / rect.width;
      const dy = (moveEvent.clientY - startY) / rect.height;
      setBlurRegions((current) => current.map((item) => {
        if (item.id !== id) return item;
        if (mode === "resize") {
          const w = clamp01(start.w + dx, 0.04, 1 - start.x);
          const h = clamp01(start.h + dy, 0.04, 1 - start.y);
          return { ...item, w, h };
        }
        return { ...item, x: clamp01(start.x + dx, 0, 1 - start.w), y: clamp01(start.y + dy, 0, 1 - start.h) };
      }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startLogoDrag = (mode: "move" | "resize") => (event: React.PointerEvent) => {
    const rect = overlayStageRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...logoBox };
    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - startX) / rect.width;
      const dy = (moveEvent.clientY - startY) / rect.height;
      if (mode === "resize") {
        const newW = clamp01(start.w + dx, 0.04, 0.55);
        const newH = clamp01((newW * videoRatio) / logoAspect, 0.04, 0.55);
        setLogoBox({ ...start, w: newW, h: newH });
      } else {
        setLogoBox((box) => ({
          ...box,
          x: clamp01(start.x + dx, 0, 1 - start.w),
          y: clamp01(start.y + dy, 0, 1 - start.h)
        }));
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useEffect(() => {
    if (!logoFile) {
      setLogoPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(logoFile);
    setLogoPreviewUrl(url);
    const img = new Image();
    img.onload = () => {
      const aspect = img.naturalWidth / img.naturalHeight || 1;
      setLogoAspect(aspect);
      setLogoBox((box) => ({
        ...box,
        h: clamp01((box.w * videoRatio) / aspect, 0.04, 0.55)
      }));
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [logoFile, videoRatio]);

  useEffect(() => {
    setLogoBox((box) => ({
      ...box,
      h: clamp01((box.w * videoRatio) / logoAspect, 0.04, 0.55)
    }));
  }, [videoRatio, logoAspect]);

  const refreshModels = useCallback(async () => {
    const result = await api.models();
    setModels(result.models);
    setCacheDir(result.hf_cache_dir);
    if (result.platform_tags) {
      setPlatformTags(result.platform_tags);
    }
    return result.models;
  }, []);

  const applyLlamaCppModel = useCallback(async (model: ModelInfo) => {
    if (model.llama_model) {
      try {
        await api.setLlmEndpoint({
          base_url: "http://127.0.0.1:8080/v1",
          model: model.llama_model,
          api_key: ""
        });
      } catch (err) {
        console.error("Failed to persist llama.cpp model:", err);
      }
    }
  }, []);

  const selectTranslateProvider = useCallback((value: string) => {
    writePref(PrefKeys.translateProvider, value);
    setProvider(value);
    setSrtProvider(value);
    setBatchProvider(value);
    const { llamaModelId } = parseTranslateProvider(value);
    if (llamaModelId) {
      const model = llamaCppModels.find((item) => item.repo_id === llamaModelId);
      if (model) void applyLlamaCppModel(model);
    }
  }, [llamaCppModels, applyLlamaCppModel]);

  const ensureTranslateProvider = useCallback(async (value: string) => {
    const { apiProvider, llamaModelId } = parseTranslateProvider(value);
    if (apiProvider === "llama_cpp") {
      if (!llamaModelId) {
        throw new Error("Chưa chọn model llama.cpp. Tải model tại Cấu hình → Model dịch.");
      }
      const model = llamaCppModels.find((item) => item.repo_id === llamaModelId);
      if (!model?.installed) {
        throw new Error(`Model "${model?.label || llamaModelId}" chưa được tải. Vào Cấu hình → Model dịch để tải về.`);
      }
      await applyLlamaCppModel(model);
      await api.ensureLlamaServer();
    }
    if (apiProvider === "openai" && !translateCloud.openai.configured) {
      throw new Error("Chưa cấu hình OpenAI API. Vào Cấu hình → API dịch cloud.");
    }
    if (apiProvider === "gemini" && !translateCloud.gemini.configured) {
      throw new Error("Chưa cấu hình Google Gemini API. Vào Cấu hình → API dịch cloud.");
    }
    if (apiProvider === "deepseek" && !translateCloud.deepseek.configured) {
      throw new Error("Chưa cấu hình DeepSeek API. Vào Cấu hình → API dịch cloud.");
    }
    if (apiProvider === "9router" && !translateCloud["9router"].configured) {
      throw new Error("Chưa cấu hình 9Router. Vào Cấu hình → API dịch cloud.");
    }
    return apiProvider;
  }, [llamaCppModels, applyLlamaCppModel, translateCloud]);

  useEffect(() => {
    const saved = readPref(PrefKeys.translateProvider, "google");
    const legacyModelId = localStorage.getItem("llamaCppModelId");
    if (saved === "llama_cpp" && legacyModelId) {
      selectTranslateProvider(llamaCppProviderValue(legacyModelId));
      localStorage.removeItem("llamaCppModelId");
      return;
    }
    if (saved?.startsWith(LLAMA_CPP_PREFIX)) {
      const modelId = saved.slice(LLAMA_CPP_PREFIX.length);
      const model = llamaCppModels.find((item) => item.repo_id === modelId);
      if (model?.installed) {
        void applyLlamaCppModel(model);
      }
    }
  }, [llamaCppModels, applyLlamaCppModel, selectTranslateProvider]);

  useEffect(() => {
    const saved = readPref(PrefKeys.translateProvider, "google");
    if (!saved.startsWith(LLAMA_CPP_PREFIX)) return;
    const modelId = saved.slice(LLAMA_CPP_PREFIX.length);
    const stillInstalled = installedLlamaCppModels.some((model) => model.repo_id === modelId);
    if (!stillInstalled) {
      selectTranslateProvider("google");
    }
  }, [installedLlamaCppModels, selectTranslateProvider]);

  useEffect(() => {
    const saved = readPref(PrefKeys.translateProvider, "google");
    if (saved === "marian_zh_vi" && !marianInstalled) {
      selectTranslateProvider("google");
    }
    if (saved === "nllb_1_3b" && !nllb1_3bInstalled) {
      selectTranslateProvider("google");
    }
    if (saved === "openai" && !translateCloud.openai.configured) {
      selectTranslateProvider("google");
    }
    if (saved === "gemini" && !translateCloud.gemini.configured) {
      selectTranslateProvider("google");
    }
    if (saved === "deepseek" && !translateCloud.deepseek.configured) {
      selectTranslateProvider("google");
    }
    if (saved === "9router" && !translateCloud["9router"].configured) {
      selectTranslateProvider("google");
    }
  }, [marianInstalled, nllb1_3bInstalled, translateCloud, selectTranslateProvider]);

  const refreshHfTokenState = useCallback(async () => {
    try {
      const res = await api.getHfTokenState();
      setHfActive(res.active);
      const appSource = res.sources.find((s: any) => s.name === "App (SQLite)");
      if (appSource?.masked) {
        setHfStatusText(`Đã thiết lập (${appSource.masked})`);
      } else if (res.active) {
        const activeSource = res.sources.find((s: any) => s.active);
        setHfStatusText(`Sử dụng từ ${activeSource ? activeSource.name : "hệ thống"}`);
      } else {
        setHfStatusText("Chưa cấu hình");
      }
    } catch {
      setHfStatusText("Không thể kiểm tra");
    }
  }, []);

  const withCurrentModel = (models: string[], current: string) => {
    const trimmed = current.trim();
    if (trimmed && !models.includes(trimmed)) return [trimmed, ...models];
    return models.length ? models : trimmed ? [trimmed] : models;
  };

  const fetchOpenaiTranslateModels = useCallback(async (opts?: { apiKey?: string; baseUrl?: string; currentModel?: string }) => {
    setLoadingOpenaiModels(true);
    try {
      const res = await api.getTranslateCloudModels("openai", {
        api_key: opts?.apiKey?.trim() || undefined,
        base_url: opts?.baseUrl?.trim() || undefined
      });
      const current = opts?.currentModel?.trim() || "gpt-4o-mini";
      setOpenaiModelOptions(withCurrentModel(res.models, current));
      setOpenaiModelsSource(res.source);
      setOpenaiModelsError(res.error || "");
    } catch (e: any) {
      setOpenaiModelsError(e?.message || "Không thể tải danh sách model OpenAI.");
    } finally {
      setLoadingOpenaiModels(false);
    }
  }, []);

  const fetchGeminiTranslateModels = useCallback(async (opts?: { apiKey?: string; currentModel?: string }) => {
    setLoadingGeminiModels(true);
    try {
      const res = await api.getTranslateCloudModels("gemini", {
        api_key: opts?.apiKey?.trim() || undefined
      });
      const current = opts?.currentModel?.trim() || "gemini-2.0-flash";
      setGeminiModelOptions(withCurrentModel(res.models, current));
      setGeminiModelsSource(res.source);
      setGeminiModelsError(res.error || "");
    } catch (e: any) {
      setGeminiModelsError(e?.message || "Không thể tải danh sách model Gemini.");
    } finally {
      setLoadingGeminiModels(false);
    }
  }, []);

  const fetchDeepseekTranslateModels = useCallback(async (opts?: { apiKey?: string; baseUrl?: string; currentModel?: string }) => {
    setLoadingDeepseekModels(true);
    try {
      const res = await api.getTranslateCloudModels("deepseek", {
        api_key: opts?.apiKey?.trim() || undefined,
        base_url: opts?.baseUrl?.trim() || undefined
      });
      const current = opts?.currentModel?.trim() || "deepseek-chat";
      setDeepseekModelOptions(withCurrentModel(res.models, current));
      setDeepseekModelsSource(res.source);
      setDeepseekModelsError(res.error || "");
    } catch (e: any) {
      setDeepseekModelsError(e?.message || "Không thể tải danh sách model DeepSeek.");
    } finally {
      setLoadingDeepseekModels(false);
    }
  }, []);

  const fetchNinerouterTranslateModels = useCallback(async (opts?: { apiKey?: string; baseUrl?: string; currentModel?: string }) => {
    setLoadingNinerouterModels(true);
    try {
      const res = await api.getTranslateCloudModels("9router", {
        api_key: opts?.apiKey?.trim() || undefined,
        base_url: opts?.baseUrl?.trim() || undefined
      });
      const current = opts?.currentModel?.trim() || "";
      setNinerouterModelOptions(withCurrentModel(res.models, current));
      setNinerouterModelsSource(res.source);
      setNinerouterModelsError(res.error || "");
    } catch (e: any) {
      setNinerouterModelsError(e?.message || "Không thể tải danh sách model 9Router.");
    } finally {
      setLoadingNinerouterModels(false);
    }
  }, []);

  const refreshTranslateCloud = useCallback(async () => {
    try {
      const res = await api.getTranslateCloud();
      setTranslateCloud(res);
      const openaiModel = res.openai.model || "gpt-4o-mini";
      const geminiModel = res.gemini.model || "gemini-2.0-flash";
      const deepseekModel = res.deepseek.model || "deepseek-chat";
      const ninerouterModel = res["9router"].model || "";
      setOpenaiTranslateModel(openaiModel);
      setOpenaiTranslateBaseUrl(res.openai.base_url || "");
      setGeminiTranslateModel(geminiModel);
      setDeepseekTranslateModel(deepseekModel);
      setDeepseekTranslateBaseUrl(res.deepseek.base_url || "");
      setNinerouterTranslateModel(ninerouterModel);
      setNinerouterTranslateBaseUrl(res["9router"].base_url || "http://localhost:20128/v1");
      await Promise.all([
        fetchOpenaiTranslateModels({ baseUrl: res.openai.base_url, currentModel: openaiModel }),
        fetchGeminiTranslateModels({ currentModel: geminiModel }),
        fetchDeepseekTranslateModels({ baseUrl: res.deepseek.base_url, currentModel: deepseekModel }),
        fetchNinerouterTranslateModels({
          baseUrl: res["9router"].base_url,
          currentModel: ninerouterModel
        })
      ]);
    } catch {
      // keep defaults
    }
  }, [fetchOpenaiTranslateModels, fetchGeminiTranslateModels, fetchDeepseekTranslateModels, fetchNinerouterTranslateModels]);

  const refreshProfiles = useCallback(async () => {
    try {
      const res = await api.getProfiles();
      setProfiles(res);
    } catch (e) {
      console.error("Không thể tải danh sách giọng nói", e);
    }
  }, []);

  const refreshAsrEngines = useCallback(async () => {
    try {
      const res = await api.getAsrEngines();
      setAsrBackends(res.backends);
      const savedBackend = readPref(PrefKeys.asrBackend, "");
      const savedRepo = readPref(PrefKeys.asrModelRepo, "");
      if (savedBackend) {
        try {
          await api.selectAsrEngine(savedBackend, savedRepo || undefined);
          return;
        } catch (e) {
          console.warn("Không thể khôi phục engine ASR đã lưu:", e);
        }
      }
      await api.selectAsrEngine(res.active);
      writePref(PrefKeys.asrBackend, res.active);
    } catch (e) {
      console.error("Không thể tải danh sách engine ASR", e);
    }
  }, []);

  useEffect(() => {
    if (!asrSelectOptions.length) return;
    const savedBackend = readPref(PrefKeys.asrBackend, "whisperx");
    const savedRepo = readPref(PrefKeys.asrModelRepo, "");
    const picked = pickAsrSelection(asrSelectOptions, savedBackend, savedRepo);
    setAsrSelection((prev) => (prev === picked ? prev : picked));
  }, [asrSelectOptions]);

  const selectAsrSelection = useCallback(async (value: string) => {
    const previous = asrSelection;
    setAsrSelection(value);
    const { backend, repo } = decodeAsrSelection(value);
    writePref(PrefKeys.asrBackend, backend);
    writePref(PrefKeys.asrModelRepo, repo);
    try {
      const res = await api.selectAsrEngine(backend, repo || undefined);
      writePref(PrefKeys.asrBackend, res.active);
      if (res.active !== backend) {
        const updated = encodeAsrSelection(res.active, repo);
        setAsrSelection(updated);
      }
    } catch (cause) {
      setAsrSelection(previous);
      const { backend: prevBackend, repo: prevRepo } = decodeAsrSelection(previous);
      writePref(PrefKeys.asrBackend, prevBackend);
      writePref(PrefKeys.asrModelRepo, prevRepo);
      const message = cause instanceof Error ? cause.message : "Không thể chọn engine ASR.";
      setError(message);
    }
  }, [asrSelection]);

  const playVoice = (profileId: string) => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    const url = apiUrl(`/profiles/${profileId}/audio?t=${Date.now()}`);
    const audio = new Audio(url);
    audioRef.current = audio;
    setPlayingVoiceId(profileId);
    
    audio.onerror = async () => {
      setPlayingVoiceId(null);
      try {
        const res = await fetch(url);
        if (!res.ok) {
          const body = await res.json();
          alert(`Không thể phát âm thanh nghe thử: ${body.detail || res.statusText}`);
        } else {
          alert("Lỗi tải tệp âm thanh nghe thử.");
        }
      } catch {
        alert("Lỗi tải tệp âm thanh nghe thử (Không thể kết nối đến máy chủ).");
      }
    };

    audio.play().catch(err => {
      console.error(err);
      setPlayingVoiceId(null);
    });
    audio.onended = () => {
      setPlayingVoiceId(null);
    };
  };

  const handleCloneVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVoiceName.trim()) {
      alert("Vui lòng nhập tên giọng nói.");
      return;
    }
    if (!newVoiceFile) {
      alert("Vui lòng chọn tệp âm thanh mẫu.");
      return;
    }
    setIsCloning(true);
    try {
      const formData = new FormData();
      formData.set("name", newVoiceName.trim());
      formData.set("ref_audio", newVoiceFile);
      formData.set("kind", "clone");
      await api.createProfile(formData);
      setNewVoiceName("");
      setNewVoiceFile(null);
      await refreshProfiles();
      alert("Đã tạo giọng clone thành công!");
    } catch (err: any) {
      alert(`Lỗi clone giọng: ${err.message || err}`);
    } finally {
      setIsCloning(false);
    }
  };
  
  const translateDescription = (text: string) => {
    const dict: Record<string, string> = {
      "thì thầm": "whisper",
      "đàn ông": "male",
      "phụ nữ": "female",
      "bé trai": "boy",
      "bé gái": "girl",
      "con nít": "child",
      "trẻ em": "child",
      "người già": "elderly",
      "lớn tuổi": "elderly",
      "trẻ trung": "young adult",
      "thanh niên": "young adult",
      "trung niên": "middle-aged",
      "giọng nam": "male",
      "giọng nữ": "female",
      "nam": "male",
      "nữ": "female",
      "già": "elderly",
      "trẻ": "young",
      "trầm ấm": "low pitch, warm",
      "trầm": "low pitch",
      "sâu": "low pitch",
      "cao": "high pitch",
      "giọng anh": "british accent",
      "giọng mỹ": "american accent",
      "giọng úc": "australian accent",
      "giọng ấn": "indian accent",
      "giọng nga": "russian accent",
      "giọng nhật": "japanese accent",
      "giọng hàn": "korean accent",
    };
    let lower = text.toLowerCase();
    Object.entries(dict).forEach(([viet, eng]) => {
      lower = lower.replaceAll(viet, eng);
    });
    return lower;
  };

  const handleDesignVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVoiceName.trim()) {
      alert("Vui lòng nhập tên giọng nói.");
      return;
    }
    if (!voiceDescription.trim()) {
      alert("Vui lòng nhập mô tả giọng nói.");
      return;
    }
    setIsDesigning(true);
    try {
      const translated = translateDescription(voiceDescription.trim());
      const res = await api.describeVoice(translated);
      
      const formData = new FormData();
      formData.set("name", newVoiceName.trim());
      formData.set("kind", "design");
      formData.set("instruct", res.instruct || "");
      formData.set("vd_states", JSON.stringify(res.attrs || {}));
      formData.set("ref_text", "Here's a quick sample of this voice so you can hear how it sounds.");
      formData.set("language", "English");

      await api.createProfile(formData);
      setNewVoiceName("");
      setVoiceDescription("");
      await refreshProfiles();
      
      let matchedDesc = res.matched && res.matched.length > 0
        ? res.matched.map(m => `${m.category}: ${m.token}`).join(", ")
        : "Không phát hiện thuộc tính cụ thể (sử dụng cấu hình mặc định).";
      alert(`Đã tạo giọng thiết kế thành công!\nThuộc tính nhận diện được: ${matchedDesc}`);
    } catch (err: any) {
      alert(`Lỗi thiết kế giọng: ${err.message || err}`);
    } finally {
      setIsDesigning(false);
    }
  };

  const handleDeleteProfile = async (id: string) => {
    if (!confirm("Bạn có chắc chắn muốn xóa giọng nói này không?")) return;
    try {
      await api.deleteProfile(id);
      await refreshProfiles();
    } catch (err: any) {
      alert(`Lỗi xóa giọng: ${err.message || err}`);
    }
  };

  const handleRenameProfile = async (id: string, currentName: string) => {
    const nextName = prompt("Nhập tên mới cho giọng nói:", currentName);
    if (nextName === null) return;
    if (!nextName.trim()) {
      alert("Tên không được để trống.");
      return;
    }
    try {
      await api.updateProfile(id, nextName.trim());
      await refreshProfiles();
    } catch (err: any) {
      alert(`Lỗi sửa tên giọng: ${err.message || err}`);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        await initApi();
        const config = await getBackendConfig();
        setBackendConfig(config);
        setColabUrlInput(config.colabUrl);
        if (config.backendMode === "colab" && config.colabUrl) {
          setApiBase(config.colabUrl);
        }
        
        // 1. Kiểm tra kích hoạt từ backend trước tiên
        const lic = await api.getLicenseStatus();
        setIsActivated(lic.activated);

        if (window.videoDubbingDesktop) {
          const mid = await window.videoDubbingDesktop.getMachineId();
          setMachineId(mid);
          const dyCookie = await window.videoDubbingDesktop.getDouyinCookie();
          setDouyinCookie(dyCookie);
        }

        if (!lic.activated) {
          // Nếu chưa kích hoạt, dừng lại ở đây để hiển thị màn hình kích hoạt (không gọi các API khác để tránh bị chặn 402)
          setReady(true);
          return;
        }

        // 2. Nếu đã kích hoạt, tiếp tục tải dữ liệu
        const health = await api.health();
        setDevice(health.device);
        if (config.backendMode === "colab" && config.colabUrl) {
          setColabSessionReady(true);
        }
        await refreshModels();
        await refreshHfTokenState();
        await refreshTranslateCloud();
        await refreshProfiles();
        await refreshAsrEngines();
        setReady(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Không thể kết nối FastAPI.");
        setReady(true);
      }
    })();
  }, [refreshModels, refreshHfTokenState, refreshTranslateCloud, refreshProfiles, refreshAsrEngines]);

  function openColabNotebook() {
    if (window.videoDubbingDesktop?.openColabNotebook) {
      void window.videoDubbingDesktop.openColabNotebook();
    } else {
      window.open(colabNotebookUrl, "_blank");
    }
  }

  async function testColabConnection(url = colabUrlInput) {
    const cleanUrl = url.trim().replace(/\/+$/, "");
    if (!cleanUrl) {
      setColabStatus("Vui lòng nhập URL API Colab.");
      return false;
    }
    setTestingColab(true);
    setColabStatus("Đang kiểm tra kết nối Colab...");
    try {
      const response = await fetch(`${cleanUrl}/health`);
      if (!response.ok) {
        setColabStatus(`Không kết nối được Colab (${response.status}).`);
        return false;
      }
      const health = await response.json();
      const nextDevice = health.device || "unknown";
      let driveNote = "";
      try {
        const driveResponse = await fetch(`${cleanUrl}/colab/drive-status`);
        if (driveResponse.ok) {
          const driveStatus = await driveResponse.json();
          if (driveStatus.drive_ready) {
            driveNote = " · Google Drive sẵn sàng cho xuất file";
          } else {
            driveNote = " · Chưa mount Google Drive (chạy lại cell 3 trên Colab)";
          }
        }
      } catch {
        driveNote = "";
      }
      setColabStatus(`Kết nối thành công. Thiết bị: ${String(nextDevice).toUpperCase()}${driveNote}`);
      return true;
    } catch {
      setColabStatus("Không thể kết nối URL Colab. Hãy kiểm tra Cloudflare Tunnel và backend Colab.");
      return false;
    } finally {
      setTestingColab(false);
    }
  }

  async function switchBackendMode(mode: "local" | "colab") {
    const cleanUrl = colabUrlInput.trim().replace(/\/+$/, "");
    if (mode === "colab") {
      const ok = await testColabConnection(cleanUrl);
      if (!ok) return;
    }
    setSavingBackendConfig(true);
    try {
      const result = await saveBackendConfig({
        backendMode: mode,
        colabUrl: mode === "colab" ? cleanUrl : ""
      });
      setBackendConfig({ backendMode: result.backendMode, colabUrl: result.colabUrl });
      setColabSessionReady(mode === "colab");
      setColabUrlInput(result.colabUrl);
      setApiBase(result.apiBase);
      const health = await api.health();
      setDevice(health.device);
      if (isActivated) {
        await refreshModels();
        await refreshProfiles();
      }
      setColabStatus(mode === "colab" ? "Đã chuyển sang Google Colab GPU." : "Đã chuyển về backend cục bộ.");
    } catch (err: any) {
      setColabStatus(err?.message || "Không thể lưu cấu hình backend.");
    } finally {
      setSavingBackendConfig(false);
    }
  }

  // Tải dữ liệu ứng dụng sau khi kích hoạt thành công
  useEffect(() => {
    if (isActivated === true) {
      void (async () => {
        try {
          const health = await api.health();
          setDevice(health.device);
          await refreshModels();
          await refreshHfTokenState();
          await refreshProfiles();
        } catch (e) {
          console.error("Lỗi tải dữ liệu sau kích hoạt:", e);
        }
      })();
    }
  }, [isActivated, refreshModels, refreshHfTokenState, refreshProfiles]);

  useEffect(() => {
    if (stage === "done" || srtStage === "done") {
      setPreviewVersion((v) => v + 1);
    }
  }, [stage, srtStage]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (audioRef.current) audioRef.current.pause();
  }, [previewUrl]);

  // Poll batch jobs when batchGroupId is set (Clone Hàng loạt)
  useEffect(() => {
    if (!batchGroupId) return;

    let active = true;
    let pollInterval: number;

    const poll = async () => {
      try {
        const jobs = await api.getBatchJobs(batchGroupId);
        if (!active) return;
        
        // Sort jobs naturally by filename
        const sortedJobs = [...jobs].sort((a, b) => {
          return a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: "base" });
        });
        setBatchJobs(sortedJobs);

        const hasActive = sortedJobs.some(
          (j) => j.status === "queued" || j.status === "running"
        );
        setIsBatchRunning(hasActive);

        if (!hasActive) {
          clearInterval(pollInterval);
        }
      } catch (err: any) {
        console.error("Lỗi polling batch jobs:", err);
      }
    };

    void poll();
    pollInterval = window.setInterval(poll, 1500);

    return () => {
      active = false;
      clearInterval(pollInterval);
    };
  }, [batchGroupId]);

  // Listen for Douyin downloader progress events
  useEffect(() => {
    if (window.videoDubbingDesktop?.onDouyinDownloadProgress) {
      const removeListener = window.videoDubbingDesktop.onDouyinDownloadProgress((_, data) => {
        setDyDownloadedCount(data.downloaded);
        setDyTotalCount(data.total);
        setDyStatusText(data.message);
        setDyStatusType(data.status);
        if (data.downloadedItems) {
          setDyDownloadedItems(data.downloadedItems);
        }
        if (data.status === "done" || data.status === "cancelled" || data.status === "failed") {
          setDyIsDownloading(false);
          if (data.status === "failed") {
            setDyError(data.message);
          }
        }
      });
      return () => {
        removeListener();
      };
    }
  }, []);

  // Auto-scroll the segment list container during transcription
  useEffect(() => {
    if (stage === "transcribing" && segmentListRef.current) {
      segmentListRef.current.scrollTop = segmentListRef.current.scrollHeight;
    }
  }, [segments, stage]);

  async function installModel(model: ModelInfo) {
    setInstalling(model.repo_id);
    setInstallProgress(0);
    setError("");

    let pollInterval: number | undefined;
    let stopStream: (() => void) | undefined;

    const cleanup = () => {
      stopStream?.();
      stopStream = undefined;
      if (pollInterval) {
        window.clearInterval(pollInterval);
        pollInterval = undefined;
      }
      setInstalling("");
    };

    const onInstallEvent = (event: Record<string, any>) => {
      if (event.repo_id && event.repo_id !== model.repo_id) return;
      const pct = installProgressPercent(event);
      if (typeof pct === "number") {
        setInstallProgress((prev) => Math.max(prev, Math.min(99, pct)));
      }
      if (event.phase === "install_done") {
        setInstallProgress(100);
        cleanup();
      }
      if (event.phase === "install_error") {
        setError(event.error || "Tải model thất bại.");
        cleanup();
      }
      if (event.phase === "install_cancelled") {
        cleanup();
      }
    };

    try {
      stopStream = await startSseStream("/setup/download-stream", onInstallEvent);
      await api.installModel(model.repo_id);
      pollInterval = window.setInterval(async () => {
        const next = await refreshModels();
        if (next.find((item) => item.repo_id === model.repo_id)?.installed) {
          setInstallProgress(100);
          cleanup();
          if (model.engine === "llama_cpp") {
            selectTranslateProvider(llamaCppProviderValue(model.repo_id));
          } else if (model.role === "ASR") {
            const backend = resolveAsrBackend(routeAsrRepo(model.repo_id), asrBackends);
            const selection = encodeAsrSelection(backend, model.repo_id);
            void selectAsrSelection(selection);
          }
        }
      }, 2500);
    } catch (err: any) {
      setError(err?.message || "Không thể khởi động tải model.");
      cleanup();
    }
  }

  function renderTranslateProviderSelect(
    value: string,
    onChange: (next: string) => void,
    disabled = false,
    showHints = true,
  ) {
    const style = {
      width: "100%",
      height: "38px",
      padding: "0 10px",
      border: "1px solid var(--line)",
      borderRadius: "10px",
      outline: "0",
      color: "#46536d",
      background: "#fafbfe",
      fontSize: "13px",
      fontWeight: 700
    };
    return (
      <>
        <select
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          style={style}
        >
          <option value="google">Google Translate</option>
          <option value="argos">Argos Offline</option>
          <option value="nllb">NLLB-200 600M (Local)</option>
          {nllb1_3bInstalled && (
            <option value="nllb_1_3b">NLLB-200 1.3B (Chất lượng cao)</option>
          )}
          {marianInstalled && (
            <option value="marian_zh_vi">MarianMT Zh→Vi (Chuyên biệt)</option>
          )}
          {installedLlamaCppModels.map((model) => (
            <option
              key={model.repo_id}
              value={llamaCppProviderValue(model.repo_id)}
            >
              {model.label}
            </option>
          ))}
          {translateCloud.openai.configured && (
            <option value="openai">OpenAI ({translateCloud.openai.model || "GPT"})</option>
          )}
          {translateCloud.gemini.configured && (
            <option value="gemini">Google Gemini ({translateCloud.gemini.model || "Gemini"})</option>
          )}
          {translateCloud.deepseek.configured && (
            <option value="deepseek">DeepSeek ({translateCloud.deepseek.model || "deepseek-chat"})</option>
          )}
          {translateCloud["9router"].configured && (
            <option value="9router">9Router ({translateCloud["9router"].model || "proxy"})</option>
          )}
        </select>
        {showHints && !translateCloud.openai.configured && !translateCloud.gemini.configured && !translateCloud.deepseek.configured && !translateCloud["9router"].configured && (
          <div style={{ fontSize: "11px", color: "var(--muted)", marginTop: "6px" }}>
            Cấu hình OpenAI / Gemini / DeepSeek / 9Router tại <strong>Cấu hình → API dịch cloud</strong>.
          </div>
        )}
        {showHints && installedLlamaCppModels.length === 0 && llamaCppModels.length > 0 && (
          <div style={{ fontSize: "11px", color: "var(--muted)", marginTop: "6px" }}>
            Tải model cần dùng tại <strong>Cấu hình → Model dịch</strong>
            {isColabBackend ? " (tải lên GPU Colab)" : ""}.
          </div>
        )}
        {value.startsWith(LLAMA_CPP_PREFIX) && installedLlamaCppModels.length > 0 && (
          <div style={{ fontSize: "11px", color: "#1a7c61", marginTop: "6px", fontWeight: 600 }}>
            Đang dùng: {installedLlamaCppModels.find((m) => value === llamaCppProviderValue(m.repo_id))?.label
              || "Model llama.cpp"}
          </div>
        )}
      </>
    );
  }

  function renderTranslationModelRow(model: ModelInfo) {
    const isInstalling = installing === model.repo_id;
    const isDeleting = deletingModel === model.repo_id;
    const sizeLabel = model.size_gb >= 1 ? `${model.size_gb} GB` : `${Math.round(model.size_gb * 1024)} MB`;
    return (
      <div key={model.repo_id} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 14px", background: model.installed ? "#f0fdf8" : "#fafbfe", border: `1px solid ${model.installed ? "#b6e8d4" : "var(--line)"}`, borderRadius: "10px", transition: "all 0.2s" }}>
        <div style={{ width: "34px", height: "34px", borderRadius: "8px", background: model.installed ? "#d1f5e8" : "#eef0f7", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          {model.installed ? <Check size={16} color="#24967c" /> : <HardDrive size={16} color="#9aa5bf" />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#27344e" }}>{model.label}</span>
            <span style={{ fontSize: "10px", padding: "1px 7px", borderRadius: "20px", background: model.installed ? "#c5f0df" : "#eef0f7", color: model.installed ? "#1a7c61" : "#9aa5bf", fontWeight: 700 }}>{model.installed ? "Đã cài" : "Chưa tải"}</span>
            <span style={{ fontSize: "10px", color: "var(--muted)", fontWeight: 600 }}>{sizeLabel}</span>
            {model.installed && model.engine === "llama_cpp" && (
              <span style={{ fontSize: "10px", padding: "1px 7px", borderRadius: "20px", background: "#edf2ff", color: "#3b6ef5", fontWeight: 700 }}>Hiện ở Công cụ dịch</span>
            )}
          </div>
          <div style={{ fontSize: "11px", color: "#9aa5bf", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.repo_id}</div>
          {model.note && <div style={{ fontSize: "11px", color: "#7a8ba8", marginTop: "3px" }}>{model.note}</div>}
          {isInstalling && (
            <div style={{ marginTop: "6px", height: "4px", background: "#e0e8f0", borderRadius: "4px", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${installProgress}%`, background: "linear-gradient(90deg, #3b6ef5, #24967c)", borderRadius: "4px", transition: "width 0.4s" }} />
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          {!model.installed && (
            <button
              type="button"
              disabled={!!installing}
              onClick={() => void installModel(model)}
              style={{ display: "flex", alignItems: "center", gap: "5px", padding: "6px 12px", border: 0, borderRadius: "8px", background: "var(--blue)", color: "white", fontSize: "12px", fontWeight: 700, cursor: installing ? "not-allowed" : "pointer", opacity: installing ? 0.6 : 1 }}
            >
              {isInstalling ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}
              {isInstalling ? `${installProgress.toFixed(0)}%` : "Tải về"}
            </button>
          )}
          {model.installed && (
            <button
              type="button"
              disabled={isDeleting}
              onClick={async () => {
                if (!confirm(`Xóa model "${model.label}"?\nSẽ giải phóng ~${sizeLabel} dung lượng.`)) return;
                setDeletingModel(model.repo_id);
                try {
                  await fetch(apiUrl(`/models/${encodeURIComponent(model.repo_id)}`), { method: "DELETE" });
                  await refreshModels();
                  if (provider === llamaCppProviderValue(model.repo_id)) {
                    selectTranslateProvider("google");
                  }
                } catch (e: any) {
                  alert(`Lỗi xóa model: ${e.message || e}`);
                } finally {
                  setDeletingModel("");
                }
              }}
              style={{ display: "flex", alignItems: "center", gap: "5px", padding: "6px 10px", border: "1px solid #f1cfd5", borderRadius: "8px", background: "#fff5f6", color: "#d55f6e", fontSize: "12px", fontWeight: 700, cursor: "pointer" }}
            >
              {isDeleting ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
            </button>
          )}
        </div>
      </div>
    );
  }

  const splitSegmentAt = useCallback((index: number, splitTime: number) => {
    setSegments((current) => {
      const seg = current[index];
      if (!seg) return current;
      const pair = splitSegmentByTime(seg, splitTime);
      if (!pair) return current;
      const next = [...current];
      next.splice(index, 1, pair[0], pair[1]);
      return next;
    });
  }, []);

  const playSegmentPreview = (segment: Segment, index: number) => {
    const videoEl = sourceVideoRef.current;
    if (videoEl) {
      videoEl.currentTime = segment.start;
      videoEl.play().catch(() => {});
    }

    if (jobId && tracks.length > 0) {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const url = apiUrl(`/dub/preview/${jobId}/${index}?t=${Date.now()}`);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.play().catch(err => {
        console.error("Lỗi nghe thử segment:", err);
      });
    }
  };

  const playSrtSegmentPreview = (segment: Segment, index: number) => {
    const videoEl = document.querySelector(".cinematic-player-card video") as HTMLVideoElement;
    if (videoEl) {
      videoEl.currentTime = segment.start;
      videoEl.play().catch(() => {});
    }

    if (srtJobId && ["done"].includes(srtStage)) {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const url = apiUrl(`/dub/preview/${srtJobId}/${index}?t=${Date.now()}`);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.play().catch(err => {
        console.error("Lỗi nghe thử segment:", err);
      });
    }
  };

  async function startSrtPipeline() {
    if (!srtFile) {
      setSrtError("Vui lòng chọn file phụ đề SRT.");
      return;
    }
    setSrtError("");
    const id = newJobId();
    setSrtJobId(id);
    
    try {
      if (srtVideoFile) {
        setSrtStage("preparing");
        setSrtPrepLabel("Đang nạp video (dùng phụ đề SRT — bỏ qua tách giọng và nhận dạng)...");
        setSrtPrepProgress(10);
        const upload = await api.upload(srtVideoFile, id, { srtMode: true });
        setSrtPrepProgress(40);
        
        let prepStreamError = "";
        await readSse(`/tasks/stream/${upload.task_id}`, (event) => {
          if (event.type === "download_progress") {
            setSrtPrepLabel(`Đang đọc video ${Math.round(event.percent || 0)}%`);
            setSrtPrepProgress(10 + Math.round((event.percent || 0) * 0.3));
          }
          if (event.type === "extract_start") {
            setSrtPrepLabel("Đang trích xuất audio từ video...");
            setSrtPrepProgress(50);
          }
          if (event.type === "extract_done") {
            setSrtPrepLabel("Đã trích xuất audio — bỏ qua tách giọng (SRT)...");
            setSrtPrepProgress(65);
          }
          if (event.type === "demucs_done" && event.skipped) {
            setSrtPrepLabel("Bỏ qua tách giọng — dùng phụ đề SRT...");
            setSrtPrepProgress(75);
          }
          if (event.type === "scene_done" && event.skipped) {
            setSrtPrepLabel("Bỏ qua nhận diện cảnh — đang tạo ảnh xem trước...");
            setSrtPrepProgress(90);
          }
          if (event.type === "ready") {
            setSrtPrepLabel("Video sẵn sàng — đang đọc file SRT...");
            setSrtPrepProgress(95);
          }
          if (event.type === "error" || event.type === "failure" || event.type === "cancelled") {
            prepStreamError = event.detail || event.error || event.reason || "Chuẩn bị video thất bại.";
          }
        });
        if (prepStreamError) {
          throw new Error(prepStreamError);
        }
        setSrtPrepProgress(100);
      } else {
        setSrtStage("preparing");
        setSrtPrepLabel("Đang khởi tạo phiên làm việc...");
        setSrtPrepProgress(30);
        await api.createSrtJob(id, srtFile.name, 0.0);
        setSrtPrepProgress(100);
      }
      
      setSrtPrepLabel("Đang đọc phụ đề từ file SRT...");
      const result = await api.importSrt(id, srtFile);
      setSrtSegments(result.segments.map(seg => ({
        ...seg,
        text_original: seg.text_original || seg.text
      })));
      setSrtStage("editing");
      if (result.segments.length > 0) {
        setSrtSelectedId(String(result.segments[0].id));
      }
    } catch (cause) {
      setSrtError(cause instanceof Error ? cause.message : "Quy trình lồng tiếng bị gián đoạn.");
      setSrtStage("idle");
    }
  }

  async function translateSrtAll() {
    if (!srtJobId || !srtSegments.length) return;
    setSrtStage("translating");
    setSrtPrepLabel(`Đang dịch sang Tiếng Việt...`);
    setSrtError("");
    try {
      await api.health();
      const apiProvider = await ensureTranslateProvider(srtProvider);
      const chunkSize = 50;
      const merged = new Map<string, string>();
      const failed: {id: string | number; error?: string}[] = [];
      for (let offset = 0; offset < srtSegments.length; offset += chunkSize) {
        const chunk = srtSegments.slice(offset, offset + chunkSize);
        const end = Math.min(offset + chunkSize, srtSegments.length);
        setSrtPrepLabel(`Đang dịch phân đoạn ${end}/${srtSegments.length}...`);
        const result = await api.translate(srtJobId, chunk, srtLanguageCode, apiProvider);
        for (const item of result.translated) {
          merged.set(String(item.id), item.text);
          if (item.error) failed.push(item);
        }
      }
      if (failed.length === srtSegments.length) {
        const sample = failed[0]?.error || "Không thể dịch phụ đề.";
        throw new Error(
          `Dịch thất bại (${failed.length}/${srtSegments.length} phân đoạn). ` +
          `${sample} — Thử đổi công cụ dịch sang Argos/NLLB trong sidebar, hoặc kiểm tra kết nối Internet (Google Translate).`
        );
      }
      setSrtSegments((current) => current.map((item) => ({
        ...item, text: merged.get(String(item.id)) || item.text
      })));
      if (failed.length > 0) {
        setSrtError(`${failed.length} phân đoạn dịch lỗi — các phân đoạn còn lại đã được cập nhật.`);
      }
      setSrtStage("editing");
    } catch (cause) {
      setSrtError(cause instanceof Error ? cause.message : "Không thể dịch phụ đề.");
      setSrtStage("editing");
    }
  }

  async function generateSrtDub() {
    if (!srtJobId || !srtSegments.length) return;
    setSrtStage("generating");
    setSrtPrepLabel("Đang chuẩn bị sinh giọng nói...");
    setSrtError("");
    try {
      await api.health();
      const segmentsToGenerate = srtSegments.map(seg => {
        let activeProfile = seg.profile_id;
        if (!activeProfile) {
          activeProfile = srtVoiceId || defaultVoiceId || "";
        }
        if (activeProfile === "system") {
          activeProfile = "";
        }
        return { ...seg, profile_id: activeProfile };
      });
      
      const srtLanguage = LANGUAGES.find(([code]) => code === srtLanguageCode) || LANGUAGES[0];
      const result = await api.generate(srtJobId, segmentsToGenerate, srtLanguage[1], srtLanguageCode, srtTiming);
      setSrtProgressCurrent(0);
      setSrtProgressTotal(srtSegments.length);
      setSrtProgressText("Đang xử lý phân đoạn...");
      
      let streamError = "";
      await readSse(`/tasks/stream/${result.task_id}`, (event) => {
        if (event.type === "progress") {
          setSrtProgressCurrent((event.current || 0) + 1);
          setSrtProgressTotal(event.total || srtSegments.length);
          setSrtProgressText(event.text || "Đang xử lý...");
          setSrtPrepLabel(`Đang lồng tiếng phân đoạn ${(event.current || 0) + 1}/${event.total || srtSegments.length}`);
        }
        if (event.type === "done") {
          setSrtTracks(event.tracks || [srtLanguageCode]);
        }
        if (event.type === "error" || event.type === "failure" || event.type === "cancelled") {
          streamError = event.reason || event.error || event.detail || "Tạo giọng thất bại.";
          setSrtError(streamError);
        }
      });
      if (streamError) {
        throw new Error(streamError);
      }
      setSrtTracks((current) => current.length ? current : [srtLanguageCode]);
      setSrtStage("done");
    } catch (cause) {
      setSrtError(cause instanceof Error ? cause.message : "Không thể tạo bản lồng tiếng.");
      setSrtStage("editing");
    }
  }

  function resetSrt() {
    setSrtFile(null);
    setSrtVideoFile(null);
    setSrtSegments([]);
    setSrtSelectedId(null);
    setSrtStage("idle");
    setSrtError("");
    setSrtJobId("");
    setSrtTracks([]);
    if (srtVideoPreviewUrl) {
      URL.revokeObjectURL(srtVideoPreviewUrl);
      setSrtVideoPreviewUrl("");
    }
    if (srtSrtFileRef.current) srtSrtFileRef.current.value = "";
    if (srtVideoFileRef.current) srtVideoFileRef.current.value = "";
  }

  const dyUrlIsDouyin = useMemo(() => isDouyinUrl(dyUrl), [dyUrl]);

  const handleVideoDownload = async () => {
    const url = dyUrl.trim();
    if (!url) {
      setDyError("Vui lòng nhập đường dẫn video.");
      return;
    }
    if (!dyDownloadDir) {
      setDyError("Vui lòng chọn thư mục chứa file tải xuống.");
      return;
    }

    const douyin = isDouyinUrl(url);
    if (douyin) {
      if (!douyinCookie) {
        setDyError("Vui lòng cấu hình Cookie Douyin trước (ở tab Cấu hình -> Đăng nhập Douyin).");
        return;
      }
      if (!window.videoDubbingDesktop) {
        setDyError("Tải Douyin chỉ hỗ trợ trên ứng dụng desktop.");
        return;
      }
    } else if (isColabBackend) {
      setDyError("Tải video YouTube/TikTok cần backend Local (Colab không hỗ trợ lưu vào thư mục máy bạn).");
      return;
    }

    setDyError("");
    setDyDownloadedCount(0);
    setDyTotalCount(douyin ? 0 : 1);
    setDyDownloadedItems([]);
    setDyStatusText("Đang bắt đầu...");
    setDyStatusType("starting");
    setDyIsDownloading(true);

    try {
      if (douyin) {
        await window.videoDubbingDesktop!.douyinStartDownload(url, dyDownloadDir, dyOnlyMp4, dyIsUser);
        return;
      }

      setDyStatusText("Đang tải qua yt-dlp...");
      setDyStatusType("downloading");
      const result = await api.downloadVideoUrl(url, dyDownloadDir, dyOnlyMp4);
      setDyDownloadedCount(1);
      setDyDownloadedItems([{
        id: result.id,
        title: result.title,
        path: result.path,
        isFolder: result.is_folder,
      }]);
      setDyStatusText(`Đã tải xong: ${result.title}`);
      setDyStatusType("done");
    } catch (e: any) {
      setDyError(e.message || String(e));
      setDyStatusType("failed");
      setDyStatusText(e.message || "Tải thất bại");
    } finally {
      if (!douyin) {
        setDyIsDownloading(false);
      }
    }
  };

  const handleCancelDouyinDownload = async () => {
    if (window.videoDubbingDesktop) {
      await window.videoDubbingDesktop.douyinCancelDownload();
      setDyIsDownloading(false);
      setDyStatusType("cancelled");
      setDyStatusText("Đã hủy tải xuống.");
    }
  };

  async function runProjectExport(options: {
    name: string;
    endpoint: string;
    uploadLogo?: { jobId: string; file: File };
    autoSaveDir?: string;
    useAutoSave?: boolean;
  }) {
    setExportPercent(0);
    setExportModalStatus("Đang chuẩn bị xuất tệp...");
    setExportSuccess(false);
    setDriveExportResult(null);
    setShowExportModal(true);

    const useColabDrive = backendConfig.backendMode === "colab";
    let removeListener: (() => void) | undefined;

    if (!useColabDrive && window.videoDubbingDesktop?.onDownloadProgress) {
      removeListener = window.videoDubbingDesktop.onDownloadProgress((_, data) => {
        setExportPercent(data.percent);
        if (data.status === "downloading") {
          setExportModalStatus(`Đang tải tệp về máy... ${data.percent}%`);
        } else if (data.status === "done") {
          setExportModalStatus("Đã tải xong! Đang ghi file...");
        }
      });
    }

    try {
      if (options.uploadLogo) {
        setExportModalStatus("Đang chuẩn bị logo cho xuất video...");
        await api.uploadOverlayLogo(options.uploadLogo.jobId, options.uploadLogo.file);
      }

      if (useColabDrive) {
        setExportModalStatus("Đang xuất tệp lên Google Drive (Colab)...");
        setExportPercent(35);
        const result = await api.exportToDrive(options.endpoint);
        setDriveExportResult(result);
        setSavedPath("");
        setExportModalStatus(`Đã xuất "${result.filename}" lên Google Drive.`);
        setExportSuccess(true);
        setExportPercent(100);
        return;
      }

      if (window.videoDubbingDesktop) {
        const path = await window.videoDubbingDesktop.saveFile(
          options.name,
          apiUrl(options.endpoint),
          options.useAutoSave ? options.autoSaveDir : undefined
        );
        if (path) {
          setSavedPath(path);
          setExportModalStatus("Đã xuất tệp thành công!");
          setExportSuccess(true);
          setExportPercent(100);
          setTimeout(() => setShowExportModal(false), 2000);
        } else {
          setShowExportModal(false);
        }
      } else {
        const anchor = document.createElement("a");
        anchor.href = apiUrl(options.endpoint);
        anchor.download = options.name;
        anchor.click();
        setExportModalStatus("Đã bắt đầu tải xuống tệp!");
        setExportSuccess(true);
        setExportPercent(100);
        setTimeout(() => setShowExportModal(false), 2000);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Xuất file thất bại.";
      setError(`Lỗi xuất file: ${message}`);
      setExportModalStatus(message);
      setExportSuccess(false);
      setTimeout(() => setShowExportModal(false), 2500);
    } finally {
      if (removeListener) removeListener();
    }
  }

  async function saveSrtExport(kind: "video" | "audio" | "srt") {
    if (!srtJobId) return;
    const baseName = (srtFile?.name || "phim").replace(/\.[^.]+$/, "");
    const audioParams = exportAudioQueryParams(exportAudioMode, srtLanguageCode);
    
    const burnSubsParam = srtBurnSubs ? "&burn_subs=true" : "";
    const formatParam = srtOutFormat !== "wav" ? `&out_format=${srtOutFormat}` : "";
    
    let endpoint = "";
    let name = "";
    
    if (kind === "video") {
      name = `${baseName}-${srtLanguageCode}-dubbed.mp4`;
      endpoint = `/dub/download/${srtJobId}?default_track=${srtLanguageCode}&include_tracks=${audioParams.include_tracks}&preserve_bg=${audioParams.preserve_bg}${burnSubsParam}`;
    } else if (kind === "audio") {
      name = `${baseName}-${srtLanguageCode}-dubbed.${srtOutFormat}`;
      if (srtVideoFile) {
        endpoint = `/dub/download-audio/${srtJobId}?lang=${srtLanguageCode}&preserve_bg=${audioParams.preserve_bg}`;
      } else {
        endpoint = `/dub/download/${srtJobId}?default_track=${srtLanguageCode}&include_tracks=${audioParams.include_tracks}&preserve_bg=${audioParams.preserve_bg}&out_format=${srtOutFormat}`;
      }
    } else {
      name = `${baseName}-${srtLanguageCode}.srt`;
      endpoint = `/dub/srt/${srtJobId}?lang=${srtLanguageCode}`;
    }
    
    const useAutoSave = autoSave && defaultSaveDir && kind === "video";
    await runProjectExport({
      name,
      endpoint,
      autoSaveDir: defaultSaveDir,
      useAutoSave
    });
  }

  function chooseSrtFile(next: File | null) {
    setSrtFile(next);
    setSrtSegments([]);
    setSrtTracks([]);
    setSrtStage("idle");
    setSrtError("");
  }

  function chooseSrtVideoFile(next: File | null) {
    if (srtVideoPreviewUrl) URL.revokeObjectURL(srtVideoPreviewUrl);
    setSrtVideoFile(next);
    if (next) {
      setSrtVideoPreviewUrl(URL.createObjectURL(next));
    } else {
      setSrtVideoPreviewUrl("");
    }
    setSrtTracks([]);
    setSrtStage("idle");
    setSrtError("");
  }

  function chooseFile(next: File | null) {
    if (!next) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setFile(null);
      setPreviewUrl("");
      if (fileRef.current) {
        fileRef.current.value = "";
      }
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(next);
    setPreviewUrl(URL.createObjectURL(next));
    setSegments([]);
    setTracks([]);
    setStage("idle");
    setError("");
  }

  async function startPipeline() {
    if (!file) return;
    const id = newJobId();
    setJobId(id);
    setStage("preparing");
    setStageLabel("Đang tách audio và phân tích cảnh");
    setError("");
    try {
      const upload = await api.upload(file, id);
      await readSse(`/tasks/stream/${upload.task_id}`, (event) => {
        if (event.type === "download_progress") setStageLabel(`Đang đọc video ${Math.round(event.percent || 0)}%`);
        if (event.type === "extract_start") setStageLabel("Đang trích xuất audio");
        if (event.type === "demucs_start") setStageLabel("Đang tách lời thoại và nhạc nền");
        if (event.type === "scene_start") setStageLabel("Đang nhận diện cảnh");
        if (event.type === "error") throw new Error(event.detail || event.error || "Chuẩn bị video thất bại.");
      });

      setStage("transcribing");
      const { backend: asrBackend, repo: asrModelRepo } = decodeAsrSelection(asrSelection);
      const asrLabel = asrSelectOptions.find((item) => item.value === asrSelection)?.label || asrBackend;
      setStageLabel(`Đang nhận dạng lời thoại (${asrLabel})...`);
      await api.selectAsrEngine(asrBackend, asrModelRepo || undefined);
      const incoming: Segment[] = [];
      const queryParams = new URLSearchParams({
        per_segment_refs: "true",
      });
      if (sourceLanguageCode && sourceLanguageCode !== "auto") {
        queryParams.set("language", sourceLanguageCode);
      }
      await readSse(`/dub/transcribe-stream/${id}?${queryParams.toString()}`, (event) => {
        if (event.type === "segments" && Array.isArray(event.segments)) {
          for (const segment of event.segments as Segment[]) {
            const normalized = {...segment, text_original: segment.text_original || segment.text};
            const index = incoming.findIndex((item) => String(item.id) === String(segment.id));
            if (index >= 0) incoming[index] = normalized;
            else incoming.push(normalized);
          }
          setSegments([...incoming]);
        }
        if (event.type === "final") {
          const finalSegments = event.segments as Segment[] | undefined;
          if (finalSegments?.length) {
            incoming.splice(0, incoming.length, ...finalSegments);
            setSegments(finalSegments.map((item) => ({
              ...item, text_original: item.text_original || item.text
            })));
          }
        }
        if (event.type === "error") setError(event.detail || "Không thể nhận dạng lời thoại.");
      });
      setSegments((current) => current.map((item) => ({
        ...item, text_original: item.text_original || item.text
      })));
      setStage("editing");
      setSelectedId(String(incoming[0]?.id ?? ""));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pipeline bị gián đoạn.");
      setStage("idle");
    }
  }

  async function translateAll() {
    if (!jobId || !segments.length) return;
    setStage("translating");
    setStageLabel(`Đang dịch sang ${language[2]}`);
    setError("");
    try {
      const apiProvider = await ensureTranslateProvider(provider);
      const result = await api.translate(jobId, segments, languageCode, apiProvider);
      const failed = result.translated.filter((item) => item.error);
      if (failed.length === result.translated.length) {
        throw new Error(
          `Dịch thất bại: ${failed[0].error || "lỗi không xác định"}`
        );
      }
      if (failed.length > 0) {
        setError(`Cảnh báo: ${failed.length}/${result.translated.length} câu dịch thất bại — ${failed[0].error || "lỗi không xác định"}`);
      }
      const translated = new Map(result.translated.map((item) => [String(item.id), item.text]));
      const unchanged = segments.filter((item) => {
        const next = translated.get(String(item.id));
        return next !== undefined && next === item.text && item.text === (item.text_original || item.text);
      });
      if (unchanged.length === segments.length) {
        throw new Error("Không có câu nào được dịch. Kiểm tra công cụ dịch hoặc thử MarianMT Zh→Vi cho Trung→Việt.");
      }
      setSegments((current) => current.map((item) => ({
        ...item, text: translated.get(String(item.id)) || item.text
      })));
      setStage("editing");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể dịch phụ đề.");
      setStage("editing");
    }
  }

  async function generateDub() {
    if (!jobId || !segments.length) return;
    setStage("generating");
    setStageLabel("Đang tạo giọng lồng tiếng...");
    setError("");
    try {
      const segmentsToGenerate = segments.map(seg => {
        let pId = seg.profile_id;
        if (defaultVoiceId) {
          // Apply the user's chosen default voice to segments that either:
          // - have no profile_id assigned, OR
          // - have an auto-assigned profile_id (auto:speaker_X, auto-seg:X)
          //   from the video's original speaker clone extraction.
          // This ensures that when the user picks a clone voice as default
          // in the sidebar, it overrides the auto-detected speaker clones
          // for ALL segments, not just unassigned ones.
          const isAutoAssigned = pId?.startsWith("auto:") || pId?.startsWith("auto-seg:");
          if (!pId || isAutoAssigned) {
            pId = defaultVoiceId;
          }
        }
        if (pId === "system") {
          pId = "";
        }
        return { ...seg, profile_id: pId };
      });
      const result = await api.generate(jobId, segmentsToGenerate, language[1], languageCode, timing);
      await readSse(`/tasks/stream/${result.task_id}`, (event) => {
        if (event.type === "progress") {
          setStageLabel(`Đang tạo câu ${(event.current || 0) + 1}/${event.total || segments.length}`);
        }
        if (event.type === "done") {
          setTracks(event.tracks || [languageCode]);
        }
        if (event.type === "error") setError(event.error || event.detail || "Tạo giọng thất bại.");
      });
      setTracks((current) => current.length ? current : [languageCode]);
      setStage("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể tạo bản lồng tiếng.");
      setStage("editing");
    }
  }

  async function saveExport(kind: "video" | "audio" | "srt") {
    if (!jobId) return;
    const baseName = (file?.name || "video").replace(/\.[^.]+$/, "");
    const audioParams = exportAudioQueryParams(exportAudioMode, languageCode);
    let name = `${baseName}-${languageCode}-dubbed.mp4`;
    let endpoint = `/dub/download/${jobId}?default_track=${languageCode}&include_tracks=${audioParams.include_tracks}&preserve_bg=${audioParams.preserve_bg}`;
    if (kind === "audio") {
      name = `${baseName}-${languageCode}-dubbed.wav`;
      const audioQuery = new URLSearchParams({
        lang: languageCode,
        preserve_bg: audioParams.preserve_bg,
        bg_volume: String(bgVolume),
        dub_volume: String(dubVolume),
      });
      endpoint = `/dub/download-audio/${jobId}?${audioQuery.toString()}`;
    } else if (kind === "srt") {
      name = `${baseName}-${languageCode}.srt`;
      endpoint = `/dub/srt/${jobId}?lang=${languageCode}`;
    } else {
      const params = new URLSearchParams({
        default_track: languageCode,
        include_tracks: audioParams.include_tracks,
        preserve_bg: audioParams.preserve_bg,
        ...videoExportPolishParams({
          burnVideoSubs,
          subtitleBox,
          subtitleFontSize,
          subtitleColor,
          subtitleBgColor,
          subtitleBgTransparent,
          subtitleFontFamily,
          blurExistingSubs,
          blurRegions,
          logoOverlayEnabled,
          logoBox,
          bgVolume,
          dubVolume,
        }),
      });
      if (audioParams.mix_original) {
        params.set("mix_original", "true");
      }
      endpoint = `/dub/download/${jobId}?${params.toString()}`;
    }
    
    const useAutoSave = autoSave && defaultSaveDir && kind === "video";
    await runProjectExport({
      name,
      endpoint,
      autoSaveDir: defaultSaveDir,
      useAutoSave,
      uploadLogo: kind === "video" && logoOverlayEnabled && logoFile ? { jobId, file: logoFile } : undefined
    });
  }

  function reset() {
    if (fileRef.current) {
      fileRef.current.value = "";
    }
    setFile(null);
    setPreviewUrl("");
    setJobId("");
    setSegments([]);
    setTracks([]);
    setStage("idle");
    setError("");
    setSavedPath("");
    setDriveExportResult(null);
    setLogoFile(null);
    setLogoOverlayEnabled(false);
    setBurnVideoSubs(false);
    setBlurExistingSubs(false);
    setBlurRegions([{ id: "blur-1", x: 0.12, y: 0.78, w: 0.76, h: 0.14 }]);
    setActiveBlurRegionId("blur-1");
    setSubtitlePos({ x: 0.12, y: 0.8, w: 0.76 });
    setVideoRatio(16 / 9);
    setVideoTime(0);
    setVideoPlaying(false);
  }

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!licenseKeyInput.trim()) {
      setActivationError("Vui lòng nhập mã kích hoạt.");
      return;
    }
    setIsActivating(true);
    setActivationError("");
    try {
      let res;
      if (window.videoDubbingDesktop) {
        res = await window.videoDubbingDesktop.activateLicense(licenseKeyInput.trim());
      } else {
        res = await api.activateLicense(licenseKeyInput.trim());
      }

      if (res.success) {
        setIsActivated(true);
        alert("Kích hoạt bản quyền phần mềm thành công!");
      } else {
        setActivationError(res.message || "Mã kích hoạt không hợp lệ.");
      }
    } catch (err: any) {
      setActivationError(err.message || "Không thể kết nối tới backend.");
    } finally {
      setIsActivating(false);
    }
  };

  if (!ready) {
    return <div className="boot"><LoaderCircle className="spin" /><strong>Đang khởi động Video Clone…</strong><span>{error}</span></div>;
  }

  if (isActivated === false) {
    return (
      <div className="modal-backdrop" style={{ display: "grid", placeItems: "center", background: "#f5f7fb", backdropFilter: "none" }}>
        <div className="modal-card" style={{ maxWidth: "460px", padding: "40px", borderRadius: "24px", boxShadow: "0 20px 50px rgba(75, 115, 241, 0.12)", border: "1px solid rgba(255, 255, 255, 0.7)", background: "rgba(255, 255, 255, 0.98)" }}>
          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ width: "64px", height: "64px", borderRadius: "20px", background: "linear-gradient(135deg, #6689f6, #3f62dc)", color: "white", display: "grid", placeItems: "center", margin: "0 auto", boxShadow: "0 10px 20px rgba(63,94,218,.25)" }}>
              <Sparkles size={28} />
            </div>
            <div>
              <h2 style={{ margin: "0 0 8px 0", color: "#27344e", fontSize: "22px", fontWeight: 850 }}>Kích hoạt Video Clone</h2>
              <p style={{ margin: 0, color: "var(--muted)", fontSize: "13px", lineHeight: "1.6" }}>
                Vui lòng nhập mã kích hoạt gồm 16 ký tự để mở khóa và bắt đầu sử dụng phần mềm.
              </p>
            </div>

            {machineId && (
              <div style={{
                background: "#f0f4fd",
                padding: "12px 16px",
                borderRadius: "14px",
                border: "1px dashed #b9cbfa",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                marginTop: "4px"
              }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "2px" }}>
                  <span style={{ fontSize: "10px", color: "#7c92d5", fontWeight: 800, textTransform: "uppercase" }}>Mã máy tính (Machine ID)</span>
                  <span style={{ fontSize: "15px", color: "#3f62dc", fontWeight: 850, fontFamily: "monospace", letterSpacing: "1px" }}>{machineId}</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(machineId);
                    alert("Đã sao chép Mã máy tính vào bộ nhớ tạm!");
                  }}
                  style={{
                    background: "white",
                    border: "1px solid #d3defc",
                    color: "#3f62dc",
                    padding: "6px 12px",
                    borderRadius: "8px",
                    fontSize: "11px",
                    fontWeight: 800,
                    cursor: "pointer",
                    boxShadow: "0 2px 4px rgba(63,94,218,0.06)",
                    transition: "all 0.15s"
                  }}
                >
                  Sao chép
                </button>
              </div>
            )}
            
            <form onSubmit={(e) => void handleActivate(e)} style={{ display: "flex", flexDirection: "column", gap: "14px", marginTop: "10px" }}>
              <input
                type="text"
                placeholder="XXXX-XXXX-XXXX-XXXX"
                value={licenseKeyInput}
                onChange={(e) => setLicenseKeyInput(e.target.value.toUpperCase())}
                style={{
                  height: "44px",
                  padding: "0 16px",
                  border: "1px solid var(--line)",
                  borderRadius: "12px",
                  outline: "0",
                  color: "#27344e",
                  background: "#fafbfe",
                  fontSize: "15px",
                  fontWeight: 800,
                  textAlign: "center",
                  letterSpacing: "2px"
                }}
              />
              {activationError && (
                <span style={{ color: "#d55f6e", fontSize: "12px", fontWeight: 700 }}>{activationError}</span>
              )}
              <button
                type="submit"
                disabled={isActivating}
                className="primary"
                style={{ height: "44px", borderRadius: "12px", marginTop: "4px" }}
              >
                {isActivating ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                {isActivating ? "Đang xác thực..." : "Kích hoạt phần mềm"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }



  const setupModels = requiredModels.length > 0 ? requiredModels : [
    { repo_id: "k2-fsa/OmniVoice", role: "TTS", label: "Mô hình tạo giọng nói đa ngôn ngữ nâng cao (Zero-shot)", size_gb: 2.4, installed: false } as ModelInfo,
    { repo_id: "Systran/faster-whisper-large-v3", role: "ASR", label: "Mô hình nhận dạng giọng nói tự động độ chính xác cao", size_gb: 2.9, installed: false } as ModelInfo,
  ];

  if (showStartupSetup) {
    return (
      <div className="setup-shell">
        <div className="setup-card">
          <div className="setup-art"><Video size={34} /><i /><i /></div>
          <span className="eyebrow">Thiết lập lần đầu</span>
          <h1>Chuẩn bị studio lồng tiếng cục bộ</h1>
          <p>Hai model AI cốt lõi chỉ tải một lần. Sau đó ứng dụng sử dụng lại dữ liệu trong máy và không tải lại khi khởi động.</p>
          <div className="model-list">
            {setupModels.map((model) => {
              const active = installing === model.repo_id;
              return (
                <article key={model.repo_id} className={model.installed ? "installed" : ""}>
                  <div className="model-icon">{model.role === "TTS" ? <Mic2 /> : <Languages />}</div>
                  <div><strong>{model.role === "TTS" ? "Công cụ Tạo Giọng nói" : "Công cụ Nhận dạng Lời thoại"}</strong><span>{model.label}</span><small>Khoảng {model.size_gb} GB</small></div>
                  {model.installed ? <b><Check size={15} /> Đã sẵn sàng</b> :
                    <button disabled={!!installing} onClick={() => void installModel(model)}>
                      {active ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                      {active ? `${installProgress.toFixed(0)}%` : "Tải model"}
                    </button>}
                  {active && <div className="model-progress"><i style={{width: `${installProgress}%`}} /></div>}
                </article>
              );
            })}
          </div>
          <div style={{ marginTop: "18px", padding: "16px", border: "1px dashed var(--line)", borderRadius: "14px", background: "#f8fafc", textAlign: "left" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "10px" }}>
              <div>
                <strong style={{ display: "block", color: "#27344e", fontSize: "14px" }}>Sử dụng Google Colab GPU</strong>
                <span style={{ display: "block", color: "var(--muted)", fontSize: "11px", marginTop: "3px" }}>Dành cho máy cấu hình yếu, không cần tải model vào ứng dụng local.</span>
              </div>
              <button type="button" onClick={openColabNotebook} style={{ height: "32px", padding: "0 12px", border: "0", borderRadius: "8px", color: "white", background: "var(--blue)", cursor: "pointer", fontSize: "11px", fontWeight: 800, whiteSpace: "nowrap" }}>
                Mở Colab Notebook
              </button>
            </div>
            <ol style={{ margin: "0 0 12px", paddingLeft: "18px", color: "var(--muted)", fontSize: "11px", lineHeight: 1.5 }}>
              <li>Chọn Runtime GPU trong Google Colab rồi chạy toàn bộ notebook.</li>
              <li>Sao chép URL API dạng https://xxx.trycloudflare.com.</li>
              <li>Dán URL bên dưới và bấm Kết nối Colab để vào ứng dụng.</li>
            </ol>
            <div className="settings-dir-input">
              <input
                type="text"
                placeholder="https://xxxx.trycloudflare.com"
                value={colabUrlInput}
                onChange={(e) => setColabUrlInput(e.target.value)}
              />
              <button type="button" disabled={testingColab || savingBackendConfig} onClick={() => void switchBackendMode("colab")}>
                {testingColab || savingBackendConfig ? "Đang kết nối..." : "Kết nối Colab"}
              </button>
            </div>
            {(colabStatus || error) && (
              <div style={{ fontSize: "11px", color: colabStatus.includes("thành công") || colabStatus.includes("Đã chuyển") ? "#24967c" : "#d55f6e", marginTop: "8px", fontWeight: 700 }}>
                {colabStatus || error}
              </div>
            )}
          </div>
          <div className="setup-note"><FolderOpen size={15} /><span>Model được lưu lâu dài tại <strong>{cacheDir}</strong></span></div>
        </div>
      </div>
    );
  }


  const busy = ["preparing", "transcribing", "translating", "generating"].includes(stage);
  const hasTranslation = segments.some((segment) => segment.text_original && segment.text !== segment.text_original);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div><Film size={21} /></div><span><strong>Video Clone</strong><small>Studio dịch thuật & lồng tiếng AI</small></span></div>
        <div style={{ display: "flex", alignItems: "center", justifySelf: "stretch", justifyContent: "flex-start", gap: "32px", width: "100%", minWidth: 0 }}>
          <div className="main-tabs">
            <button
              type="button"
              className={`main-tab-btn ${activeMainTab === "clone" ? "active" : ""}`}
              onClick={() => setActiveMainTab("clone")}
            >
              <Video size={15} /> Clone Video
            </button>
            <button
              type="button"
              className={`main-tab-btn ${activeMainTab === "srt_dub" ? "active" : ""}`}
              onClick={() => setActiveMainTab("srt_dub")}
            >
              <Film size={15} /> Clone Phim
            </button>
            <button
              type="button"
              className={`main-tab-btn ${activeMainTab === "batch" ? "active" : ""}`}
              onClick={() => setActiveMainTab("batch")}
            >
              <FolderOpen size={15} /> Clone Hàng loạt
            </button>
            <button
              type="button"
              className={`main-tab-btn ${activeMainTab === "douyin_download" ? "active" : ""}`}
              onClick={() => setActiveMainTab("douyin_download")}
            >
              <Download size={15} /> Download Video
            </button>
            <button
              type="button"
              className={`main-tab-btn ${activeMainTab === "config" ? "active" : ""}`}
              onClick={() => setActiveMainTab("config")}
            >
              <Settings size={15} /> Cấu Hình
            </button>
            <button
              type="button"
              className={`main-tab-btn ${activeMainTab === "guide" ? "active" : ""}`}
              onClick={() => setActiveMainTab("guide")}
            >
              <BookOpen size={15} /> Hướng Dẫn
            </button>
          </div>

        </div>
        <div style={{ justifySelf: "end", display: "flex", alignItems: "center", gap: "12px" }}>
          <div className="device"><i /><span>{device.toUpperCase()}</span></div>
          <button className="btn-topbar-settings" onClick={() => { setSettingsTab("general"); setActiveMainTab("config"); }} title="Cài đặt">
            <Settings size={16} />
          </button>
        </div>
      </header>

      {activeMainTab === "clone" && stage === "done" && (
        <main className="video-polish-workspace">
          <section className="video-polish-main">
            <div className="video-polish-topbar">
              <button type="button" onClick={() => { setDubPreviewOpen(true); setStage("editing"); }} className="polish-secondary-btn"><Languages size={15} /> {"Quay l\u1ea1i s\u1eeda b\u1ea3n d\u1ecbch"}</button>
              <div>
                <span className="eyebrow">{"XU\u1ea4T VIDEO"}</span>
                <h1>{"C\u0103n ph\u1ee5 \u0111\u1ec1, logo v\u00e0 v\u00f9ng l\u00e0m m\u1edd"}</h1>
              </div>
              <button type="button" onClick={reset} className="polish-secondary-btn"><RefreshCw size={15} /> {"D\u1ef1 \u00e1n m\u1edbi"}</button>
            </div>

            <div className="polish-video-shell">
              <div
                className="polish-video-stage"
                ref={overlayStageRef}
                style={fitVideoStageStyle(videoRatio)}
              >
                <video
                  key={previewVideoUrl}
                  src={previewVideoUrl}
                  controls
                  onTimeUpdate={(e) => setVideoTime(e.currentTarget.currentTime)}
                  onPlay={() => setVideoPlaying(true)}
                  onPause={() => setVideoPlaying(false)}
                  onLoadedMetadata={(e) => {
                    const video = e.currentTarget;
                    if (video.videoWidth && video.videoHeight) {
                      setVideoRatio(video.videoWidth / video.videoHeight);
                      setVideoNativeSize({ width: video.videoWidth, height: video.videoHeight });
                    }
                  }}
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                />
                {blurExistingSubs && blurRegions.filter((region) => blurRegionVisible(region, videoTime)).map((region, index) => (
                  <div
                    key={region.id}
                    className={`polish-blur-region ${region.id === activeBlurRegionId ? "active" : ""}`}
                    style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` }}
                    onPointerDown={startBlurRegionDrag(region.id, "move")}
                  >
                    <span>{index + 1}</span>
                    <i onPointerDown={startBlurRegionDrag(region.id, "resize")} />
                  </div>
                ))}
                {burnVideoSubs && segments.length > 0 && (
                  <div
                    className={`polish-subtitle-region ${subtitleOverlayActive ? "active" : ""}`}
                    style={{
                      left: `${subtitleBox.x * 100}%`,
                      top: `${subtitleBox.y * 100}%`,
                      width: `${subtitleBox.w * 100}%`,
                      height: `${subtitleBox.h * 100}%`,
                    }}
                    onPointerDown={startSubtitleDrag()}
                  >
                    <span>SUB</span>
                    <div
                      className="polish-subtitle-region-text"
                      style={{
                        color: subtitleColor,
                        fontSize: `${previewSubtitleFontPx}px`,
                        fontFamily: `${subtitleFontFamily}, Arial, sans-serif`,
                        backgroundColor: subtitleBgTransparent ? "transparent" : subtitleBgColor,
                        padding: `${previewSubtitlePad}px`,
                        borderRadius: "2px",
                        display: "inline-block",
                        maxWidth: "100%",
                        boxSizing: "border-box",
                      }}
                    >
                      {currentSubtitleText}
                    </div>
                  </div>
                )}
                {logoOverlayEnabled && logoPreviewUrl && (
                  <div
                    className="polish-logo-box"
                    style={{
                      left: `${logoBox.x * 100}%`,
                      top: `${logoBox.y * 100}%`,
                      width: `${logoBox.w * 100}%`,
                      height: `${logoBox.h * 100}%`
                    }}
                    onPointerDown={startLogoDrag("move")}
                  >
                    <img src={logoPreviewUrl} alt="Logo" />
                    <i onPointerDown={startLogoDrag("resize")} />
                  </div>
                )}
              </div>
            </div>

            <div className="polish-controls-band">
              <div className="polish-control-group">
                <label className="overlay-toggle"><input type="checkbox" checked={burnVideoSubs} onChange={(event) => setBurnVideoSubs(event.target.checked)} /><span>{"Th\u00eam ph\u1ee5 \u0111\u1ec1 v\u00e0o video"}</span></label>
                <label>
                  <span>{"Font ch\u1eef"}</span>
                  <select
                    value={subtitleFontFamily}
                    onChange={(event) => {
                      setSubtitleFontFamily(event.target.value);
                      writePref(PrefKeys.exportSubFontFamily, event.target.value);
                    }}
                    style={{ width: "100%", height: "34px", marginTop: "4px", padding: "0 8px", border: "1px solid var(--line)", borderRadius: "8px", background: "#fafbfe", fontSize: "12px", fontWeight: 700 }}
                  >
                    {SUBTITLE_FONT_OPTIONS.map((font) => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </label>
                <label><span>{"C\u1ee1 ch\u1eef"}</span><input type="range" min="18" max="90" value={subtitleFontSize} onChange={(event) => setSubtitleFontSize(Number(event.target.value))} /></label>
                <label><span>{"M\u00e0u ch\u1eef"}</span><input type="color" value={subtitleColor} onChange={(event) => setSubtitleColor(event.target.value)} /></label>
                <label><span>{"M\u00e0u n\u1ec1n"}</span><input type="color" value={subtitleBgColor} disabled={subtitleBgTransparent} onChange={(event) => setSubtitleBgColor(event.target.value)} /></label>
                <label className="overlay-toggle"><input type="checkbox" checked={subtitleBgTransparent} onChange={(event) => { setSubtitleBgTransparent(event.target.checked); writeBoolPref(PrefKeys.exportSubBgTransparent, event.target.checked); }} /><span>{"Kh\u00f4ng n\u1ec1n ph\u1ee5 \u0111\u1ec1"}</span></label>
              </div>

              <div className="polish-control-group">
                <div className="polish-row-title">
                  <label className="overlay-toggle"><input type="checkbox" checked={blurExistingSubs} onChange={(event) => setBlurExistingSubs(event.target.checked)} /><span>{"L\u00e0m m\u1edd ph\u1ee5 \u0111\u1ec1 c\u00f3 s\u1eb5n"}</span></label>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    <button type="button" disabled={ocrScanning || !jobId} onClick={() => void runOcrBlurDetect()}>
                      {ocrScanning ? "Đang quét OCR…" : "OCR tự nhận chữ"}
                    </button>
                    <button type="button" onClick={addBlurRegion}>{"Th\u00eam v\u00f9ng m\u1edd"}</button>
                  </div>
                  <p className="polish-hint">OCR chỉ làm mờ khi có chữ trên màn hình; đoạn không có chữ giữ nguyên.</p>
                </div>
                <div className="blur-region-list">
                  {blurRegions.map((region, index) => (
                    <button key={region.id} type="button" className={region.id === activeBlurRegionId ? "active" : ""} onClick={() => {
                      setActiveBlurRegionId(region.id);
                      setBlurExistingSubs(true);
                      if (region.start != null) {
                        setVideoTime(region.start);
                        const video = overlayStageRef.current?.querySelector("video");
                        if (video) video.currentTime = region.start;
                      }
                    }}>
                      {"V\u00f9ng "}{index + 1}
                      {region.start != null && region.end != null ? ` (${formatTime(region.start)}–${formatTime(region.end)})` : ""}
                      {blurRegions.length > 1 && <span onClick={(event) => { event.stopPropagation(); removeBlurRegion(region.id); }}><X size={12} /></span>}
                    </button>
                  ))}
                </div>
              </div>

              <div className="polish-control-group">
                <label className="overlay-toggle"><input type="checkbox" checked={logoOverlayEnabled} onChange={(event) => setLogoOverlayEnabled(event.target.checked)} /><span>{"Th\u00eam logo"}</span></label>
                <div className="logo-picker-row">
                  <button type="button" onClick={() => logoFileRef.current?.click()}>{"Ch\u1ecdn logo"}</button>
                  <span>{logoFile ? logoFile.name : "PNG, JPG, WEBP"}</span>
                </div>
                <input ref={logoFileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const next = event.target.files?.[0] || null; setLogoFile(next); if (next) setLogoOverlayEnabled(true); }} />
              </div>
            </div>
          </section>

          <aside className="video-polish-side">
            <div className="success-mark"><Check size={22} /></div>
            <h2>{"B\u1ea3n l\u1ed3ng ti\u1ebfng \u0111\u00e3 s\u1eb5n s\u00e0ng"}</h2>
            <p>{tracks.join(", ").toUpperCase()} \u00b7 {exportAudioModeLabel(exportAudioMode)}</p>
            <div className="polish-control-group" style={{ marginBottom: "12px", textAlign: "left" }}>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 800, color: "#7b879f", marginBottom: "6px" }}>
                Âm thanh khi xuất MP4
              </label>
              <select
                value={exportAudioMode}
                onChange={(event) => {
                  const next = event.target.value as ExportAudioMode;
                  setExportAudioMode(next);
                  writePref(PrefKeys.exportAudioMode, next);
                  setPreviewVersion((v) => v + 1);
                }}
                style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "#fafbfe", fontSize: "12px", fontWeight: 700 }}
              >
                <option value="dub_only">Chỉ giọng lồng tiếng</option>
                <option value="dub_with_bg">Lồng tiếng + nhạc nền gốc</option>
                <option value="dub_with_original">Lồng tiếng + âm thanh video gốc</option>
              </select>
              <p className="polish-hint" style={{ marginTop: "6px" }}>
                {exportAudioMode === "dub_with_original"
                  ? "Trộn âm thanh video gốc và lồng tiếng thành 1 track — chỉnh âm lượng bên dưới để nghe thử."
                  : exportAudioMode === "dub_with_bg"
                    ? "Trộn giọng lồng tiếng với nhạc nền/ambient tách từ video gốc."
                    : "Chỉ xuất track giọng lồng tiếng, không trộn nhạc nền hay audio gốc."}
              </p>
              {(exportAudioMode === "dub_with_bg" || exportAudioMode === "dub_with_original") && (
                <label style={{ display: "block", marginTop: "10px" }}>
                  <span style={{ fontSize: "11px", fontWeight: 700, color: "#7b879f" }}>
                    {exportAudioMode === "dub_with_original" ? "Âm lượng video gốc" : "Âm lượng nhạc nền"} ({bgVolume}%)
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="200"
                    value={bgVolume}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setBgVolume(next);
                      writePref(PrefKeys.exportBgVolume, String(next));
                    }}
                    style={{ width: "100%" }}
                  />
                </label>
              )}
              <label style={{ display: "block", marginTop: "8px" }}>
                <span style={{ fontSize: "11px", fontWeight: 700, color: "#7b879f" }}>Âm lượng lồng tiếng ({dubVolume}%)</span>
                <input
                  type="range"
                  min="0"
                  max="200"
                  value={dubVolume}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setDubVolume(next);
                    writePref(PrefKeys.exportDubVolume, String(next));
                  }}
                  style={{ width: "100%" }}
                />
              </label>
              <p className="polish-hint" style={{ marginTop: "6px" }}>Kéo thanh trượt để nghe thử trước khi xuất. Video xuất mặc định 1080p.</p>
            </div>
            <button onClick={() => void saveExport("video")}><Download size={16} /><span><strong>{"Xu\u1ea5t video MP4"}</strong><small>{isColabBackend ? "L\u01b0u l\u00ean Google Drive (Colab)" : "1080p + gi\u1ecdng + ph\u1ee5 \u0111\u1ec1/logo/blur"}</small></span></button>
            <button onClick={() => void saveExport("audio")}><Save size={16} /><span><strong>{"Xu\u1ea5t audio WAV"}</strong><small>{isColabBackend ? "L\u01b0u l\u00ean Google Drive (Colab)" : "Track l\u1ed3ng ti\u1ebfng \u0111\u00e3 mix"}</small></span></button>
            <button onClick={() => void saveExport("srt")}><Languages size={16} /><span><strong>{"Xu\u1ea5t ph\u1ee5 \u0111\u1ec1 SRT"}</strong><small>{isColabBackend ? "L\u01b0u l\u00ean Google Drive (Colab)" : "\u0110\u00fang timeline video"}</small></span></button>
            {driveExportResult && (
              <div className="saved drive-export-notice">
                <Cloud size={14} />
                <span>
                  <strong>{"\u0110\u00e3 xu\u1ea5t l\u00ean Google Drive"}</strong>
                  <small>{driveExportResult.drive_path}</small>
                </span>
                <button type="button" onClick={() => openExternalUrl(driveExportResult.open_url || driveExportResult.folder_url)}>{"M\u1edf Drive"}</button>
              </div>
            )}
            {savedPath && !driveExportResult && <div className="saved" onClick={() => window.videoDubbingDesktop?.openPath(savedPath)}><FolderOpen size={14} /> {"\u0110\u00e3 l\u01b0u: "}{savedPath}</div>}
            <div className="polish-side-actions">
              <button type="button" onClick={() => void generateDub()}><RefreshCw size={15} /> {"T\u1ea1o l\u1ea1i l\u1ed3ng ti\u1ebfng"}</button>
              <button type="button" onClick={() => { setDubPreviewOpen(true); setStage("editing"); }}><Languages size={15} /> {"S\u1eeda b\u1ea3n d\u1ecbch"}</button>
            </div>
          </aside>
        </main>
      )}

      {activeMainTab === "clone" && stage !== "done" && (
        <main className="workspace">
          <aside className="left-panel">
            <div className="panel-head"><span>DỰ ÁN</span>{file && <button onClick={reset}><RefreshCw size={13} /> Mới</button>}</div>
            {!file ? (
              <button className="dropzone" onClick={() => fileRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files[0] || null); }}>
                <div><UploadCloud size={27} /></div><strong>Thả video vào đây</strong>
                <span>MP4, MOV, MKV hoặc WebM</span><b>Chọn video</b>
              </button>
            ) : (
              <SourceVideoPanel
                previewUrl={previewUrl}
                onClose={() => chooseFile(null)}
                videoRef={sourceVideoRef}
                onVideoMetadata={(width, height) => {
                  setVideoNativeSize({ width, height });
                  setVideoRatio(width / height);
                }}
              />
            )}
            <input ref={fileRef} hidden type="file" accept="video/*,.mkv" onChange={(event) => chooseFile(event.target.files?.[0] || null)} />

            <section className="settings-section">
              <label>
                <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                  <Headphones size={14} style={{ color: "var(--blue)" }} /> Nhận dạng giọng nói (ASR)
                </span>
                <select
                  value={asrSelection}
                  onChange={(event) => void selectAsrSelection(event.target.value)}
                  disabled={busy}
                  style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "#fafbfe", fontSize: "13px", fontWeight: 700 }}
                >
                  {asrSelectOptions.map((opt) => (
                    <option key={opt.value} value={opt.value} disabled={!opt.available}>
                      {opt.label}{!opt.available ? " (chưa cài)" : ""}
                    </option>
                  ))}
                </select>
                {(() => {
                  const activeOpt = asrSelectOptions.find((item) => item.value === asrSelection);
                  if (!activeOpt || activeOpt.available) return null;
                  return (
                    <small style={{ display: "block", marginTop: "6px", color: "#b45309", fontSize: "11px", lineHeight: 1.4 }}>
                      {activeOpt.reason || "Engine ASR chưa sẵn sàng trên máy này."}
                    </small>
                  );
                })()}
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <label>
                  <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                    <Languages size={14} style={{ color: "var(--blue)" }} /> Ngôn ngữ gốc
                  </span>
                  <select value={sourceLanguageCode} onChange={(event) => setSourceLanguageCode(event.target.value)} style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "#fafbfe", fontSize: "13px", fontWeight: 700 }}>
                    <option value="auto">Tự động nhận dạng</option>
                    {LANGUAGES.map(([code, , label]) => <option key={code} value={code}>{label}</option>)}
                  </select>
                </label>
                <label>
                  <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                    <Languages size={14} style={{ color: "var(--blue)" }} /> Ngôn ngữ dịch
                  </span>
                  <select value={languageCode} onChange={(event) => setLanguageCode(event.target.value)} style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "#fafbfe", fontSize: "13px", fontWeight: 700 }}>
                    {LANGUAGES.map(([code, , label]) => <option key={code} value={code}>{label}</option>)}
                  </select>
                </label>
              </div>
              <label><span><Sparkles size={14} /> Công cụ dịch</span>
                {renderTranslateProviderSelect(provider, selectTranslateProvider)}
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <label>
                  <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                    <Gauge size={14} style={{ color: "var(--blue)" }} /> Khớp thời lượng
                  </span>
                  <select value={timing} onChange={(event) => setTiming(event.target.value)} style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "#fafbfe", fontSize: "13px", fontWeight: 700 }}>
                    <option value="concise">Tự nhiên, rút gọn</option>
                    <option value="smart_fit">Smart Fit</option>
                    <option value="stretch_video">Co giãn video</option>
                    <option value="strict_slot">Khớp tuyệt đối</option>
                  </select>
                </label>
                <label>
                  <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                    <Mic2 size={14} style={{ color: "var(--blue)" }} /> Giọng mặc định
                  </span>
                  <select
                    value={defaultVoiceId}
                    onChange={(event) => {
                      const val = event.target.value;
                      setDefaultVoiceId(val);
                      localStorage.setItem("defaultVoiceId", val);
                    }}
                    style={{
                      width: "100%",
                      height: "38px",
                      padding: "0 10px",
                      border: "1px solid var(--line)",
                      borderRadius: "10px",
                      outline: "0",
                      color: "#46536d",
                      background: "#fafbfe",
                      fontSize: "13px",
                      fontWeight: 700
                    }}
                  >
                    <option value="">Giọng hệ thống</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.kind === "clone" ? "Clone" : "Thiết kế"})
                      </option>
                    ))}
                  </select>
                </label>
              </div>

            </section>
            {stage === "idle" && file && <button className="primary" onClick={() => void startPipeline()}><WandSparkles size={17} /> Phân tích video <ArrowRight size={16} /></button>}
            {stage === "editing" && !hasTranslation && <button className="primary" onClick={() => void translateAll()}><Languages size={17} /> Dịch toàn bộ <ArrowRight size={16} /></button>}
            {stage === "editing" && hasTranslation && (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <button className="primary" onClick={() => void generateDub()}><Sparkles size={17} /> Tạo bản lồng tiếng <ArrowRight size={16} /></button>
                <button
                  type="button"
                  onClick={() => void translateAll()}
                  style={{
                    width: "100%",
                    height: "40px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                    border: "1px solid #bdcaf3",
                    borderRadius: "12px",
                    color: "var(--blue)",
                    background: "#edf2ff",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: 800,
                    transition: "all 0.2s"
                  }}
                >
                  <Languages size={16} /> Dịch lại (Chọn công cụ khác)
                </button>
              </div>
            )}
            {busy && <div className="busy-card"><LoaderCircle className="spin" /><div><strong>{stageLabel}</strong><span>Vui lòng giữ ứng dụng đang mở</span></div></div>}
          </aside>
 
          <section className="editor">
            {activeMainTab === "clone" && (
              <div className="pipeline" style={{ margin: "0 0 4px 0" }}>
                {[
                  ["Video", "idle"], ["Nhận dạng", "transcribing"], ["Dịch thuật", "translating"],
                  ["Lồng tiếng", "generating"], ["Xuất bản", "done"]
                ].map(([label], index) => {
                  const progress = stage === "idle" ? 0 : stage === "preparing" ? 0 : stage === "transcribing" ? 1 :
                    stage === "editing" ? (hasTranslation ? 3 : 2) : stage === "translating" ? 2 :
                    stage === "generating" ? 3 : 4;
                  return <div key={label} className={index < progress ? "complete" : index === progress ? "active" : ""}>
                    <i>{index < progress ? <Check size={11} /> : index + 1}</i><span>{label}</span>{index < 4 && <ChevronRight size={13} />}
                  </div>;
                })}
              </div>
            )}
            <div className="editor-head">
              <div><span className="eyebrow">KỊCH BẢN LỒNG TIẾNG</span><h1>{segments.length ? `${segments.length} đoạn thoại` : "Bản dịch sẽ xuất hiện tại đây"}</h1></div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                {hasDubbedTracks && (
                  <button
                    type="button"
                    className="dub-preview-toggle"
                    onClick={() => setDubPreviewOpen((open) => !open)}
                  >
                    <Play size={14} /> {dubPreviewOpen ? "Ẩn xem trước video" : "Xem video lồng tiếng + phụ đề"}
                  </button>
                )}
                {segments.length > 0 && (
                  <div className="duration"><Clock3 size={14} /> {formatTime(Math.max(...segments.map((item) => item.end)))}</div>
                )}
              </div>
            </div>
            {hasDubbedTracks && dubPreviewOpen && (
              <div className="edit-dub-preview">
                <div className="polish-video-shell edit-dub-preview-shell">
                  <div
                    className="polish-video-stage"
                    ref={editPreviewStageRef}
                    style={fitVideoStageStyle(videoRatio)}
                  >
                    <video
                      key={`edit-${previewVideoUrl}`}
                      src={previewVideoUrl}
                      controls
                      onTimeUpdate={(e) => setEditPreviewTime(e.currentTarget.currentTime)}
                      onPlay={() => setEditPreviewPlaying(true)}
                      onPause={() => setEditPreviewPlaying(false)}
                      onLoadedMetadata={(e) => {
                        const video = e.currentTarget;
                        if (video.videoWidth && video.videoHeight) {
                          setVideoRatio(video.videoWidth / video.videoHeight);
                          setVideoNativeSize({ width: video.videoWidth, height: video.videoHeight });
                        }
                      }}
                      style={{ width: "100%", height: "100%", objectFit: "contain" }}
                    />
                    {segments.length > 0 && (
                      <div
                        className="polish-subtitle-region active preview-only"
                        style={{
                          left: `${subtitleBox.x * 100}%`,
                          top: `${subtitleBox.y * 100}%`,
                          width: `${subtitleBox.w * 100}%`,
                          height: `${subtitleBox.h * 100}%`,
                          color: subtitleColor,
                          backgroundColor: subtitleBgColor,
                          fontSize: `${editPreviewSubtitleFontPx}px`,
                          fontFamily: "Arial, Helvetica, sans-serif"
                        }}
                      >
                        <div className="polish-subtitle-region-text">{editPreviewSubtitleText}</div>
                      </div>
                    )}
                  </div>
                </div>
                <p className="edit-dub-preview-hint">Audio lồng tiếng và phụ đề đồng bộ theo timeline — dùng để kiểm tra trước khi xuất.</p>
              </div>
            )}
            {error && <div className="error-box"><X size={15} />{error}</div>}
            {!segments.length && stage !== "transcribing" ? (
              <div className="empty-editor">
                <div className="empty-visual"><Video size={38} /><span><Languages size={20} /></span></div>
                <h2>Biến video thành bản địa hóa hoàn chỉnh</h2>
                <p>Tải video lên để tự động tách lời thoại, nhận dạng nội dung, dịch và tạo giọng nói mới theo đúng timeline.</p>
                <div><span><b>01</b> Nhận dạng</span><i /><span><b>02</b> Dịch thuật</span><i /><span><b>03</b> Lồng tiếng</span></div>
              </div>
            ) : (
              <div ref={segmentListRef} className="segment-list">
                {segments.length === 0 && stage === "transcribing" && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px", color: "var(--muted)", gap: "10px", width: "100%" }}>
                    <LoaderCircle className="spin" size={24} style={{ color: "var(--blue)" }} />
                    <span style={{ fontSize: "13px", fontWeight: 700 }}>Đang nhận dạng phân đoạn đầu tiên...</span>
                  </div>
                )}
                {segments.map((segment, index) => {
                  const activeProfileId = segment.profile_id || defaultVoiceId;
                  return (
                    <div key={String(segment.id)} className="segment-row-card">
                      {/* Left sidebar: Index, Time range, Play icon */}
                      <div className="segment-row-sidebar">
                        <span className="segment-row-index">{String(index + 1).padStart(2, "0")}</span>
                        <span className="segment-row-time">{formatTime(segment.start)} — {formatTime(segment.end)}</span>
                        <button
                          type="button"
                          className="segment-row-play-btn"
                          onClick={() => playSegmentPreview(segment, index)}
                          title="Nghe thử đoạn"
                        >
                          <Play size={14} />
                        </button>
                      </div>

                      {/* Original Text (Red Theme) */}
                      <div className="segment-col-original">
                        <span className="segment-col-label original-label">Ngôn ngữ gốc</span>
                        <textarea
                          readOnly
                          className="segment-col-textarea original-textarea"
                          value={segment.text_original || segment.text}
                          placeholder="Chưa có văn bản gốc..."
                        />
                      </div>

                      {/* Translated Text (Blue Theme) - Editable */}
                      <div className="segment-col-translated">
                        <span className="segment-col-label translated-label">Bản dịch</span>
                        <textarea
                          className="segment-col-textarea translated-textarea"
                          value={segment.text}
                          onChange={(event) => {
                            const value = event.target.value;
                            setSegments((current) =>
                              current.map((item) =>
                                String(item.id) === String(segment.id) ? { ...item, text: value } : item
                              )
                            );
                          }}
                          placeholder="Đang dịch..."
                        />
                      </div>

                      {/* Voice selection (Right side of each segment) */}
                      <div className="segment-col-voice">
                        <span className="segment-col-label voice-label">Giọng đọc</span>
                        <select
                          value={segment.profile_id || ""}
                          onChange={(event) => {
                            const val = event.target.value;
                            setSegments((current) =>
                              current.map((item) =>
                                String(item.id) === String(segment.id) ? { ...item, profile_id: val } : item
                              )
                            );
                          }}
                          className="segment-voice-select"
                        >
                          <option value="">
                            {defaultVoiceId && profiles.find(p => p.id === defaultVoiceId)
                              ? `Mặc định (${profiles.find(p => p.id === defaultVoiceId)?.name})`
                              : "Giọng mặc định"}
                          </option>
                          <option value="system">Giọng hệ thống</option>
                          {profiles.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.kind === "clone" ? "Clone" : "Thiết kế"})
                            </option>
                          ))}
                        </select>
                        <div className="segment-row-char-stats">
                          <span>{segment.text.length} ký tự</span>
                          <span>{(segment.end - segment.start).toFixed(1)}s</span>
                        </div>
                      </div>
                      <div className="segment-row-timeline-wrap">
                        <SegmentTimeline
                          start={segment.start}
                          end={segment.end}
                          disabled={busy}
                          onSplit={(splitTime) => splitSegmentAt(index, splitTime)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </main>
      )}

      {activeMainTab === "srt_dub" && (
        <main className="cinematic-workspace">
          {/* Neon Stepper Progress */}
          <div className="neon-stepper">
            {[
              ["Nạp Dữ Liệu", "idle"],
              ["Biên Tập Phụ Đề", "editing"],
              ["Dịch Thuật", "translating"],
              ["Tạo Lồng Tiếng", "generating"],
              ["Xuất Bản Kết Quả", "done"]
            ].map(([lbl, val], idx) => {
              const activeIdx = srtStage === "idle" ? 0 : srtStage === "preparing" ? 0 : srtStage === "editing" ? 1 : srtStage === "translating" ? 2 : srtStage === "generating" ? 3 : 4;
              const isComp = idx < activeIdx;
              const isActive = idx === activeIdx;
              return (
                <div key={lbl} style={{ display: "flex", alignItems: "center", flex: idx === 4 ? "none" : 1 }}>
                  <div className={`neon-step ${isComp ? "complete" : isActive ? "active" : ""}`}>
                    <div className="neon-step-dot">{isComp ? <Check size={11} /> : idx + 1}</div>
                    <span>{lbl}</span>
                  </div>
                  {idx < 4 && <div className={`neon-step-line ${isComp ? "complete" : isActive ? "active" : ""}`} />}
                </div>
              );
            })}
          </div>

          {srtError && (
            <div className="error-box" style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)", color: "#f87171" }}>
              <X size={15} /> {srtError}
            </div>
          )}

          {/* Idle screen with dropzones */}
          {srtStage === "idle" && (
            <div className="cinematic-upload-grid">
              <div 
                className={`cinematic-upload-card ${srtFile ? "has-file" : ""}`}
                onClick={() => srtSrtFileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files[0]) chooseSrtFile(e.dataTransfer.files[0]);
                }}
              >
                <div className="cinematic-upload-card-icon">
                  <FileText size={24} />
                </div>
                <h3>{srtFile ? "Đã chọn file phụ đề" : "Tải lên file phụ đề SRT"}</h3>
                <p>{srtFile ? srtFile.name : "Kéo thả file .srt vào đây hoặc click để chọn"}</p>
                {srtFile && <span style={{ color: "#10b981", fontSize: "11px", fontWeight: 700 }}>{(srtFile.size / 1024).toFixed(1)} KB</span>}
                <input ref={srtSrtFileRef} type="file" accept=".srt" hidden onChange={(e) => chooseSrtFile(e.target.files?.[0] || null)} />
              </div>

              <div 
                className={`cinematic-upload-card ${srtVideoFile ? "has-file" : ""}`}
                onClick={() => srtVideoFileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files[0]) chooseSrtVideoFile(e.dataTransfer.files[0]);
                }}
              >
                <div className="cinematic-upload-card-icon">
                  <Video size={24} />
                </div>
                <h3>{srtVideoFile ? "Đã chọn file video" : "Thêm file video (Tùy chọn)"}</h3>
                <p>{srtVideoFile ? srtVideoFile.name : "Kéo thả video để xuất video lồng tiếng + nhúng sub"}</p>
                {srtVideoFile && <span style={{ color: "#10b981", fontSize: "11px", fontWeight: 700 }}>{(srtVideoFile.size / 1024 / 1024).toFixed(1)} MB</span>}
                <input ref={srtVideoFileRef} type="file" accept="video/*,.mkv" hidden onChange={(e) => chooseSrtVideoFile(e.target.files?.[0] || null)} />
              </div>
            </div>
          )}

          {srtStage === "idle" && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: "10px" }}>
              <button 
                className="btn-neon" 
                style={{ width: "240px" }} 
                disabled={!srtFile} 
                onClick={startSrtPipeline}
              >
                <Sparkles size={16} /> Bắt đầu xử lý phụ đề
              </button>
            </div>
          )}

          {/* Preparing screen */}
          {srtStage === "preparing" && (
            <div className="cinematic-empty">
              <div className="cinematic-empty-icon">
                <LoaderCircle className="spin" size={30} style={{ color: "#38bdf8" }} />
              </div>
              <h3>{srtPrepLabel}</h3>
              <div className="progress-led-container" style={{ width: "300px" }}>
                <div className="progress-led-fill" style={{ width: `${srtPrepProgress}%` }} />
              </div>
              <p style={{ marginTop: "5px" }}>Vui lòng giữ ứng dụng mở trong khi xử lý dữ liệu.</p>
            </div>
          )}

          {/* Core workspace stages */}
          {srtStage !== "idle" && srtStage !== "preparing" && (
            <div className="cinematic-panels">
              {/* Left Configuration Panel */}
              <aside className="glass-panel" style={{ maxHeight: "calc(100vh - 180px)", overflowY: "auto" }}>
                <div className="glass-panel-title">
                  <Settings size={15} style={{ color: "#38bdf8" }} /> Thiết lập dự án
                </div>

                <section className="settings-section" style={{ borderTop: "none", paddingTop: 0 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "13px" }}>
                    <label>
                      <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                        <Languages size={14} style={{ color: "var(--blue)" }} /> Ngôn ngữ dịch
                      </span>
                      <select value={srtLanguageCode} onChange={(event) => setSrtLanguageCode(event.target.value)} style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "#fafbfe", fontSize: "13px", fontWeight: 700 }}>
                        {LANGUAGES.map(([code, , label]) => <option key={code} value={code}>{label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                        <Sparkles size={14} style={{ color: "var(--blue)" }} /> Công cụ dịch
                      </span>
                      {renderTranslateProviderSelect(srtProvider, selectTranslateProvider)}
                    </label>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "13px" }}>
                    <label>
                      <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                        <Gauge size={14} style={{ color: "var(--blue)" }} /> Khớp thời lượng
                      </span>
                      <select 
                        value={srtTiming} 
                        onChange={(event) => setSrtTiming(event.target.value)} 
                        style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "#fafbfe", fontSize: "13px", fontWeight: 700 }}
                      >
                        <option value="strict_slot">Khớp tuyệt đối</option>
                        <option value="concise">Tự nhiên, rút gọn</option>
                        <option value="smart_fit">Smart Fit</option>
                        <option value="stretch_video">Co giãn video</option>
                      </select>
                    </label>
                    <label>
                      <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                        <Mic2 size={14} style={{ color: "var(--blue)" }} /> Giọng mặc định
                      </span>
                      <select
                        value={srtVoiceId}
                        onChange={(event) => setSrtVoiceId(event.target.value)}
                        style={{
                          width: "100%",
                          height: "38px",
                          padding: "0 10px",
                          border: "1px solid var(--line)",
                          borderRadius: "10px",
                          outline: "0",
                          color: "#46536d",
                          background: "#fafbfe",
                          fontSize: "13px",
                          fontWeight: 700
                        }}
                      >
                        <option value="">
                          {defaultVoiceId && profiles.find(p => p.id === defaultVoiceId)
                            ? `Mặc định (${profiles.find(p => p.id === defaultVoiceId)?.name})`
                            : "Chọn giọng Clone / System"}
                        </option>
                        <option value="system">Giọng hệ thống</option>
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.kind === "clone" ? "Clone" : "Thiết kế"})
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </section>

                {/* Video Preview Card (if video uploaded) */}
                {srtVideoPreviewUrl && (
                  <div className="cinematic-form-group">
                    <label>Video xem trước</label>
                    <div
                      className="cinematic-player-card"
                      style={fitVideoStageStyle(srtVideoRatio)}
                    >
                      <video
                        src={srtPreviewVideoUrl}
                        controls
                        onTimeUpdate={(e) => setSrtVideoTime(e.currentTarget.currentTime)}
                        onPlay={() => setSrtVideoPlaying(true)}
                        onPause={() => setSrtVideoPlaying(false)}
                        onLoadedMetadata={(e) => {
                          const video = e.currentTarget;
                          if (video.videoWidth && video.videoHeight) {
                            setSrtVideoRatio(video.videoWidth / video.videoHeight);
                          }
                        }}
                        style={{ width: "100%", height: "100%" }}
                      />
                      {srtStage === "done" && currentSrtSubtitleText && (
                        <div
                          style={{
                            position: "absolute",
                            bottom: "10%",
                            left: "50%",
                            transform: "translateX(-50%)",
                            color: "#ffffff",
                            backgroundColor: "rgba(0, 0, 0, 0.65)",
                            padding: "6px 12px",
                            borderRadius: "6px",
                            fontSize: "13px",
                            fontWeight: "bold",
                            textAlign: "center",
                            maxWidth: "85%",
                            pointerEvents: "none",
                            zIndex: 5,
                            textShadow: "0 1px 2px rgba(0,0,0,0.8)",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word"
                          }}
                        >
                          {currentSrtSubtitleText}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Workflow Buttons */}
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "20px" }}>
                  <button 
                    className="btn-neon" 
                    disabled={srtStage === "translating" || srtStage === "generating"}
                    onClick={translateSrtAll}
                  >
                    {srtStage === "translating" ? (
                      <>
                        <LoaderCircle className="spin" size={15} /> Đang dịch phụ đề...
                      </>
                    ) : (
                      <>
                        <Languages size={15} /> Dịch toàn bộ kịch bản
                      </>
                    )}
                  </button>

                  <button 
                    className="btn-neon" 
                    style={{ background: "linear-gradient(135deg, #0ea5e9, #0284c7)", color: "#ffffff" }}
                    disabled={srtStage === "translating" || srtStage === "generating"}
                    onClick={generateSrtDub}
                  >
                    {srtStage === "generating" ? (
                      <>
                        <LoaderCircle className="spin" size={15} /> Đang lồng tiếng ({srtProgressCurrent}/{srtProgressTotal})...
                      </>
                    ) : (
                      <>
                        <Mic2 size={15} /> Bắt đầu tạo lồng tiếng
                      </>
                    )}
                  </button>

                  <button 
                    className="btn-cinematic-download" 
                    style={{ border: "1px solid rgba(239, 68, 68, 0.2)", color: "#f87171" }}
                    onClick={resetSrt}
                  >
                    <RefreshCw size={14} /> Làm mới & Hủy dự án
                  </button>
                </div>

                {/* Publishing Suite */}
                {srtStage === "done" && (
                  <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid rgba(255, 255, 255, 0.08)" }}>
                    <div className="glass-panel-title" style={{ borderBottom: "none", marginBottom: "10px" }}>
                      <Download size={14} style={{ color: "#10b981" }} /> Xuất bản kết quả
                    </div>

                    {/* Audio format selector */}
                    <div className="cinematic-form-group">
                      <label>Âm thanh khi xuất MP4 / WAV</label>
                      <select
                        className="cinematic-select"
                        value={exportAudioMode}
                        onChange={(event) => {
                          const next = event.target.value as ExportAudioMode;
                          setExportAudioMode(next);
                          writePref(PrefKeys.exportAudioMode, next);
                        }}
                      >
                        <option value="dub_only">Chỉ giọng lồng tiếng</option>
                        <option value="dub_with_bg">Lồng tiếng + nhạc nền gốc</option>
                        <option value="dub_with_original">Lồng tiếng + âm thanh video gốc</option>
                      </select>
                      <p className="polish-hint" style={{ marginTop: "6px", fontSize: "11px", opacity: 0.85 }}>
                        {exportAudioMode === "dub_with_original"
                          ? "Trộn âm thanh video gốc và lồng tiếng thành 1 track — chỉnh âm lượng ở bước xuất video."
                          : exportAudioMode === "dub_with_bg"
                            ? "Trộn giọng lồng tiếng với nhạc nền từ video gốc."
                            : "Chỉ xuất giọng lồng tiếng, không trộn nhạc nền hay audio gốc."}
                      </p>
                    </div>

                    <div className="cinematic-form-group">
                      <label>Định dạng tệp âm thanh</label>
                      <select 
                        className="cinematic-select" 
                        value={srtOutFormat}
                        onChange={(e) => setSrtOutFormat(e.target.value)}
                      >
                        <option value="wav">WAV (Chất lượng cao nhất)</option>
                        <option value="mp3">MP3 (Nhẹ & Phổ biến)</option>
                        <option value="m4a">M4A (Chuẩn Apple)</option>
                        <option value="flac">FLAC (Nén không mất chi tiết)</option>
                      </select>
                    </div>

                    {/* Subtitle burning switch (only if video uploaded) */}
                    {srtVideoFile && (
                      <div className="cinematic-form-group" style={{ background: "rgba(255, 255, 255, 0.02)", padding: "10px", borderRadius: "8px", border: "1px solid rgba(255, 255, 255, 0.05)" }}>
                        <label className="toggle-switch-label">
                          <span>Nhúng phụ đề cứng vào video</span>
                          <span className="toggle-switch-wrapper">
                            <input 
                              type="checkbox" 
                              checked={srtBurnSubs} 
                              onChange={(e) => setSrtBurnSubs(e.target.checked)} 
                            />
                            <span className="toggle-switch-slider" />
                          </span>
                        </label>
                      </div>
                    )}

                    <div className="cinematic-export-grid">
                      {srtVideoFile && (
                        <button 
                          className="btn-cinematic-download" 
                          style={{ background: "rgba(56, 189, 248, 0.08)", border: "1px solid rgba(56, 189, 248, 0.3)", color: "#38bdf8" }}
                          onClick={() => saveSrtExport("video")}
                        >
                          <Film size={15} /> Tải Video Phim
                        </button>
                      )}
                      
                      <button 
                        className="btn-cinematic-download"
                        onClick={() => saveSrtExport("audio")}
                      >
                        <Music size={15} /> Tải Âm Thanh
                      </button>

                      <button 
                        className="btn-cinematic-download"
                        onClick={() => saveSrtExport("srt")}
                      >
                        <FileText size={15} /> Tải File SRT Dịch
                      </button>
                    </div>
                  </div>
                )}
              </aside>

              {/* Right Subtitles Timeline Editor */}
              <section className="glass-panel" style={{ flex: 1 }}>
                <div className="cinematic-editor-head">
                  <h2>Danh sách phân đoạn phụ đề</h2>
                  {srtSegments.length > 0 && (
                    <span className="cinematic-segment-time" style={{ background: "rgba(56, 189, 248, 0.1)", color: "#38bdf8" }}>
                      Tổng: {srtSegments.length} dòng
                    </span>
                  )}
                </div>

                {!srtSegments.length ? (
                  <div className="cinematic-empty">
                    <div className="cinematic-empty-icon">
                      <FileText size={26} />
                    </div>
                    <h3>Kịch bản rỗng</h3>
                    <p>Không tìm thấy dòng phụ đề nào được phân tích.</p>
                  </div>
                ) : (
                  <div ref={srtSegmentListRef} className="cinematic-editor-scroll">
                    {srtSegments.map((seg, idx) => {
                      return (
                        <div 
                          key={String(seg.id)} 
                          className="cinematic-segment-card"
                          style={srtSelectedId === String(seg.id) ? { borderColor: "rgba(56, 189, 248, 0.5)", background: "rgba(30, 41, 59, 0.6)" } : {}}
                          onClick={() => setSrtSelectedId(String(seg.id))}
                        >
                          {/* Segment metadata header */}
                          <div className="cinematic-segment-meta">
                            <span className="cinematic-segment-index">DÒNG {String(idx + 1).padStart(2, "0")}</span>
                            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                              <span className="cinematic-segment-time">
                                {formatTime(seg.start)} — {formatTime(seg.end)}
                              </span>
                              <button 
                                className="cinematic-play-btn" 
                                title="Nghe thử phân đoạn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  playSrtSegmentPreview(seg, idx);
                                }}
                              >
                                <Play size={11} fill="currentColor" />
                              </button>
                            </div>
                          </div>

                          {/* Fields row */}
                          <div className="cinematic-fields-row">
                            {/* Original Text */}
                            <div className="cinematic-textbox-wrapper">
                              <span className="cinematic-badge original">Gốc (SRT)</span>
                              <textarea 
                                className="cinematic-textarea original-locked" 
                                readOnly 
                                value={seg.text_original || seg.text}
                              />
                            </div>

                            {/* Translated Text */}
                            <div className="cinematic-textbox-wrapper">
                              <span className="cinematic-badge translated">Bản dịch (Editable)</span>
                              <textarea 
                                className="cinematic-textarea" 
                                value={seg.text}
                                onChange={(e) => {
                                  const textVal = e.target.value;
                                  setSrtSegments((current) => 
                                    current.map((item) => 
                                      String(item.id) === String(seg.id) ? { ...item, text: textVal } : item
                                    )
                                  );
                                }}
                              />
                            </div>

                            {/* Segment Voice Override */}
                            <div className="cinematic-textbox-wrapper">
                              <span className="cinematic-badge" style={{ background: "rgba(255, 255, 255, 0.05)", color: "#cbd5e1" }}>Giọng đọc phân vai</span>
                              <select 
                                className="cinematic-select" 
                                style={{ height: "48px", fontSize: "12px" }}
                                value={seg.profile_id || ""}
                                onChange={(e) => {
                                  const profileVal = e.target.value;
                                  setSrtSegments((current) => 
                                    current.map((item) => 
                                      String(item.id) === String(seg.id) ? { ...item, profile_id: profileVal } : item
                                    )
                                  );
                                }}
                              >
                                <option value="">
                                  {srtVoiceId && profiles.find(p => p.id === srtVoiceId)
                                    ? `Mẫu (${profiles.find(p => p.id === srtVoiceId)?.name})`
                                    : defaultVoiceId && profiles.find(p => p.id === defaultVoiceId)
                                    ? `Mặc định (${profiles.find(p => p.id === defaultVoiceId)?.name})`
                                    : "Giọng mặc định"}
                                </option>
                                <option value="system">Giọng hệ thống</option>
                                {profiles.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name} ({p.kind === "clone" ? "Clone" : "Thiết kế"})
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}
        </main>
      )}

      {activeMainTab === "douyin_download" && (
        <main className="workspace">
          <aside className="left-panel">
            <div className="panel-head"><span>CẤU HÌNH TẢI VIDEO</span></div>
            
            <section className="settings-section" style={{ borderTop: "none", paddingTop: 0 }}>
              {/* URL Input */}
              <div className="settings-form-group">
                <label style={{ fontSize: "12px", fontWeight: 750, color: "#717c91", display: "block", marginBottom: "7px" }}>
                  Đường dẫn video (Douyin, YouTube, TikTok...)
                </label>
                <input
                  type="text"
                  placeholder="Nhập link video hoặc trang cá nhân Douyin..."
                  value={dyUrl}
                  onChange={(e) => setDyUrl(e.target.value)}
                  disabled={dyIsDownloading}
                  style={{
                    width: "100%",
                    height: "38px",
                    padding: "0 10px",
                    border: "1px solid var(--line)",
                    borderRadius: "10px",
                    outline: "0",
                    color: "#27344e",
                    background: "#fafbfe",
                    fontSize: "13px",
                    fontWeight: 600
                  }}
                />
                {dyUrl.trim() && (
                  <span style={{ display: "block", marginTop: "6px", fontSize: "11px", fontWeight: 700, color: "var(--muted)" }}>
                    {dyUrlIsDouyin ? "Douyin — dùng dy-downloader (cần Cookie)" : "Khác — dùng yt-dlp"}
                  </span>
                )}
              </div>

              {/* Download Directory */}
              <div className="settings-form-group">
                <label style={{ fontSize: "12px", fontWeight: 750, color: "#717c91", display: "block", marginBottom: "7px" }}>
                  <FolderOpen size={14} style={{ color: "var(--blue)", marginRight: "5px", verticalAlign: "middle" }} /> Thư mục chứa file tải xuống
                </label>
                <div className="settings-dir-input">
                  <input
                    type="text"
                    readOnly
                    placeholder="Chưa chọn thư mục lưu"
                    value={dyDownloadDir}
                    style={{ background: "#fafbfe" }}
                  />
                  <button
                    type="button"
                    disabled={dyIsDownloading}
                    onClick={async () => {
                      if (window.videoDubbingDesktop) {
                        const dir = await window.videoDubbingDesktop.selectDirectory();
                        if (dir) {
                          setDyDownloadDir(dir);
                          localStorage.setItem("dyDownloadDir", dir);
                        }
                      }
                    }}
                  >
                    Chọn
                  </button>
                </div>
              </div>

              {/* Download Options (MP4 only vs Full) */}
              <div className="settings-form-group">
                <label style={{ fontSize: "12px", fontWeight: 750, color: "#717c91", display: "block", marginBottom: "7px" }}>
                  Định dạng tải về
                </label>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="dyOnlyMp4"
                      checked={dyOnlyMp4}
                      onChange={() => setDyOnlyMp4(true)}
                      disabled={dyIsDownloading}
                      style={{ marginTop: "3px" }}
                    />
                    <div>
                      <span style={{ fontSize: "13px", fontWeight: 700, color: "#46536d" }}>Chỉ tải video MP4</span>
                      <span style={{ display: "block", fontSize: "11px", color: "var(--muted)" }}>Lưu trực tiếp vào thư mục (không tạo thư mục riêng cho từng video)</span>
                    </div>
                  </label>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="dyOnlyMp4"
                      checked={!dyOnlyMp4}
                      onChange={() => setDyOnlyMp4(false)}
                      disabled={dyIsDownloading}
                      style={{ marginTop: "3px" }}
                    />
                    <div>
                      <span style={{ fontSize: "13px", fontWeight: 700, color: "#46536d" }}>Tải đầy đủ tài nguyên</span>
                      <span style={{ display: "block", fontSize: "11px", color: "var(--muted)" }}>Tự động tạo thư mục riêng cho từng video (bao gồm cả ảnh bìa, file âm thanh riêng...)</span>
                    </div>
                  </label>
                </div>
              </div>

              {/* Download Scope (Douyin only) */}
              {dyUrlIsDouyin && (
              <div className="settings-form-group">
                <label style={{ fontSize: "12px", fontWeight: 750, color: "#717c91", display: "block", marginBottom: "7px" }}>
                  Phạm vi tải xuống
                </label>
                <div style={{ display: "flex", gap: "20px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", fontWeight: 700, color: "#46536d" }}>
                    <input
                      type="radio"
                      name="dyIsUser"
                      checked={!dyIsUser}
                      onChange={() => setDyIsUser(false)}
                      disabled={dyIsDownloading}
                    />
                    Liên kết đơn lẻ
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", fontWeight: 700, color: "#46536d" }}>
                    <input
                      type="radio"
                      name="dyIsUser"
                      checked={dyIsUser}
                      onChange={() => setDyIsUser(true)}
                      disabled={dyIsDownloading}
                    />
                    Toàn bộ User
                  </label>
                </div>
              </div>
              )}
            </section>

            {dyError && (
              <div className="error-box" style={{ marginTop: "12px" }}>
                <X size={15} /> {dyError}
              </div>
            )}

            {dyUrlIsDouyin && !douyinCookie && (
              <div style={{
                background: "#fff5f6",
                border: "1px solid #f1cfd5",
                borderRadius: "12px",
                padding: "12px",
                marginTop: "12px",
                display: "flex",
                flexDirection: "column",
                gap: "8px"
              }}>
                <span style={{ fontSize: "12px", color: "#d55f6e", fontWeight: 700 }}>
                  ⚠️ Chưa cấu hình Cookie Douyin. Vui lòng đăng nhập trước.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSettingsTab("douyin");
                    setActiveMainTab("config");
                  }}
                  style={{
                    padding: "6px 12px",
                    background: "#d55f6e",
                    color: "white",
                    border: "none",
                    borderRadius: "8px",
                    fontSize: "11px",
                    fontWeight: 800,
                    cursor: "pointer",
                    alignSelf: "flex-start"
                  }}
                >
                  Đăng nhập ngay
                </button>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "16px" }}>
              <button
                className="primary"
                disabled={
                  dyIsDownloading ||
                  !dyUrl.trim() ||
                  !dyDownloadDir ||
                  (dyUrlIsDouyin && !douyinCookie)
                }
                onClick={handleVideoDownload}
              >
                {dyIsDownloading ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}
                {dyIsDownloading ? "Đang tiến hành tải..." : "Bắt đầu tải xuống"}
              </button>

              {dyIsDownloading && dyUrlIsDouyin && (
                <button
                  type="button"
                  onClick={handleCancelDouyinDownload}
                  style={{
                    width: "100%",
                    height: "40px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                    border: "1px solid #f1cfd5",
                    borderRadius: "12px",
                    color: "#d55f6e",
                    background: "#fff5f6",
                    cursor: "pointer",
                    fontSize: "13px",
                    fontWeight: 800,
                    transition: "all 0.2s"
                  }}
                >
                  <X size={16} /> Hủy tải xuống
                </button>
              )}
            </div>
          </aside>

          <section className="editor">
            <div className="editor-head">
              <div>
                <span className="eyebrow">TIẾN TRÌNH TẢI XUỐNG</span>
                <h1>{dyIsDownloading ? "Đang xử lý tải video..." : "Trạng thái tải xuống"}</h1>
              </div>
            </div>

            {dyStatusType ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "24px", height: "100%", overflowY: "auto" }}>
                {/* Progress bar */}
                <div style={{ background: "white", border: "1px solid var(--line)", borderRadius: "16px", padding: "20px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontWeight: 750 }}>
                    <span style={{ color: "#46536d" }}>Tiến độ tải xuống</span>
                    <span style={{ color: "var(--blue)" }}>
                      {dyTotalCount > 0 ? Math.round((dyDownloadedCount / dyTotalCount) * 100) : 0}%
                    </span>
                  </div>
                  <div style={{ height: "8px", background: "#edf2ff", borderRadius: "99px", overflow: "hidden", marginBottom: "12px" }}>
                    <div
                      style={{
                        height: "100%",
                        background: "linear-gradient(90deg, var(--blue), var(--mint))",
                        width: `${dyTotalCount > 0 ? (dyDownloadedCount / dyTotalCount) * 100 : 0}%`,
                        transition: "width 0.4s ease-out"
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", fontWeight: 700 }}>
                    <span style={{ color: "var(--muted)" }}>Số lượng đã tải:</span>
                    <span style={{ color: "#27344e" }}>{dyDownloadedCount} / {dyTotalCount} video</span>
                  </div>
                </div>

                {/* Status Box */}
                <div style={{
                  background: dyStatusType === "done" ? "#f0fdf4" : dyStatusType === "failed" ? "#fff5f6" : "#fafbfe",
                  border: "1px solid " + (dyStatusType === "done" ? "#b6e8d4" : dyStatusType === "failed" ? "#f1cfd5" : "var(--line)"),
                  borderRadius: "14px",
                  padding: "16px 20px",
                  display: "flex",
                  alignItems: "center",
                  gap: "12px"
                }}>
                  <div style={{
                    width: "36px",
                    height: "36px",
                    borderRadius: "10px",
                    background: dyStatusType === "done" ? "#d1f5e8" : dyStatusType === "failed" ? "#ffe3e6" : "#edf2ff",
                    display: "grid",
                    placeItems: "center",
                    color: dyStatusType === "done" ? "#1a7c61" : dyStatusType === "failed" ? "#d55f6e" : "var(--blue)",
                    flexShrink: 0
                  }}>
                    {dyStatusType === "done" ? <Check size={18} /> : dyStatusType === "failed" ? <X size={18} /> : <LoaderCircle className="spin" size={18} />}
                  </div>
                  <div>
                    <span style={{ display: "block", fontSize: "11px", fontWeight: 800, color: "var(--muted)", textTransform: "uppercase" }}>Trạng thái hiện tại</span>
                    <span style={{ display: "block", fontSize: "14px", fontWeight: 700, color: "#27344e", marginTop: "2px" }}>
                      {dyStatusText || "Đang kết nối..."}
                    </span>
                  </div>
                </div>

                {/* Downloaded Items List */}
                {dyDownloadedItems.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "10px" }}>
                    <div style={{ fontSize: "11px", fontWeight: 800, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                      Danh sách đã tải ({dyDownloadedItems.length})
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "650px", overflowY: "auto" }}>
                      {dyDownloadedItems.map((item, idx) => (
                        <div
                          key={item.id + "-" + idx}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "12px",
                            padding: "10px 14px",
                            background: "white",
                            border: "1px solid var(--line)",
                            borderRadius: "10px",
                            transition: "all 0.2s"
                          }}
                        >
                          <div style={{
                            width: "32px",
                            height: "32px",
                            borderRadius: "8px",
                            background: "#f0f4fd",
                            color: "var(--blue)",
                            display: "grid",
                            placeItems: "center",
                            flexShrink: 0
                          }}>
                            {item.isFolder ? <FolderOpen size={16} /> : <Video size={16} />}
                          </div>
                          
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span style={{
                              display: "block",
                              fontSize: "13px",
                              fontWeight: 700,
                              color: "#27344e",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap"
                            }}>
                              {item.title}
                            </span>
                            <span style={{
                              display: "block",
                              fontSize: "11px",
                              color: "var(--muted)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              marginTop: "2px"
                            }}>
                              {item.path}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              if (window.videoDubbingDesktop) {
                                void window.videoDubbingDesktop.openItem(item.path);
                              }
                            }}
                            style={{
                              width: "32px",
                              height: "32px",
                              display: "grid",
                              placeItems: "center",
                              border: "1px solid #dce1ea",
                              borderRadius: "8px",
                              background: "white",
                              cursor: "pointer",
                              color: "var(--blue)",
                              flexShrink: 0
                            }}
                            title={item.isFolder ? "Mở thư mục" : "Phát video"}
                          >
                            {item.isFolder ? <FolderOpen size={14} /> : <Play size={14} fill="currentColor" />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="empty-editor">
                <div className="empty-visual">
                  <Download size={38} />
                  <span>
                    <Sparkles size={20} />
                  </span>
                </div>
                <h2>Công cụ tải video đa nền tảng</h2>
                <p>
                  Nhập link Douyin, YouTube, TikTok hoặc các trang video khác. Link Douyin dùng dy-downloader (cần Cookie); các link khác tải qua yt-dlp. Chọn thư mục lưu và bấm tải xuống.
                </p>
              </div>
            )}
          </section>
        </main>
      )}

      {activeMainTab === "batch" && (
        <main className="workspace">
          <aside className="left-panel">
            <div className="panel-head"><span>CẤU HÌNH HÀNG LOẠT</span></div>
            
            <section className="settings-section" style={{ borderTop: "none", paddingTop: 0 }}>
              <div className="settings-form-group">
                <label style={{ fontSize: "12px", fontWeight: 750, color: "#717c91", display: "block", marginBottom: "7px" }}>
                  <FolderOpen size={14} style={{ color: "var(--blue)", marginRight: "5px", verticalAlign: "middle" }} /> Thư mục chứa video gốc
                </label>
                <div className="settings-dir-input">
                  <input
                    type="text"
                    readOnly
                    placeholder="Chưa chọn thư mục đầu vào"
                    value={batchInputDir}
                    style={{ background: "#fafbfe" }}
                  />
                  <button type="button" disabled={isBatchRunning} onClick={async () => {
                    if (window.videoDubbingDesktop) {
                      const dir = await window.videoDubbingDesktop.selectDirectory();
                      if (dir) {
                        setBatchInputDir(dir);
                        localStorage.setItem("batchInputDir", dir);
                      }
                    }
                  }}>Chọn</button>
                </div>
              </div>

              <div className="settings-form-group">
                <label style={{ fontSize: "12px", fontWeight: 750, color: "#717c91", display: "block", marginBottom: "7px" }}>
                  <FolderOpen size={14} style={{ color: "var(--blue)", marginRight: "5px", verticalAlign: "middle" }} /> Thư mục lưu thành phẩm
                </label>
                <div className="settings-dir-input">
                  <input
                    type="text"
                    readOnly
                    placeholder="Chưa chọn thư mục đầu ra"
                    value={batchOutputDir}
                    style={{ background: "#fafbfe" }}
                  />
                  <button type="button" disabled={isBatchRunning} onClick={async () => {
                    if (window.videoDubbingDesktop) {
                      const dir = await window.videoDubbingDesktop.selectDirectory();
                      if (dir) {
                        setBatchOutputDir(dir);
                        localStorage.setItem("batchOutputDir", dir);
                      }
                    }
                  }}>Chọn</button>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <label>
                  <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                    <Languages size={14} style={{ color: "var(--blue)" }} /> Ngôn ngữ dịch
                  </span>
                  <select disabled={isBatchRunning} value={batchLanguageCode} onChange={(event) => setBatchLanguageCode(event.target.value)} style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "#fafbfe", fontSize: "13px", fontWeight: 700 }}>
                    {LANGUAGES.map(([code, , label]) => <option key={code} value={code}>{label}</option>)}
                  </select>
                </label>
                <label>
                  <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                    <Sparkles size={14} style={{ color: "var(--blue)" }} /> Công cụ dịch
                  </span>
                  {renderTranslateProviderSelect(batchProvider, selectTranslateProvider, isBatchRunning, false)}
                </label>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "10px" }}>
                <label>
                  <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                    <Mic2 size={14} style={{ color: "var(--blue)" }} /> Giọng đọc mặc định
                  </span>
                  <select
                    disabled={isBatchRunning}
                    value={batchVoiceId}
                    onChange={(event) => setBatchVoiceId(event.target.value)}
                    style={{
                      width: "100%",
                      height: "38px",
                      padding: "0 10px",
                      border: "1px solid var(--line)",
                      borderRadius: "10px",
                      outline: "0",
                      color: "#46536d",
                      background: "#fafbfe",
                      fontSize: "13px",
                      fontWeight: 700
                    }}
                  >
                    <option value="">Giọng hệ thống</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.kind === "clone" ? "Clone" : "Thiết kế"})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "7px", color: "#717c91", fontSize: "12px", fontWeight: 750 }}>
                    <Gauge size={14} style={{ color: "var(--blue)" }} /> Khớp thời lượng
                  </span>
                  <select
                    disabled={isBatchRunning}
                    value={batchTiming}
                    onChange={(event) => {
                      const val = event.target.value;
                      setBatchTiming(val);
                      localStorage.setItem("batchTiming", val);
                    }}
                    style={{
                      width: "100%",
                      height: "38px",
                      padding: "0 10px",
                      border: "1px solid var(--line)",
                      borderRadius: "10px",
                      outline: "0",
                      color: "#46536d",
                      background: "#fafbfe",
                      fontSize: "13px",
                      fontWeight: 700
                    }}
                  >
                    <option value="concise">Tự nhiên, rút gọn</option>
                    <option value="smart_fit">Smart Fit</option>
                    <option value="stretch_video">Co giãn video</option>
                    <option value="strict_slot">Khớp tuyệt đối</option>
                  </select>
                </label>
              </div>
            </section>

            {batchError && <div className="error-box" style={{ marginTop: "10px" }}><X size={15} />{batchError}</div>}

            <button
              className="primary"
              disabled={isBatchRunning || !batchInputDir || !batchOutputDir}
              onClick={async () => {
                setBatchError("");
                setBatchJobs([]);
                try {
                  const apiProvider = await ensureTranslateProvider(batchProvider);
                  const res = await api.enqueueLocalBatch({
                    input_dir: batchInputDir,
                    output_dir: batchOutputDir,
                    langs: batchLanguageCode,
                    voice_id: batchVoiceId || undefined,
                    translation_provider: apiProvider,
                    timing_strategy: batchTiming,
                    preserve_bg: true
                  });
                  setBatchGroupId(res.batch_group_id);
                  localStorage.setItem("batchGroupId", res.batch_group_id);
                  setIsBatchRunning(true);
                } catch (err: any) {
                  setBatchError(err.message || "Không thể bắt đầu clone hàng loạt.");
                }
              }}
              style={{ marginTop: "12px" }}
            >
              {isBatchRunning ? <LoaderCircle className="spin" size={17} /> : <WandSparkles size={17} />}
              {isBatchRunning ? "Đang xử lý hàng loạt..." : "Bắt đầu Clone Hàng loạt"}
            </button>
          </aside>

          <section className="editor">
            <div className="editor-head">
              <div>
                <span className="eyebrow">TIẾN TRÌNH CLONE HÀNG LOẠT</span>
                <h1>{batchJobs.length ? `${batchJobs.length} video trong hàng đợi` : "Danh sách tệp xử lý"}</h1>
              </div>
              {batchJobs.length > 0 && (
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  {batchGroupId && (
                    <button
                      type="button"
                      onClick={() => {
                        setBatchGroupId("");
                        localStorage.removeItem("batchGroupId");
                        setBatchJobs([]);
                      }}
                      style={{
                        padding: "6px 12px",
                        border: "1px solid var(--line)",
                        borderRadius: "8px",
                        background: "white",
                        fontSize: "11px",
                        fontWeight: 700,
                        cursor: "pointer"
                      }}
                    >
                      Xóa danh sách
                    </button>
                  )}
                  <div className="duration" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <strong>
                      Tiến độ: {batchJobs.filter(j => ["done", "failed"].includes(j.status)).length} / {batchJobs.length}
                    </strong>
                  </div>
                </div>
              )}
            </div>

            {batchJobs.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "24px", height: "100%", overflowY: "auto" }}>
                {/* Overall progress bar */}
                <div style={{ background: "white", border: "1px solid var(--line)", borderRadius: "16px", padding: "20px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontWeight: 750 }}>
                    <span style={{ color: "#46536d" }}>Tiến trình tổng quan</span>
                    <span style={{ color: "var(--blue)" }}>
                      {Math.round(
                        (batchJobs.filter(j => j.status === "done").length / batchJobs.length) * 100
                      )}%
                    </span>
                  </div>
                  <div style={{ height: "8px", background: "#edf2ff", borderRadius: "99px", overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        background: "linear-gradient(90deg, var(--blue), var(--mint))",
                        width: `${(batchJobs.filter(j => j.status === "done").length / batchJobs.length) * 100}%`,
                        transition: "width 0.4s ease-out"
                      }}
                    />
                  </div>
                </div>

                {/* Queue list */}
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {batchJobs.map((job, index) => {
                    let statusLabel = "Đang chờ...";
                    let statusColor = "#8992a6";
                    let statusBg = "#f1f3f9";
                    let isRunning = job.status === "running";
                    let progressPercent = 0;
                    let stageLabel = "";

                    if (job.status === "done") {
                      statusLabel = "Hoàn thành";
                      statusColor = "#1a7c61";
                      statusBg = "#f0fdf4";
                    } else if (job.status === "failed") {
                      statusLabel = "Lỗi";
                      statusColor = "#d55f6e";
                      statusBg = "#fff5f6";
                    } else if (job.status === "cancelled") {
                      statusLabel = "Đã hủy";
                      statusColor = "#6b7280";
                      statusBg = "#f3f4f6";
                    } else if (isRunning) {
                      statusLabel = "Đang chạy";
                      statusColor = "var(--blue)";
                      statusBg = "#edf2ff";
                      
                      const prog = job.progress || {};
                      progressPercent = prog.percent ?? 0;
                      
                      const stageTextMap: Record<string, string> = {
                        extract: "Đang trích xuất âm thanh",
                        transcribe: "Đang nhận dạng giọng nói (Whisper)",
                        translate: "Đang dịch lời thoại",
                        generate: "Đang lồng tiếng (OmniVoice)",
                        mix: "Đang ghép video và nhạc nền",
                        done: "Hoàn thành"
                      };
                      stageLabel = stageTextMap[prog.stage] || prog.stage || "Đang xử lý...";
                      if (prog.stage === "generate" && prog.current_segment && prog.total_segments) {
                        stageLabel = `Đang tạo giọng lồng tiếng (${prog.current_segment}/${prog.total_segments} đoạn)`;
                      }
                    }

                    return (
                      <div
                        key={job.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "40px 1fr auto",
                          alignItems: "center",
                          gap: "16px",
                          padding: "16px 20px",
                          border: "1px solid var(--line)",
                          borderRadius: "14px",
                          background: isRunning ? "rgba(75, 115, 241, 0.02)" : "white",
                          borderColor: isRunning ? "rgba(75, 115, 241, 0.25)" : "var(--line)"
                        }}
                      >
                        <b style={{ color: "var(--muted)", fontSize: "13px" }}>
                          {String(index + 1).padStart(2, "0")}
                        </b>
                        <div style={{ minWidth: 0 }}>
                          <span style={{ display: "block", fontSize: "14px", fontWeight: 700, color: "#27344e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {job.filename}
                          </span>
                          {isRunning && (
                            <div style={{ marginTop: "8px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--muted)", marginBottom: "4px", fontWeight: 650 }}>
                                <span>{stageLabel}</span>
                                <span>{progressPercent}%</span>
                              </div>
                              <div style={{ height: "4px", background: "#edf2ff", borderRadius: "99px", overflow: "hidden" }}>
                                <div
                                  style={{
                                    height: "100%",
                                    background: "var(--blue)",
                                    width: `${progressPercent}%`,
                                    transition: "width 0.2s ease-out"
                                  }}
                                />
                              </div>
                            </div>
                          )}
                          {job.status === "failed" && job.error && (
                            <span style={{ display: "block", fontSize: "11px", color: "#d55f6e", marginTop: "4px", fontWeight: 650 }}>
                              Chi tiết lỗi: {job.error}
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                          <span
                            style={{
                              padding: "4px 10px",
                              borderRadius: "20px",
                              fontSize: "11px",
                              fontWeight: 750,
                              color: statusColor,
                              backgroundColor: statusBg
                            }}
                          >
                            {statusLabel}
                          </span>
                          {job.status === "done" && (
                            <button
                              type="button"
                              onClick={() => {
                                if (window.videoDubbingDesktop) {
                                  window.videoDubbingDesktop.openPath(batchOutputDir);
                                }
                              }}
                              style={{
                                width: "32px",
                                height: "32px",
                                display: "grid",
                                placeItems: "center",
                                border: "1px solid #dce1ea",
                                borderRadius: "8px",
                                background: "white",
                                cursor: "pointer",
                                color: "var(--blue)"
                              }}
                              title="Mở thư mục lưu"
                            >
                              <FolderOpen size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="empty-editor">
                <div className="empty-visual">
                  <FolderOpen size={38} />
                  <span>
                    <Sparkles size={20} />
                  </span>
                </div>
                <h2>Xử lý hàng loạt video tự động</h2>
                <p>
                  Chọn thư mục chứa nhiều video, cấu hình các tùy chọn dịch thuật và giọng nói. Hệ thống sẽ tự động quét, dịch lời thoại, tổng hợp giọng nói và xuất bản thành phẩm lồng tiếng tuần tự cho từng tệp.
                </p>
              </div>
            )}
          </section>
        </main>
      )}

      {activeMainTab === "config" && (
        <main className="workspace" style={{ display: "block" }}>
          <div className="config-layout">
            <aside className="config-sidebar">
              <button
                type="button"
                className={`settings-tab-btn ${settingsTab === "general" ? "active" : ""}`}
                onClick={() => setSettingsTab("general")}
              >
                <FolderOpen size={16} /> Lưu mặc định
              </button>
              <button
                type="button"
                className={`settings-tab-btn ${settingsTab === "colab" ? "active" : ""}`}
                onClick={() => setSettingsTab("colab")}
              >
                <Cloud size={16} /> Google Colab GPU
              </button>
              <button
                type="button"
                className={`settings-tab-btn ${settingsTab === "hf_token" ? "active" : ""}`}
                onClick={() => setSettingsTab("hf_token")}
              >
                <Sparkles size={16} /> Hugging Face API
              </button>
              <button
                type="button"
                className={`settings-tab-btn ${settingsTab === "voice_profiles" ? "active" : ""}`}
                onClick={() => setSettingsTab("voice_profiles")}
              >
                <Mic2 size={16} /> Giọng nói clone
              </button>
              <button
                type="button"
                className={`settings-tab-btn ${settingsTab === "translate_api" ? "active" : ""}`}
                onClick={() => { setSettingsTab("translate_api"); void refreshTranslateCloud(); }}
              >
                <UploadCloud size={16} /> API dịch cloud
              </button>
              <button
                type="button"
                className={`settings-tab-btn ${settingsTab === "translate_models" ? "active" : ""}`}
                onClick={() => { setSettingsTab("translate_models"); void refreshModels(); }}
              >
                <Languages size={16} /> Model dịch
              </button>
              <button
                type="button"
                className={`settings-tab-btn ${settingsTab === "models" ? "active" : ""}`}
                onClick={() => { setSettingsTab("models"); void refreshModels(); }}
              >
                <HardDrive size={16} /> Quản lý Models
              </button>
              <button
                type="button"
                className={`settings-tab-btn ${settingsTab === "douyin" ? "active" : ""}`}
                onClick={() => setSettingsTab("douyin")}
              >
                <Languages size={16} /> Đăng nhập Douyin
              </button>
            </aside>
            <div className="config-content">
              {/* 1. General Settings Tab */}
              {settingsTab === "general" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "600px" }}>
                  <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: "10px", marginBottom: "10px" }}>
                    <h3 style={{ margin: 0, fontSize: "16px", color: "#27344e" }}>Cài đặt lưu tệp mặc định</h3>
                    <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>Cấu hình tự động lưu tệp sau khi biên dịch xong.</p>
                  </div>
                  
                  <div className="settings-form-group">
                    <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", marginBottom: "8px" }}>Thư mục lưu MP4 mặc định</label>
                    <div className="settings-dir-input">
                      <input
                        type="text"
                        readOnly
                        placeholder="Chưa cấu hình (Hỏi mỗi lần xuất)"
                        value={defaultSaveDir}
                      />
                      <button type="button" onClick={async () => {
                        if (window.videoDubbingDesktop) {
                          const dir = await window.videoDubbingDesktop.selectDirectory();
                          if (dir) {
                            setDefaultSaveDir(dir);
                            localStorage.setItem("defaultSaveDir", dir);
                          }
                        }
                      }}>Chọn thư mục</button>
                      {defaultSaveDir && (
                        <button type="button" onClick={() => {
                          setDefaultSaveDir("");
                          localStorage.removeItem("defaultSaveDir");
                        }} style={{ color: "#d55f6e", background: "#fff5f6", borderColor: "#f1cfd5" }}>Xóa</button>
                      )}
                    </div>
                  </div>

                  <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", fontWeight: 700, color: "#46536d" }}>
                    <input
                      type="checkbox"
                      checked={autoSave}
                      onChange={(e) => {
                        const val = e.target.checked;
                        setAutoSave(val);
                        localStorage.setItem("autoSave", String(val));
                      }}
                      style={{ width: "16px", height: "16px", cursor: "pointer" }}
                    />
                    Tự động lưu file MP4 vào thư mục mặc định khi xuất (Không hỏi lại)
                  </label>
                </div>
              )}

              {settingsTab === "colab" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "760px" }}>
                  <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: "10px", marginBottom: "4px" }}>
                    <h3 style={{ margin: 0, fontSize: "16px", color: "#27344e" }}>Google Colab GPU</h3>
                    <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>
                      Chuyển các tác vụ AI sang backend chạy trên GPU của Google Colab. Local mode vẫn là mặc định.
                    </p>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                    <button
                      type="button"
                      onClick={() => void switchBackendMode("local")}
                      disabled={savingBackendConfig}
                      style={{
                        padding: "14px",
                        border: backendConfig.backendMode === "local" ? "2px solid var(--blue)" : "1px solid var(--line)",
                        borderRadius: "10px",
                        background: backendConfig.backendMode === "local" ? "#edf2ff" : "white",
                        cursor: savingBackendConfig ? "wait" : "pointer",
                        textAlign: "left"
                      }}
                    >
                      <strong style={{ color: "#27344e", fontSize: "13px" }}>Local GPU/CPU</strong>
                      <div style={{ color: "var(--muted)", fontSize: "11px", marginTop: "5px", lineHeight: 1.45 }}>
                        Dùng backend trên máy hiện tại. Thiết bị đang nhận: {device || "chưa kiểm tra"}.
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => void switchBackendMode("colab")}
                      disabled={savingBackendConfig || testingColab}
                      style={{
                        padding: "14px",
                        border: backendConfig.backendMode === "colab" ? "2px solid var(--blue)" : "1px solid var(--line)",
                        borderRadius: "10px",
                        background: backendConfig.backendMode === "colab" ? "#edf2ff" : "white",
                        cursor: savingBackendConfig || testingColab ? "wait" : "pointer",
                        textAlign: "left"
                      }}
                    >
                      <strong style={{ color: "#27344e", fontSize: "13px" }}>Remote Google Colab</strong>
                      <div style={{ color: "var(--muted)", fontSize: "11px", marginTop: "5px", lineHeight: 1.45 }}>
                        Dùng URL Colab bên dưới và kiểm tra `/health` trước khi chuyển.
                      </div>
                    </button>
                  </div>

                  <div className="settings-form-group">
                    <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", marginBottom: "8px" }}>
                      URL API Colab
                    </label>
                    <div className="settings-dir-input">
                      <input
                        type="text"
                        placeholder="https://xxxx.trycloudflare.com"
                        value={colabUrlInput}
                        onChange={(e) => setColabUrlInput(e.target.value)}
                      />
                      <button type="button" disabled={testingColab} onClick={() => void testColabConnection()}>
                        {testingColab ? "Đang kiểm tra..." : "Kiểm tra"}
                      </button>
                    </div>
                    <div style={{ fontSize: "11px", color: colabStatus.includes("thành công") || colabStatus.includes("Đã chuyển") ? "#24967c" : "var(--muted)", marginTop: "8px", fontWeight: 700 }}>
                      {colabStatus || `Chế độ hiện tại: ${backendConfig.backendMode === "colab" ? "Google Colab" : "Local"}`}
                    </div>
                  </div>

                  <div style={{ background: "#f8f9fa", border: "1px solid var(--line)", borderRadius: "10px", padding: "14px", color: "#46536d", fontSize: "12px", lineHeight: 1.6 }}>
                    <strong>Quy trình Colab:</strong>
                    <ol style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
                      <li>Mở notebook Colab của Video Clone, chọn Runtime GPU rồi Run all.</li>
                      <li>Đợi notebook in ra URL public dạng `https://...trycloudflare.com`.</li>
                      <li>Dán URL vào ô trên, bấm Kiểm tra, sau đó chọn Remote Google Colab.</li>
                      <li>Trong notebook, backend nên chạy ở chế độ standalone hoặc có `OMNIVOICE_ACTIVATED=1`.</li>
                    </ol>
                    <button
                      type="button"
                      onClick={openColabNotebook}
                      style={{ marginTop: "12px", height: "34px", padding: "0 14px", border: "0", borderRadius: "8px", color: "white", background: "var(--blue)", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}
                    >
                      Mở Google Colab
                    </button>
                  </div>
                </div>
              )}

              {/* 2. Hugging Face Token Tab */}
              {settingsTab === "hf_token" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "600px" }}>
                  <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: "10px", marginBottom: "10px" }}>
                    <h3 style={{ margin: 0, fontSize: "16px", color: "#27344e" }}>Hugging Face API Token</h3>
                    <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>Nhập mã Hugging Face Token để tải các mô hình giọng nói và phân đoạn bảo mật.</p>
                  </div>

                  <div className="settings-form-group">
                    <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", marginBottom: "8px" }}>API Token</label>
                    <div className="hf-input-row">
                      <input
                        type="password"
                        placeholder="hf_..."
                        value={hfToken}
                        onChange={(e) => setHfToken(e.target.value)}
                        disabled={hfActive}
                        style={{ flex: 1, height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "#fafbfe", fontSize: "13px" }}
                      />
                      {hfActive ? (
                        <button className="btn-clear-hf" type="button" onClick={async () => {
                          if (confirm("Bạn có muốn xóa token Hugging Face hiện tại?")) {
                            await api.clearHfToken(true);
                            setHfToken("");
                            await refreshHfTokenState();
                          }
                        }} style={{ padding: "0 16px", height: "38px", border: "0", borderRadius: "10px", color: "#d55f6e", background: "#fff5f6", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}>Xóa</button>
                      ) : (
                        <button type="button" onClick={async () => {
                          if (!hfToken.trim()) return;
                          try {
                            await api.saveHfToken(hfToken.trim());
                            await refreshHfTokenState();
                            alert("Lưu token Hugging Face thành công!");
                          } catch (e: any) {
                            alert(`Lỗi lưu token: ${e.message || e}`);
                          }
                        }} style={{ padding: "0 16px", height: "38px", border: "0", borderRadius: "10px", color: "white", background: "var(--blue)", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}>Lưu</button>
                      )}
                    </div>
                    <div className="hf-status-active" style={{ marginTop: "6px", fontSize: "12px", color: hfActive ? "#24967c" : "#d55f6e", fontWeight: 700 }}>
                      Trạng thái: {hfStatusText}
                    </div>
                  </div>
                </div>
              )}

              {settingsTab === "translate_api" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                  <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: "10px" }}>
                    <h3 style={{ margin: 0, fontSize: "16px", color: "#27344e" }}>API dịch cloud</h3>
                    <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>
                      Cấu hình API dịch AI trực tiếp hoặc qua proxy cục bộ. Khóa API được lưu cục bộ trên máy.
                    </p>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", alignItems: "start" }}>
                    {/* Cột trái: API cloud trực tiếp */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                      <div style={{ fontSize: "13px", fontWeight: 800, color: "#27344e", paddingBottom: "6px", borderBottom: "2px solid var(--blue)" }}>
                        API cloud trực tiếp
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "16px", border: "1px solid var(--line)", borderRadius: "12px", background: "#fafbfe" }}>
                        <div style={{ fontSize: "14px", fontWeight: 800, color: "#27344e" }}>OpenAI</div>
                    <div className="settings-form-group">
                      <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", marginBottom: "8px" }}>API Key</label>
                      <input
                        type="password"
                        placeholder={translateCloud.openai.configured ? "Đã lưu — nhập mới để thay" : "sk-..."}
                        value={openaiTranslateKey}
                        onChange={(e) => setOpenaiTranslateKey(e.target.value)}
                        style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "white", fontSize: "13px" }}
                      />
                      {translateCloud.openai.configured && (
                        <div style={{ fontSize: "11px", color: "#24967c", marginTop: "6px", fontWeight: 700 }}>
                          Đã cấu hình {translateCloud.openai.api_key_masked ? `(${translateCloud.openai.api_key_masked})` : ""}
                        </div>
                      )}
                    </div>
                    <div className="settings-form-group">
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px", gap: "8px" }}>
                        <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", margin: 0 }}>Model</label>
                        <button
                          type="button"
                          disabled={loadingOpenaiModels}
                          onClick={() => void fetchOpenaiTranslateModels({
                            apiKey: openaiTranslateKey,
                            baseUrl: openaiTranslateBaseUrl,
                            currentModel: openaiTranslateModel
                          })}
                          style={{ padding: "0 10px", height: "28px", border: "1px solid var(--line)", borderRadius: "8px", color: "#46536d", background: "white", cursor: loadingOpenaiModels ? "wait" : "pointer", fontSize: "11px", fontWeight: 700 }}
                        >
                          {loadingOpenaiModels ? "Đang tải…" : "Làm mới danh sách"}
                        </button>
                      </div>
                      <select
                        value={openaiTranslateModel}
                        onChange={(e) => setOpenaiTranslateModel(e.target.value)}
                        disabled={loadingOpenaiModels || openaiModelOptions.length === 0}
                        style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "white", fontSize: "13px" }}
                      >
                        {(openaiModelOptions.length ? openaiModelOptions : [openaiTranslateModel || "gpt-4o-mini"]).map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                      {openaiModelsSource === "api" && (
                        <div style={{ fontSize: "11px", color: "#24967c", marginTop: "6px", fontWeight: 700 }}>
                          Đã tải {openaiModelOptions.length} model từ OpenAI API
                        </div>
                      )}
                      {openaiModelsError && (
                        <div style={{ fontSize: "11px", color: "#b07a1e", marginTop: "6px" }}>
                          {openaiModelsError}
                        </div>
                      )}
                    </div>
                    <div className="settings-form-group">
                      <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", marginBottom: "8px" }}>Base URL (tùy chọn)</label>
                      <input
                        type="text"
                        placeholder="https://api.openai.com/v1 — để trống nếu dùng OpenAI chính thức"
                        value={openaiTranslateBaseUrl}
                        onChange={(e) => setOpenaiTranslateBaseUrl(e.target.value)}
                        style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "white", fontSize: "13px" }}
                      />
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        type="button"
                        disabled={savingTranslateCloud}
                        onClick={() => void (async () => {
                          setSavingTranslateCloud(true);
                          try {
                            const body: { api_key?: string; model?: string; base_url?: string } = {
                              model: openaiTranslateModel.trim() || undefined,
                              base_url: openaiTranslateBaseUrl.trim()
                            };
                            if (openaiTranslateKey.trim()) body.api_key = openaiTranslateKey.trim();
                            await api.setTranslateCloud({ openai: body });
                            setOpenaiTranslateKey("");
                            await refreshTranslateCloud();
                          } catch (e: any) {
                            alert(e?.message || "Không thể lưu cấu hình OpenAI.");
                          } finally {
                            setSavingTranslateCloud(false);
                          }
                        })()}
                        style={{ padding: "0 16px", height: "36px", border: 0, borderRadius: "10px", color: "white", background: "var(--blue)", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}
                      >
                        Lưu OpenAI
                      </button>
                      {translateCloud.openai.configured && (
                        <button
                          type="button"
                          disabled={savingTranslateCloud}
                          onClick={() => void (async () => {
                            if (!confirm("Xóa cấu hình OpenAI?")) return;
                            setSavingTranslateCloud(true);
                            try {
                              await api.setTranslateCloud({ openai: { api_key: "", model: "", base_url: "" } });
                              setOpenaiTranslateKey("");
                              setOpenaiTranslateModel("gpt-4o-mini");
                              setOpenaiTranslateBaseUrl("");
                              await refreshTranslateCloud();
                            } finally {
                              setSavingTranslateCloud(false);
                            }
                          })()}
                          style={{ padding: "0 16px", height: "36px", border: "1px solid #f1cfd5", borderRadius: "10px", color: "#d55f6e", background: "#fff5f6", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}
                        >
                          Xóa
                        </button>
                      )}
                    </div>
                  </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "16px", border: "1px solid var(--line)", borderRadius: "12px", background: "#fafbfe" }}>
                        <div style={{ fontSize: "14px", fontWeight: 800, color: "#27344e" }}>Google Gemini</div>
                    <div className="settings-form-group">
                      <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", marginBottom: "8px" }}>API Key</label>
                      <input
                        type="password"
                        placeholder={translateCloud.gemini.configured ? "Đã lưu — nhập mới để thay" : "AIza..."}
                        value={geminiTranslateKey}
                        onChange={(e) => setGeminiTranslateKey(e.target.value)}
                        style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "white", fontSize: "13px" }}
                      />
                      {translateCloud.gemini.configured && (
                        <div style={{ fontSize: "11px", color: "#24967c", marginTop: "6px", fontWeight: 700 }}>
                          Đã cấu hình {translateCloud.gemini.api_key_masked ? `(${translateCloud.gemini.api_key_masked})` : ""}
                        </div>
                      )}
                    </div>
                    <div className="settings-form-group">
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px", gap: "8px" }}>
                        <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", margin: 0 }}>Model</label>
                        <button
                          type="button"
                          disabled={loadingGeminiModels}
                          onClick={() => void fetchGeminiTranslateModels({
                            apiKey: geminiTranslateKey,
                            currentModel: geminiTranslateModel
                          })}
                          style={{ padding: "0 10px", height: "28px", border: "1px solid var(--line)", borderRadius: "8px", color: "#46536d", background: "white", cursor: loadingGeminiModels ? "wait" : "pointer", fontSize: "11px", fontWeight: 700 }}
                        >
                          {loadingGeminiModels ? "Đang tải…" : "Làm mới danh sách"}
                        </button>
                      </div>
                      <select
                        value={geminiTranslateModel}
                        onChange={(e) => setGeminiTranslateModel(e.target.value)}
                        disabled={loadingGeminiModels || geminiModelOptions.length === 0}
                        style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "white", fontSize: "13px" }}
                      >
                        {(geminiModelOptions.length ? geminiModelOptions : [geminiTranslateModel || "gemini-2.0-flash"]).map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                      {geminiModelsSource === "api" && (
                        <div style={{ fontSize: "11px", color: "#24967c", marginTop: "6px", fontWeight: 700 }}>
                          Đã tải {geminiModelOptions.length} model từ Gemini API
                        </div>
                      )}
                      {geminiModelsError && (
                        <div style={{ fontSize: "11px", color: "#b07a1e", marginTop: "6px" }}>
                          {geminiModelsError}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        type="button"
                        disabled={savingTranslateCloud}
                        onClick={() => void (async () => {
                          if (!geminiTranslateKey.trim() && !translateCloud.gemini.configured) {
                            alert("Vui lòng nhập Gemini API key.");
                            return;
                          }
                          setSavingTranslateCloud(true);
                          try {
                            const body: { api_key?: string; model?: string } = {
                              model: geminiTranslateModel.trim() || undefined
                            };
                            if (geminiTranslateKey.trim()) body.api_key = geminiTranslateKey.trim();
                            await api.setTranslateCloud({ gemini: body });
                            setGeminiTranslateKey("");
                            await refreshTranslateCloud();
                          } catch (e: any) {
                            alert(e?.message || "Không thể lưu cấu hình Gemini.");
                          } finally {
                            setSavingTranslateCloud(false);
                          }
                        })()}
                        style={{ padding: "0 16px", height: "36px", border: 0, borderRadius: "10px", color: "white", background: "var(--blue)", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}
                      >
                        Lưu Gemini
                      </button>
                      {translateCloud.gemini.configured && (
                        <button
                          type="button"
                          disabled={savingTranslateCloud}
                          onClick={() => void (async () => {
                            if (!confirm("Xóa cấu hình Gemini?")) return;
                            setSavingTranslateCloud(true);
                            try {
                              await api.setTranslateCloud({ gemini: { api_key: "", model: "" } });
                              setGeminiTranslateKey("");
                              setGeminiTranslateModel("gemini-2.0-flash");
                              await refreshTranslateCloud();
                            } finally {
                              setSavingTranslateCloud(false);
                            }
                          })()}
                          style={{ padding: "0 16px", height: "36px", border: "1px solid #f1cfd5", borderRadius: "10px", color: "#d55f6e", background: "#fff5f6", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}
                        >
                          Xóa
                        </button>
                      )}
                    </div>
                  </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "16px", border: "1px solid var(--line)", borderRadius: "12px", background: "#fafbfe" }}>
                        <div style={{ fontSize: "14px", fontWeight: 800, color: "#27344e" }}>DeepSeek</div>
                        <div style={{ fontSize: "11px", color: "var(--muted)", lineHeight: 1.5 }}>
                          API OpenAI-compatible tại{" "}
                          <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">platform.deepseek.com</a>.
                          Mặc định dùng <code>deepseek-chat</code>.
                        </div>
                        <div className="settings-form-group">
                          <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", marginBottom: "8px" }}>API Key</label>
                          <input
                            type="password"
                            placeholder={translateCloud.deepseek.configured ? "Đã lưu — nhập mới để thay" : "sk-..."}
                            value={deepseekTranslateKey}
                            onChange={(e) => setDeepseekTranslateKey(e.target.value)}
                            style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "white", fontSize: "13px" }}
                          />
                          {translateCloud.deepseek.configured && (
                            <div style={{ fontSize: "11px", color: "#24967c", marginTop: "6px", fontWeight: 700 }}>
                              Đã cấu hình {translateCloud.deepseek.api_key_masked ? `(${translateCloud.deepseek.api_key_masked})` : ""}
                            </div>
                          )}
                        </div>
                        <div className="settings-form-group">
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px", gap: "8px" }}>
                            <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", margin: 0 }}>Model</label>
                            <button
                              type="button"
                              disabled={loadingDeepseekModels}
                              onClick={() => void fetchDeepseekTranslateModels({
                                apiKey: deepseekTranslateKey,
                                baseUrl: deepseekTranslateBaseUrl,
                                currentModel: deepseekTranslateModel
                              })}
                              style={{ padding: "0 10px", height: "28px", border: "1px solid var(--line)", borderRadius: "8px", color: "#46536d", background: "white", cursor: loadingDeepseekModels ? "wait" : "pointer", fontSize: "11px", fontWeight: 700 }}
                            >
                              {loadingDeepseekModels ? "Đang tải…" : "Làm mới danh sách"}
                            </button>
                          </div>
                          <select
                            value={deepseekTranslateModel}
                            onChange={(e) => setDeepseekTranslateModel(e.target.value)}
                            disabled={loadingDeepseekModels || deepseekModelOptions.length === 0}
                            style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "white", fontSize: "13px" }}
                          >
                            {(deepseekModelOptions.length ? deepseekModelOptions : [deepseekTranslateModel || "deepseek-chat"]).map((model) => (
                              <option key={model} value={model}>{model}</option>
                            ))}
                          </select>
                          {deepseekModelsSource === "api" && (
                            <div style={{ fontSize: "11px", color: "#24967c", marginTop: "6px", fontWeight: 700 }}>
                              Đã tải {deepseekModelOptions.length} model từ DeepSeek API
                            </div>
                          )}
                          {deepseekModelsError && (
                            <div style={{ fontSize: "11px", color: "#b07a1e", marginTop: "6px" }}>
                              {deepseekModelsError}
                            </div>
                          )}
                        </div>
                        <div className="settings-form-group">
                          <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", marginBottom: "8px" }}>Base URL (tùy chọn)</label>
                          <input
                            type="text"
                            placeholder="https://api.deepseek.com/v1 — để trống nếu dùng mặc định"
                            value={deepseekTranslateBaseUrl}
                            onChange={(e) => setDeepseekTranslateBaseUrl(e.target.value)}
                            style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "white", fontSize: "13px" }}
                          />
                        </div>
                        <div style={{ display: "flex", gap: "8px" }}>
                          <button
                            type="button"
                            disabled={savingTranslateCloud}
                            onClick={() => void (async () => {
                              if (!deepseekTranslateKey.trim() && !translateCloud.deepseek.configured) {
                                alert("Vui lòng nhập DeepSeek API key.");
                                return;
                              }
                              setSavingTranslateCloud(true);
                              try {
                                const body: { api_key?: string; model?: string; base_url?: string } = {
                                  model: deepseekTranslateModel.trim() || undefined,
                                  base_url: deepseekTranslateBaseUrl.trim()
                                };
                                if (deepseekTranslateKey.trim()) body.api_key = deepseekTranslateKey.trim();
                                await api.setTranslateCloud({ deepseek: body });
                                setDeepseekTranslateKey("");
                                await refreshTranslateCloud();
                              } catch (e: any) {
                                alert(e?.message || "Không thể lưu cấu hình DeepSeek.");
                              } finally {
                                setSavingTranslateCloud(false);
                              }
                            })()}
                            style={{ padding: "0 16px", height: "36px", border: 0, borderRadius: "10px", color: "white", background: "var(--blue)", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}
                          >
                            Lưu DeepSeek
                          </button>
                          {translateCloud.deepseek.configured && (
                            <button
                              type="button"
                              disabled={savingTranslateCloud}
                              onClick={() => void (async () => {
                                if (!confirm("Xóa cấu hình DeepSeek?")) return;
                                setSavingTranslateCloud(true);
                                try {
                                  await api.setTranslateCloud({ deepseek: { api_key: "", model: "", base_url: "" } });
                                  setDeepseekTranslateKey("");
                                  setDeepseekTranslateModel("deepseek-chat");
                                  setDeepseekTranslateBaseUrl("");
                                  await refreshTranslateCloud();
                                } finally {
                                  setSavingTranslateCloud(false);
                                }
                              })()}
                              style={{ padding: "0 16px", height: "36px", border: "1px solid #f1cfd5", borderRadius: "10px", color: "#d55f6e", background: "#fff5f6", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}
                            >
                              Xóa
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Cột phải: Proxy cục bộ */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                      <div style={{ fontSize: "13px", fontWeight: 800, color: "#27344e", paddingBottom: "6px", borderBottom: "2px solid #8b5cf6" }}>
                        Proxy cục bộ
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "16px", border: "1px solid var(--line)", borderRadius: "12px", background: "#fafbfe" }}>
                        <div style={{ fontSize: "14px", fontWeight: 800, color: "#27344e" }}>9Router</div>
                    <div style={{ fontSize: "11px", color: "var(--muted)", lineHeight: 1.5 }}>
                      Proxy OpenAI-compatible cục bộ — route tới Claude, Gemini, OpenAI, DeepSeek… Cần chạy{" "}
                      <a href="https://github.com/decolua/9router" target="_blank" rel="noreferrer">9Router</a>{" "}
                      tại <code>http://localhost:20128</code> và lấy API key từ dashboard.
                    </div>
                    <div className="settings-form-group">
                      <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", marginBottom: "8px" }}>API Key</label>
                      <input
                        type="password"
                        placeholder={translateCloud["9router"].configured ? "Đã lưu — nhập mới để thay" : "API key từ 9Router dashboard"}
                        value={ninerouterTranslateKey}
                        onChange={(e) => setNinerouterTranslateKey(e.target.value)}
                        style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "white", fontSize: "13px" }}
                      />
                      {translateCloud["9router"].configured && (
                        <div style={{ fontSize: "11px", color: "#24967c", marginTop: "6px", fontWeight: 700 }}>
                          Đã cấu hình {translateCloud["9router"].api_key_masked ? `(${translateCloud["9router"].api_key_masked})` : ""}
                        </div>
                      )}
                    </div>
                    <div className="settings-form-group">
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px", gap: "8px" }}>
                        <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", margin: 0 }}>Model</label>
                        <button
                          type="button"
                          disabled={loadingNinerouterModels}
                          onClick={() => void fetchNinerouterTranslateModels({
                            apiKey: ninerouterTranslateKey,
                            baseUrl: ninerouterTranslateBaseUrl,
                            currentModel: ninerouterTranslateModel
                          })}
                          style={{ padding: "0 10px", height: "28px", border: "1px solid var(--line)", borderRadius: "8px", color: "#46536d", background: "white", cursor: loadingNinerouterModels ? "wait" : "pointer", fontSize: "11px", fontWeight: 700 }}
                        >
                          {loadingNinerouterModels ? "Đang tải…" : "Làm mới danh sách"}
                        </button>
                      </div>
                      <select
                        value={ninerouterTranslateModel}
                        onChange={(e) => setNinerouterTranslateModel(e.target.value)}
                        disabled={loadingNinerouterModels || (ninerouterModelOptions.length === 0 && !ninerouterTranslateModel)}
                        style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "white", fontSize: "13px" }}
                      >
                        {(ninerouterModelOptions.length ? ninerouterModelOptions : ninerouterTranslateModel ? [ninerouterTranslateModel] : ["— chọn model —"]).map((model) => (
                          <option key={model} value={model === "— chọn model —" ? "" : model}>{model}</option>
                        ))}
                      </select>
                      {ninerouterModelsSource === "api" && (
                        <div style={{ fontSize: "11px", color: "#24967c", marginTop: "6px", fontWeight: 700 }}>
                          Đã tải {ninerouterModelOptions.length} model từ 9Router
                        </div>
                      )}
                      {ninerouterModelsError && (
                        <div style={{ fontSize: "11px", color: "#b07a1e", marginTop: "6px" }}>
                          {ninerouterModelsError}
                        </div>
                      )}
                    </div>
                    <div className="settings-form-group">
                      <label style={{ fontSize: "13px", fontWeight: 700, color: "#46536d", marginBottom: "8px" }}>Base URL</label>
                      <input
                        type="text"
                        placeholder="http://localhost:20128/v1"
                        value={ninerouterTranslateBaseUrl}
                        onChange={(e) => setNinerouterTranslateBaseUrl(e.target.value)}
                        style={{ width: "100%", height: "38px", padding: "0 10px", border: "1px solid var(--line)", borderRadius: "10px", outline: "0", color: "#46536d", background: "white", fontSize: "13px" }}
                      />
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        type="button"
                        disabled={savingTranslateCloud}
                        onClick={() => void (async () => {
                          if (!ninerouterTranslateKey.trim() && !translateCloud["9router"].configured) {
                            alert("Vui lòng nhập 9Router API key.");
                            return;
                          }
                          if (!ninerouterTranslateModel.trim()) {
                            alert("Vui lòng chọn model 9Router.");
                            return;
                          }
                          setSavingTranslateCloud(true);
                          try {
                            const body: { api_key?: string; model?: string; base_url?: string } = {
                              model: ninerouterTranslateModel.trim(),
                              base_url: ninerouterTranslateBaseUrl.trim() || undefined
                            };
                            if (ninerouterTranslateKey.trim()) body.api_key = ninerouterTranslateKey.trim();
                            await api.setTranslateCloud({ "9router": body });
                            setNinerouterTranslateKey("");
                            await refreshTranslateCloud();
                          } catch (e: any) {
                            alert(e?.message || "Không thể lưu cấu hình 9Router.");
                          } finally {
                            setSavingTranslateCloud(false);
                          }
                        })()}
                        style={{ padding: "0 16px", height: "36px", border: 0, borderRadius: "10px", color: "white", background: "var(--blue)", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}
                      >
                        Lưu 9Router
                      </button>
                      {translateCloud["9router"].configured && (
                        <button
                          type="button"
                          disabled={savingTranslateCloud}
                          onClick={() => void (async () => {
                            if (!confirm("Xóa cấu hình 9Router?")) return;
                            setSavingTranslateCloud(true);
                            try {
                              await api.setTranslateCloud({ "9router": { api_key: "", model: "", base_url: "" } });
                              setNinerouterTranslateKey("");
                              setNinerouterTranslateModel("");
                              setNinerouterTranslateBaseUrl("http://localhost:20128/v1");
                              await refreshTranslateCloud();
                            } finally {
                              setSavingTranslateCloud(false);
                            }
                          })()}
                          style={{ padding: "0 16px", height: "36px", border: "1px solid #f1cfd5", borderRadius: "10px", color: "#d55f6e", background: "#fff5f6", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}
                        >
                          Xóa
                        </button>
                      )}
                    </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 3. Voice Profiles Tab */}
              {settingsTab === "voice_profiles" && (
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "30px", height: "100%" }}>
                  <div>
                    <h3 style={{ margin: "0 0 12px 0", fontSize: "14px", color: "#27344e", borderBottom: "1px solid var(--line)", paddingBottom: "6px", fontWeight: 800 }}>Danh sách giọng nói</h3>
                    <div className="voice-manager-list" style={{ maxHeight: "calc(100vh - 220px)" }}>
                      {profiles.length === 0 ? (
                        <div style={{ color: "var(--muted)", fontSize: "12px", textAlign: "center", padding: "20px 0" }}>Chưa có giọng clone nào.</div>
                      ) : (
                        profiles.map((p) => (
                          <div key={p.id} className="voice-manager-item">
                            <div className="voice-manager-info">
                              <span className="voice-manager-name">{p.name}</span>
                              <span className="voice-manager-meta">
                                <span>ID: {p.id}</span>
                                <span>•</span>
                                <span>{p.kind === "clone" ? "Bản Clone" : "Thiết kế"}</span>
                              </span>
                            </div>
                            <div className="voice-actions">
                              <button
                                className="btn-play-voice"
                                onClick={() => playVoice(p.id)}
                                title="Nghe thử"
                                type="button"
                              >
                                {playingVoiceId === p.id ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
                              </button>
                              <button
                                className="btn-edit-voice"
                                onClick={() => void handleRenameProfile(p.id, p.name)}
                                title="Đổi tên"
                                type="button"
                              >
                                <Sparkles size={14} />
                              </button>
                              <button
                                className="btn-delete-voice"
                                onClick={() => void handleDeleteProfile(p.id)}
                                title="Xóa"
                                type="button"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="voice-sub-tabs" style={{ display: "flex", gap: "8px", marginBottom: "12px", borderBottom: "1px solid var(--line)", paddingBottom: "8px" }}>
                      <button
                        type="button"
                        onClick={() => setVoiceMode("clone")}
                        style={{
                          flex: 1,
                          padding: "6px",
                          border: "1px solid " + (voiceMode === "clone" ? "var(--blue)" : "var(--line)"),
                          borderRadius: "8px",
                          background: voiceMode === "clone" ? "#edf2ff" : "white",
                          color: voiceMode === "clone" ? "var(--blue)" : "#46536d",
                          fontSize: "11px",
                          fontWeight: 800,
                          cursor: "pointer",
                          transition: "all 0.2s"
                        }}
                      >
                        Clone Giọng Nói
                      </button>
                      <button
                        type="button"
                        onClick={() => setVoiceMode("design")}
                        style={{
                          flex: 1,
                          padding: "6px",
                          border: "1px solid " + (voiceMode === "design" ? "var(--blue)" : "var(--line)"),
                          borderRadius: "8px",
                          background: voiceMode === "design" ? "#edf2ff" : "white",
                          color: voiceMode === "design" ? "var(--blue)" : "#46536d",
                          fontSize: "11px",
                          fontWeight: 800,
                          cursor: "pointer",
                          transition: "all 0.2s"
                        }}
                      >
                        Thiết Kế Giọng (Prompt)
                      </button>
                    </div>

                    {voiceMode === "clone" ? (
                      <form className="voice-clone-form" onSubmit={(e) => void handleCloneVoice(e)}>
                        <h3 style={{ borderBottom: "1px solid var(--line)", paddingBottom: "6px", fontWeight: 800 }}>Tạo giọng Clone mới</h3>
                        <label>
                          Tên giọng nói
                          <input
                            type="text"
                            placeholder="VD: Giọng Nam ấm..."
                            value={newVoiceName}
                            onChange={(e) => setNewVoiceName(e.target.value)}
                            required
                          />
                        </label>
                        <label style={{ cursor: "pointer" }}>
                          Tệp âm thanh mẫu (WAV/MP3)
                          <div
                            className="voice-file-input"
                            onClick={() => {
                              const input = document.createElement("input");
                              input.type = "file";
                              input.accept = "audio/wav,audio/mp3,audio/mpeg";
                              input.onchange = (e) => {
                                const files = (e.target as HTMLInputElement).files;
                                if (files?.[0]) {
                                  setNewVoiceFile(files[0]);
                                }
                              };
                              input.click();
                            }}
                          >
                            {newVoiceFile ? (
                              <>
                                <strong>Đã chọn tệp:</strong>
                                <span style={{ wordBreak: "break-all" }}>{newVoiceFile.name}</span>
                              </>
                            ) : (
                              <>
                                <strong>Chọn tệp âm thanh</strong>
                                <span>WAV hoặc MP3 (ngắn 5s - 15s)</span>
                              </>
                            )}
                          </div>
                        </label>
                        <button type="submit" className="btn-submit-clone" disabled={isCloning}>
                          {isCloning ? <LoaderCircle className="spin" size={14} /> : <Mic2 size={14} />}
                          {isCloning ? "Đang xử lý clone..." : "Clone Giọng nói"}
                        </button>
                      </form>
                    ) : (
                      <form className="voice-clone-form" onSubmit={(e) => void handleDesignVoice(e)}>
                        <h3 style={{ borderBottom: "1px solid var(--line)", paddingBottom: "6px", fontWeight: 800 }}>Thiết kế giọng nói bằng mô tả</h3>
                        <label>
                          Tên giọng nói
                          <input
                            type="text"
                            placeholder="VD: Giọng MC Mỹ..."
                            value={newVoiceName}
                            onChange={(e) => setNewVoiceName(e.target.value)}
                            required
                          />
                        </label>
                        <label>
                          Mô tả giọng nói (Tiếng Anh hoặc Tiếng Việt)
                          <textarea
                            placeholder="VD: Giọng nam trẻ trung trầm ấm giọng Mỹ (male, young, low pitch, warm, american accent)..."
                            value={voiceDescription}
                            onChange={(e) => setVoiceDescription(e.target.value)}
                            style={{
                              minHeight: "75px",
                              padding: "10px",
                              border: "1px solid var(--line)",
                              borderRadius: "10px",
                              background: "white",
                              fontSize: "12px",
                              color: "#46536d",
                              resize: "vertical",
                              fontFamily: "inherit"
                            }}
                            required
                          />
                        </label>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "2px" }}>
                          {[
                            ["Nam Trầm Mỹ", "male, middle-aged, low pitch, warm, american accent"],
                            ["Nữ Trẻ Anh", "female, young, high pitch, british accent"],
                            ["Thì Thầm", "whisper, female, young"],
                            ["Nam Già", "male, elderly, low pitch"]
                          ].map(([label, promptText]) => (
                            <button
                              key={label}
                              type="button"
                              onClick={() => {
                                if (!newVoiceName) {
                                  setNewVoiceName("Giọng " + label);
                                }
                                setVoiceDescription(promptText);
                              }}
                              style={{
                                padding: "4px 8px",
                                border: "1px solid #dce1ea",
                                borderRadius: "6px",
                                background: "white",
                                color: "var(--muted)",
                                fontSize: "10px",
                                fontWeight: 700,
                                cursor: "pointer",
                                transition: "all 0.15s"
                              }}
                            >
                              + {label}
                            </button>
                          ))}
                        </div>
                        <button type="submit" className="btn-submit-clone" disabled={isDesigning}>
                          {isDesigning ? <LoaderCircle className="spin" size={14} /> : <WandSparkles size={14} />}
                          {isDesigning ? "Đang phân tích & tạo..." : "Thiết kế & Tạo giọng"}
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              )}

              {/* 4. Translation Models Tab */}
              {settingsTab === "translate_models" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: "10px", marginBottom: "4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <h3 style={{ margin: 0, fontSize: "16px", color: "#27344e" }}>Model dịch thuật</h3>
                      <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>
                        Tải model llama.cpp tại đây. Model <strong>đã tải</strong> sẽ tự hiện trong <strong>Công cụ dịch</strong> ở sidebar workflow để bạn chọn làm engine dịch.
                      </p>
                    </div>
                    <button type="button" onClick={() => void refreshModels()} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", border: "1px solid var(--line)", borderRadius: "8px", background: "#fafbfe", color: "#46536d", fontSize: "12px", fontWeight: 700, cursor: "pointer" }}>
                      <RefreshCw size={13} /> Làm mới
                    </button>
                  </div>

                  {llamaCppModels.length > 0 && (
                    <div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {llamaCppModels.map((model) => renderTranslationModelRow(model))}
                      </div>
                    </div>
                  )}

                  {translationModels.filter((model) => model.engine !== "llama_cpp").length > 0 && (
                    <div>
                      <div style={{ fontSize: "11px", fontWeight: 800, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>🌐 Model dịch khác</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {translationModels.filter((model) => model.engine !== "llama_cpp").map((model) => renderTranslationModelRow(model))}
                      </div>
                    </div>
                  )}

                  {installedLlamaCppModels.length > 0 && (
                    <div style={{ fontSize: "12px", color: "#1a7c61", background: "#f0fdf8", border: "1px solid #b6e8d4", borderRadius: "10px", padding: "10px 14px" }}>
                      ✅ Sẵn sàng trong <strong>Công cụ dịch</strong>:{" "}
                      {installedLlamaCppModels.map((m) => m.label).join(" · ")}
                      {isColabBackend ? " (cache trên Colab GPU)" : ""}
                    </div>
                  )}

                  <div style={{ fontSize: "11px", color: "var(--muted)", paddingTop: "8px", borderTop: "1px solid var(--line)" }}>
                    💡 Model đã tải sẽ tự hiện trong <strong>Công cụ dịch</strong>. Lần dịch đầu tiên ứng dụng tự khởi động <code>llama-server</code> (API: http://127.0.0.1:8080/v1).
                  </div>
                </div>
              )}

              {/* 5. Models Tab */}
              {settingsTab === "models" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: "10px", marginBottom: "4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <h3 style={{ margin: 0, fontSize: "16px", color: "#27344e" }}>Quản lý Models AI</h3>
                      <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>Tải về, kiểm tra và xóa các model AI. Lưu tại: <strong style={{ color: "#46536d" }}>{cacheDir || "~/.cache/huggingface"}</strong></p>
                    </div>
                    <button type="button" onClick={() => void refreshModels()} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", border: "1px solid var(--line)", borderRadius: "8px", background: "#fafbfe", color: "#46536d", fontSize: "12px", fontWeight: 700, cursor: "pointer" }}>
                      <RefreshCw size={13} /> Làm mới
                    </button>
                  </div>

                  {/* Group by role */}
                  {(["TTS", "ASR", "Translation", "Diarisation"] as const).map(role => {
                    const roleModels = models.filter(m => m.role === role);
                    if (!roleModels.length) return null;
                    const roleLabels: Record<string, string> = {
                      TTS: "🎙️ Tạo giọng nói (TTS)",
                      ASR: "🎧 Nhận dạng giọng nói (ASR)",
                      Translation: "🌐 Dịch thuật",
                      Diarisation: "👥 Phân tách người nói",
                    };
                    return (
                      <div key={role}>
                        <div style={{ fontSize: "11px", fontWeight: 800, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>{roleLabels[role]}</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                          {roleModels.map(model => {
                            const isInstalling = installing === model.repo_id;
                            const isDeleting = deletingModel === model.repo_id;
                            const sizeLabel = model.size_gb >= 1 ? `${model.size_gb} GB` : `${Math.round(model.size_gb * 1024)} MB`;
                            return (
                              <div key={model.repo_id} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 14px", background: model.installed ? "#f0fdf8" : "#fafbfe", border: `1px solid ${model.installed ? "#b6e8d4" : "var(--line)"}`, borderRadius: "10px", transition: "all 0.2s" }}>
                                <div style={{ width: "34px", height: "34px", borderRadius: "8px", background: model.installed ? "#d1f5e8" : "#eef0f7", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                  {model.installed ? <Check size={16} color="#24967c" /> : <HardDrive size={16} color="#9aa5bf" />}
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                    <span style={{ fontSize: "13px", fontWeight: 700, color: "#27344e" }}>{model.label}</span>
                                    <span style={{ fontSize: "10px", padding: "1px 7px", borderRadius: "20px", background: model.installed ? "#c5f0df" : model.partial ? "#fff3cd" : "#eef0f7", color: model.installed ? "#1a7c61" : model.partial ? "#856404" : "#9aa5bf", fontWeight: 700 }}>{model.installed ? "Đã cài" : model.partial ? "Tải dở" : "Chưa tải"}</span>
                                    <span style={{ fontSize: "10px", color: "var(--muted)", fontWeight: 600 }}>{sizeLabel}</span>
                                  </div>
                                  <div style={{ fontSize: "11px", color: "#9aa5bf", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.repo_id}</div>
                                  {model.note && <div style={{ fontSize: "11px", color: "#7a8ba8", marginTop: "3px" }}>{model.note}</div>}
                                  {isInstalling && (
                                    <div style={{ marginTop: "6px", height: "4px", background: "#e0e8f0", borderRadius: "4px", overflow: "hidden" }}>
                                      <div style={{ height: "100%", width: `${installProgress}%`, background: "linear-gradient(90deg, #3b6ef5, #24967c)", borderRadius: "4px", transition: "width 0.4s" }} />
                                    </div>
                                  )}
                                </div>
                                <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                                  {!model.installed && (
                                    <button
                                      type="button"
                                      disabled={!!installing}
                                      onClick={() => void installModel(model)}
                                      style={{ display: "flex", alignItems: "center", gap: "5px", padding: "6px 12px", border: 0, borderRadius: "8px", background: "var(--blue)", color: "white", fontSize: "12px", fontWeight: 700, cursor: installing ? "not-allowed" : "pointer", opacity: installing ? 0.6 : 1 }}
                                    >
                                      {isInstalling ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}
                                      {isInstalling ? `${installProgress.toFixed(0)}%` : "Tải về"}
                                    </button>
                                  )}
                                  {model.installed && (
                                    <button
                                      type="button"
                                      disabled={isDeleting}
                                      onClick={async () => {
                                        if (!confirm(`Xóa model "${model.label}"?\nSẽ giải phóng ~${sizeLabel} dung lượng.`)) return;
                                        setDeletingModel(model.repo_id);
                                        try {
                                          await fetch(apiUrl(`/models/${encodeURIComponent(model.repo_id)}`), { method: "DELETE" });
                                          await refreshModels();
                                        } catch (e: any) {
                                          alert(`Lỗi xóa model: ${e.message || e}`);
                                        } finally {
                                          setDeletingModel("");
                                        }
                                      }}
                                      style={{ display: "flex", alignItems: "center", gap: "5px", padding: "6px 10px", border: "1px solid #f1cfd5", borderRadius: "8px", background: "#fff5f6", color: "#d55f6e", fontSize: "12px", fontWeight: 700, cursor: "pointer" }}
                                    >
                                      {isDeleting ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ fontSize: "11px", color: "var(--muted)", paddingTop: "8px", borderTop: "1px solid var(--line)" }}>
                    💡 Các model dịch thuật (MarianMT, NLLB-1.3B, llama.cpp GGUF) có thể tải trước tại đây hoặc tự tải khi chọn engine và nhấn Dịch lần đầu.
                  </div>
                </div>
              )}

              {/* 5. Douyin Login Tab */}
              {settingsTab === "douyin" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "600px" }}>
                  <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: "10px", marginBottom: "10px" }}>
                    <h3 style={{ margin: 0, fontSize: "16px", color: "#27344e" }}>Đăng nhập Douyin</h3>
                    <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "var(--muted)" }}>Đăng nhập tài khoản Douyin của bạn để lấy Cookie phục vụ việc tải video/phụ đề từ Douyin.</p>
                  </div>

                  <div className="settings-form-group" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                      <button
                        type="button"
                        onClick={async () => {
                          if (window.videoDubbingDesktop) {
                            try {
                              const cookie = await window.videoDubbingDesktop.fetchDouyinCookie();
                              if (cookie) {
                                setDouyinCookie(cookie);
                                alert("Đăng nhập và lấy Cookie Douyin thành công!");
                              } else {
                                alert("Không lấy được Cookie. Vui lòng thử lại!");
                              }
                            } catch (e: any) {
                              alert(`Lỗi đăng nhập: ${e.message || e}`);
                            }
                          }
                        }}
                        style={{ padding: "0 16px", height: "38px", border: "0", borderRadius: "10px", color: "white", background: "var(--blue)", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}
                      >
                        Đăng nhập Douyin
                      </button>
                      
                      {douyinCookie && (
                        <button
                          type="button"
                          onClick={async () => {
                            if (confirm("Bạn có chắc chắn muốn xóa Cookie Douyin?")) {
                              if (window.videoDubbingDesktop) {
                                await window.videoDubbingDesktop.saveDouyinCookie("");
                                setDouyinCookie("");
                              }
                            }
                          }}
                          style={{ padding: "0 16px", height: "38px", border: "0", borderRadius: "10px", color: "#d55f6e", background: "#fff5f6", cursor: "pointer", fontSize: "12px", fontWeight: 800 }}
                        >
                          Xóa phiên đăng nhập
                        </button>
                      )}
                    </div>

                    <div style={{ fontSize: "12px", color: douyinCookie ? "#24967c" : "#d55f6e", fontWeight: 700 }}>
                      Trạng thái: {douyinCookie ? "Đã đăng nhập" : "Chưa đăng nhập"}
                    </div>

                    {douyinCookie && (
                      <div style={{ background: "#f8f9fa", border: "1px solid var(--line)", borderRadius: "10px", padding: "12px" }}>
                        <div style={{ fontSize: "11px", color: "#717c91", marginBottom: "4px", fontWeight: 650 }}>Dữ liệu Cookie (Đã ẩn bớt):</div>
                        <div style={{ fontSize: "12px", fontFamily: "monospace", color: "#46536d", wordBreak: "break-all" }}>
                          {douyinCookie.substring(0, 50)}... [độ dài: {douyinCookie.length} ký tự]
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

            </div>
          </div>
        </main>
      )}

      {activeMainTab === "guide" && (
        <main className="workspace" style={{ display: "block" }}>
          <div className="guide-container">
            <div className="guide-layout">
              <div className="guide-header">
                <h1>Hướng Dẫn Sử Dụng Video Clone</h1>
                <p style={{ maxWidth: "700px", margin: "0 auto", fontSize: "14px", color: "#68748c" }}>
                  Studio dịch thuật và lồng tiếng video chuyên nghiệp sử dụng công nghệ trí tuệ nhân tạo (AI) ngoại tuyến. Tạo bản địa hóa chất lượng cao chỉ với vài bước đơn giản.
                </p>
              </div>

              <div className="guide-grid">
                {/* Cột trái: 6 bước thực hiện */}
                <div className="guide-steps-section">
                  <h2>Quy Trình Lồng Tiếng Video</h2>
                  <div className="guide-steps-grid">
                    <div className="guide-step-card">
                      <div className="guide-step-card-header">
                        <span className="guide-step-card-num">01</span>
                        <div className="guide-step-card-icon"><UploadCloud size={18} /></div>
                      </div>
                      <div className="guide-step-card-content">
                        <strong>Tải video đầu vào</strong>
                        <p>Thả tệp video (MP4, MOV, MKV, WebM) vào vùng làm việc. Hệ thống sẽ tự động phân tích định dạng và hiển thị trình phát video xem trước.</p>
                      </div>
                    </div>

                    <div className="guide-step-card">
                      <div className="guide-step-card-header">
                        <span className="guide-step-card-num">02</span>
                        <div className="guide-step-card-icon"><Settings size={18} /></div>
                      </div>
                      <div className="guide-step-card-content">
                        <strong>Cấu hình tham số</strong>
                        <p>Chọn ngôn ngữ gốc và ngôn ngữ cần dịch sang. Chọn công cụ dịch thuật và phương thức khớp thời lượng (tốc độ giọng hoặc co giãn video) phù hợp.</p>
                      </div>
                    </div>

                    <div className="guide-step-card">
                      <div className="guide-step-card-header">
                        <span className="guide-step-card-num">03</span>
                        <div className="guide-step-card-icon"><Video size={18} /></div>
                      </div>
                      <div className="guide-step-card-content">
                        <strong>Phân tích & Tách giọng</strong>
                        <p>Nhấn "Phân tích video". AI sẽ sử dụng mô hình Demucs để tách biệt hoàn toàn nhạc nền (Background) và giọng nói gốc của các nhân vật.</p>
                      </div>
                    </div>

                    <div className="guide-step-card">
                      <div className="guide-step-card-header">
                        <span className="guide-step-card-num">04</span>
                        <div className="guide-step-card-icon"><Languages size={18} /></div>
                      </div>
                      <div className="guide-step-card-content">
                        <strong>Dịch thuật & Biên tập</strong>
                        <p>Sau khi nhận dạng xong, chọn "Dịch toàn bộ". Bạn có thể trực tiếp chỉnh sửa câu dịch, timeline và nghe thử giọng lồng tiếng của từng câu thoại.</p>
                      </div>
                    </div>

                    <div className="guide-step-card">
                      <div className="guide-step-card-header">
                        <span className="guide-step-card-num">05</span>
                        <div className="guide-step-card-icon"><Mic2 size={18} /></div>
                      </div>
                      <div className="guide-step-card-content">
                        <strong>Tạo giọng lồng tiếng</strong>
                        <p>Nhấn "Tạo bản lồng tiếng". AI TTS thế hệ mới sẽ tổng hợp file audio tiếng Việt chất lượng cao cho từng phân đoạn theo đúng khớp thời gian.</p>
                      </div>
                    </div>

                    <div className="guide-step-card">
                      <div className="guide-step-card-header">
                        <span className="guide-step-card-num">06</span>
                        <div className="guide-step-card-icon"><Download size={18} /></div>
                      </div>
                      <div className="guide-step-card-content">
                        <strong>Xuất bản thành phẩm</strong>
                        <p>Tải xuống video thành phẩm đã được trộn (mix) giọng lồng tiếng mới và nhạc nền gốc, hoặc chỉ tải file audio WAV đã lồng tiếng và phụ đề SRT.</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Cột phải: Hướng dẫn chi tiết & Mẹo nâng cao */}
                <div className="guide-sidebar-section">
                  <h2>Hướng Dẫn Chuyên Sâu</h2>
                  
                  <div className="guide-box-advanced">
                    <h3><Gauge size={16} color="var(--blue)" /> Chế độ khớp thời lượng</h3>
                    <p>Lựa chọn phương pháp xử lý khi độ dài câu dịch khác với câu gốc:</p>
                    <ul>
                      <li><strong>Tự nhiên, rút gọn:</strong> AI tự động tóm lược câu dịch ngắn gọn hơn để vừa khít thời lượng nói tự nhiên.</li>
                      <li><strong>Smart Fit:</strong> AI tinh chỉnh tăng/giảm nhẹ tốc độ phát âm thanh của giọng nói để khớp với timeline.</li>
                      <li><strong>Co giãn video:</strong> Tự động làm chậm video (slow-motion) ở các đoạn câu dịch dài để người nghe kịp nghe hết.</li>
                      <li><strong>Khớp tuyệt đối:</strong> Cắt cưỡng bức hoặc đẩy nhanh tốc độ âm thanh tối đa để ép bằng được vào khung thời gian gốc.</li>
                    </ul>
                  </div>

                  <div className="guide-box-advanced">
                    <h3><Mic2 size={16} color="var(--blue)" /> Clone giọng chuẩn nhất</h3>
                    <p>Để tạo ra một giọng Clone AI tự nhiên giống người thật:</p>
                    <ul>
                      <li>Chọn tệp âm thanh mẫu có độ dài từ <strong>5 giây đến 15 giây</strong>.</li>
                      <li>Âm thanh mẫu phải <strong>không chứa nhạc nền, tiếng ồn, tiếng vang</strong> hoặc tạp âm môi trường.</li>
                      <li>Nhân vật trong file mẫu nên nói với <strong>tốc độ đều đặn, rõ lời</strong>, tránh tiếng thở mạnh hoặc biểu cảm quá khích.</li>
                    </ul>
                  </div>

                  <div className="guide-tip-card">
                    <div className="guide-tip-card-icon"><Sparkles size={20} /></div>
                    <div className="guide-tip-card-content">
                      <strong>Mẹo tối ưu hóa phần cứng</strong>
                      <p>Ứng dụng chạy AI hoàn toàn cục bộ (offline). Nếu máy tính của bạn có card đồ họa NVIDIA (hỗ trợ CUDA), ứng dụng sẽ tự động chuyển sang chế độ tăng tốc bằng GPU để tăng tốc độ nhận dạng và lồng tiếng gấp 5-10 lần so với CPU thông thường.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      )}
      {showExportModal && (
        <div className="modal-backdrop">
          <div className="modal-card" style={{ maxWidth: "460px", padding: "28px 24px", textAlign: "center", borderRadius: "20px" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
              <div style={{ width: "56px", height: "56px", borderRadius: "16px", background: exportSuccess ? "#ecfdf5" : "#edf2ff", color: exportSuccess ? "#10b981" : "var(--blue)", display: "grid", placeItems: "center" }}>
                {exportSuccess ? <Check size={26} /> : <LoaderCircle className="spin" size={26} />}
              </div>
              <div>
                <h3 style={{ margin: "0 0 6px 0", fontSize: "16px", color: "#27344e", fontWeight: 800 }}>
                  {exportSuccess
                    ? (driveExportResult ? "Đã xuất lên Google Drive" : "Đã xuất tệp thành công")
                    : "Đang xuất tệp"}
                </h3>
                <p style={{ margin: 0, fontSize: "13px", color: "var(--muted)", fontWeight: 650, whiteSpace: "pre-wrap" }}>{exportModalStatus}</p>
                {driveExportResult && (
                  <p style={{ margin: "10px 0 0", fontSize: "12px", color: "#64748b", lineHeight: 1.5 }}>
                    {driveExportResult.drive_path}
                  </p>
                )}
              </div>
              {!exportSuccess && (
                <>
                  <div style={{ width: "100%", background: "#e2e8f0", height: "8px", borderRadius: "99px", overflow: "hidden", marginTop: "4px" }}>
                    <div style={{ width: `${exportPercent}%`, height: "100%", background: "linear-gradient(90deg, var(--blue), #31b89a)", borderRadius: "99px", transition: "width 0.2s ease-out" }} />
                  </div>
                  <span style={{ fontSize: "14px", fontWeight: 850, color: "var(--blue)" }}>{exportPercent}%</span>
                </>
              )}
              {driveExportResult && (
                <div style={{ display: "flex", gap: "10px", width: "100%", marginTop: "4px" }}>
                  <button
                    type="button"
                    className="primary"
                    style={{ flex: 1, height: "42px" }}
                    onClick={() => openExternalUrl(driveExportResult.open_url || driveExportResult.folder_url)}
                  >
                    <Cloud size={15} /> Mở Google Drive
                  </button>
                  <button
                    type="button"
                    className="polish-secondary-btn"
                    style={{ flex: 1, height: "42px" }}
                    onClick={() => setShowExportModal(false)}
                  >
                    Đóng
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

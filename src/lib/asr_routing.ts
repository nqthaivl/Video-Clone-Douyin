/** Map installed ASR model repos to backend engines — parity with backend registries. */

import type { AsrBackendInfo, ModelInfo } from "./api";

export const SENSEVOICE_REPOS = new Set(["iic/SenseVoiceSmall", "FunAudioLLM/SenseVoiceSmall"]);

export const ASR_SIDEBAR_FALLBACK = [
  { id: "whisperx", label: "WhisperX" },
  { id: "funasr", label: "FunASR (SenseVoice)" },
] as const;

const ASR_BACKEND_LABELS: Record<string, string> = {
  whisperx: "WhisperX",
  "faster-whisper": "Faster-Whisper",
  funasr: "FunASR",
  "mlx-whisper": "MLX Whisper",
};

export type AsrSelectOption = {
  value: string;
  backend: string;
  repo: string;
  label: string;
  available: boolean;
  reason?: string;
};

export function encodeAsrSelection(backend: string, repo = ""): string {
  return repo ? `${backend}::${repo}` : backend;
}

export function decodeAsrSelection(value: string): { backend: string; repo: string } {
  const sep = value.indexOf("::");
  if (sep < 0) {
    return { backend: value || "whisperx", repo: "" };
  }
  return {
    backend: value.slice(0, sep) || "whisperx",
    repo: value.slice(sep + 2),
  };
}

export function routeAsrRepo(repoId: string): string {
  const rid = (repoId || "").trim();
  const low = rid.toLowerCase();
  if (SENSEVOICE_REPOS.has(rid) || low.includes("sensevoice")) {
    return "funasr";
  }
  if (rid.startsWith("mlx-community/") && low.includes("whisper")) {
    return "mlx-whisper";
  }
  if (rid.startsWith("nvidia/parakeet")) {
    return "nemo-parakeet";
  }
  if (rid.startsWith("UsefulSensors/moonshine")) {
    return "moonshine";
  }
  if (rid.startsWith("openai/whisper")) {
    return "pytorch-whisper";
  }
  if (low.includes("faster-whisper") || low.includes("faster-distil") || low.includes("whisper")) {
    return "whisperx";
  }
  return "whisperx";
}

export function whisperxSizeFromRepo(repoId: string): string {
  const low = (repoId || "").toLowerCase();
  if (low.includes("large-v3") || low.includes("large_v3")) return "large-v3";
  if (low.includes("large-v2") || low.includes("large_v2")) return "large-v2";
  if (low.includes("/large") || low.endsWith("-large")) return "large";
  if (low.includes("medium")) return "medium";
  if (low.includes("small")) return "small";
  if (low.includes("base")) return "base";
  if (low.includes("tiny")) return "tiny";
  return "large-v3";
}

export function resolveAsrBackend(backend: string, engines: AsrBackendInfo[]): string {
  const engine = engines.find((item) => item.id === backend);
  if (engine?.available) {
    return backend;
  }
  if (backend === "whisperx") {
    const fallback = engines.find((item) => item.id === "faster-whisper");
    if (fallback?.available) {
      return "faster-whisper";
    }
  }
  return backend;
}

export function formatAsrModelLabel(backend: string, modelLabel: string, repoId = ""): string {
  void modelLabel;
  const prefix = ASR_BACKEND_LABELS[backend] || backend;
  const repo = (repoId || "").trim();
  if (!repo) {
    return prefix;
  }
  const low = repo.toLowerCase();
  if (low.includes("sensevoice")) {
    return "SenseVoice";
  }
  if (low.includes("whisper")) {
    return `${prefix} (${whisperxSizeFromRepo(repo)})`;
  }
  const tail = repo.split("/").pop() || repo;
  if (tail && tail.length <= 36) {
    return `${prefix} (${tail})`;
  }
  return prefix;
}

export function buildAsrSelectOptions(
  models: ModelInfo[],
  engines: AsrBackendInfo[],
): AsrSelectOption[] {
  const installed = models.filter(
    (model) => model.role === "ASR" && model.installed && model.supported !== false,
  );
  const options: AsrSelectOption[] = [];
  const seen = new Set<string>();

  for (const model of installed) {
    const repo = model.repo_id;
    if (!repo) continue;
    const backend = resolveAsrBackend(routeAsrRepo(repo), engines);
    const key = encodeAsrSelection(backend, repo);
    if (seen.has(key)) continue;
    seen.add(key);
    const info = engines.find((item) => item.id === backend);
    const available = !!info?.available;
    options.push({
      value: key,
      backend,
      repo,
      label: formatAsrModelLabel(backend, model.label, repo),
      available,
      reason: available ? undefined : (info?.reason || info?.install_hint || undefined),
    });
  }

  if (options.length === 0) {
    for (const fallback of ASR_SIDEBAR_FALLBACK) {
      const backend = resolveAsrBackend(fallback.id, engines);
      const info = engines.find((item) => item.id === backend);
      const available = !!info?.available;
      const label =
        backend === fallback.id ? fallback.label : `${fallback.label} (Faster-Whisper)`;
      options.push({
        value: encodeAsrSelection(backend, ""),
        backend,
        repo: "",
        label,
        available,
        reason: available ? undefined : (info?.reason || info?.install_hint || undefined),
      });
    }
  }

  return options;
}

export function pickAsrSelection(
  options: AsrSelectOption[],
  savedBackend: string,
  savedRepo: string,
): string {
  if (!options.length) {
    return encodeAsrSelection(savedBackend || "whisperx", savedRepo || "");
  }
  const exact = options.find(
    (opt) => opt.backend === savedBackend && (opt.repo === savedRepo || (!savedRepo && !opt.repo)),
  );
  if (exact) {
    return exact.value;
  }
  const sameBackend = options.find((opt) => opt.backend === savedBackend && opt.available);
  if (sameBackend) {
    return sameBackend.value;
  }
  const firstAvailable = options.find((opt) => opt.available);
  return (firstAvailable || options[0]).value;
}

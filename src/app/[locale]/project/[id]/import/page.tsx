"use client";

import { useEffect, useState, useCallback, useRef, use } from "react";
import { useTranslations, useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import {
  Upload, FileText, Users, Layers, Sparkles,
  Loader2, Check, X, ArrowLeft, AlertCircle, Palette, GitBranch,
  RefreshCw, ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineModelPicker } from "@/components/editor/model-selector";
import { apiFetch } from "@/lib/api-fetch";
import { useModelStore } from "@/stores/model-store";
import { useModelGuard } from "@/hooks/use-model-guard";
import { toast } from "sonner";

const ACCEPTED = ".txt,.docx,.pdf,.md,.markdown";
const MAX_SIZE = 20 * 1024 * 1024;

interface ExtractedCharacter {
  name: string;
  frequency: number;
  description: string;
  visualHint?: string;
  scope: "main" | "guest";
}

interface SplitEpisode {
  title: string;
  description: string;
  keywords: string;
  idea: string;
  characters?: string[];
}

interface LogEntry {
  id: string;
  step: number;
  status: "running" | "done" | "error";
  message: string;
  metadata?: unknown;
  createdAt: string | number;
}

type Step = 1 | 2 | 3 | 4 | 5 | 6;

const STEPS = [
  { num: 1 as Step, icon: FileText, label: "importStep.parse" },
  { num: 2 as Step, icon: Palette, label: "importStep.assess" },
  { num: 3 as Step, icon: Users, label: "importStep.characters" },
  { num: 4 as Step, icon: Layers, label: "importStep.split" },
  { num: 5 as Step, icon: GitBranch, label: "importStep.arc" },
  { num: 6 as Step, icon: Sparkles, label: "importStep.generate" },
] as const;

export default function ImportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("import");
  const tc = useTranslations("common");
  const textGuard = useModelGuard("text");
  const getModelConfig = useModelStore((s) => s.getModelConfig);

  // Pipeline state
  const [currentStep, setCurrentStep] = useState<Step | 0>(0);
  const [stepStatus, setStepStatus] = useState<Record<Step, "idle" | "running" | "done" | "error">>({
    1: "idle", 2: "idle", 3: "idle", 4: "idle", 5: "idle", 6: "idle",
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Pipeline active guard: prevents double-start, enables fresh-start warning
  const [pipelineActive, setPipelineActive] = useState(false);
  // Tracks steps that need re-execution after upstream retry
  const [staleSteps, setStaleSteps] = useState<Set<Step>>(new Set());

  // Step 0: Upload
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Step 1 result
  const [fullText, setFullText] = useState("");

  // Step 2 result: project assessment
  const [projectAssess, setProjectAssess] = useState<{
    visualStyle: string; eraAesthetic: string; moodDirection: string;
    worldSetting: string; genre: string; targetAudience: string;
  } | null>(null);

  // Step 3 result: characters
  const [characters, setCharacters] = useState<ExtractedCharacter[]>([]);
  const [relationships, setRelationships] = useState<Array<{ characterA: string; characterB: string; relationType: string; description?: string }>>([]);

  // Step 4 result: episodes
  const [episodes, setEpisodes] = useState<SplitEpisode[]>([]);

  // Step 5 result: character arcs
  const [characterArcs, setCharacterArcs] = useState<any[]>([]);
  const [skippedChars, setSkippedChars] = useState<any[]>([]);

  // History mode
  const [historyMode, setHistoryMode] = useState(false);
  const [selectedStep, setSelectedStep] = useState<Step | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // Load existing logs on mount
  useEffect(() => {
    async function loadLogs() {
      setLoadingHistory(true);
      try {
        const res = await apiFetch(`/api/projects/${projectId}/import/logs`);
        const data = await res.json();
        if (data.length > 0) {
          setLogs(data);
          setHistoryMode(true);
          // Determine last completed step
          const doneSteps = data.filter((l: LogEntry) => l.status === "done").map((l: LogEntry) => l.step);
          const maxDone = Math.max(0, ...doneSteps) as Step | 0;
          setCurrentStep(maxDone);
          for (let s = 1; s <= 6; s++) {
            const stepLogs = data.filter((l: LogEntry) => l.step === s);
            // 取该步骤最后一条日志的状态（成功重试后 error 被 done 覆盖）
            const lastLog = stepLogs[stepLogs.length - 1] as LogEntry | undefined;
            if (lastLog) {
              setStepStatus((prev) => ({ ...prev, [s]: lastLog.status as "running" | "done" | "error" }));
            }
          }

          // Restore intermediate data from log metadata
          const step1Meta = data.find((l: LogEntry) => l.step === 1 && l.status === "done")?.metadata;
          if (step1Meta?.fullText) {
            setFullText(step1Meta.fullText);
          }
          const step2Meta = data.find((l: LogEntry) => l.step === 2 && l.status === "done")?.metadata;
          if (step2Meta) {
            setProjectAssess(step2Meta as typeof projectAssess);
          }
          const step3Meta = data.find((l: LogEntry) => l.step === 3 && l.status === "done")?.metadata;
          if (step3Meta?.characters) {
            setCharacters(step3Meta.characters);
          }
          if (step3Meta?.relationships) {
            setRelationships(step3Meta.relationships);
          }
          const step4Meta = data.find((l: LogEntry) => l.step === 4 && l.status === "done")?.metadata;
          if (step4Meta?.episodes) {
            setEpisodes(step4Meta.episodes);
          }
          const step5Meta = data.find((l: LogEntry) => l.step === 5 && l.status === "done")?.metadata;
          if (step5Meta?.characterArcs) {
            setCharacterArcs(step5Meta.characterArcs);
          }
          if (step5Meta?.skippedCharacters) {
            setSkippedChars(step5Meta.skippedCharacters);
          }
        }
      } catch (err) {
        // Network error on initial load — show toast, treat as fresh import
        if (err instanceof TypeError && err.message.includes("fetch")) {
          toast.error("网络连接失败，请检查网络后重试");
        }
        // Other errors (404, etc.) → silently treat as fresh import
      } finally {
        setLoadingHistory(false);
      }
    }
    loadLogs();
  }, [projectId]);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = useCallback((step: Step, status: LogEntry["status"], message: string) => {
    setLogs((prev) => [
      ...prev,
      { id: Date.now().toString(), step, status, message, createdAt: Date.now() },
    ]);
  }, []);

  const handleFile = useCallback((f: File) => {
    if (f.size > MAX_SIZE) {
      toast.error(t("fileTooLarge"));
      return;
    }
    setFile(f);
  }, [t]);

  // ── Pipeline control ──

  /** Reset all pipeline state: clears logs, data, and resets step statuses to idle */
  function resetPipeline() {
    setCurrentStep(0);
    setStepStatus({ 1: "idle", 2: "idle", 3: "idle", 4: "idle", 5: "idle", 6: "idle" });
    setLogs([]);
    setFullText("");
    setProjectAssess(null);
    setCharacters([]);
    setRelationships([]);
    setEpisodes([]);
    setCharacterArcs([]);
    setSkippedChars([]);
    setHistoryMode(false);
    setSelectedStep(null);
    setStaleSteps(new Set());
    setPipelineActive(false);
  }

  /**
   * Mark all downstream steps (n+1 … 6) as stale.
   * Clears downstream data and resets step statuses.
   * When a user retries step N, everything after N must be re-run.
   */
  function markDownstreamStale(n: Step) {
    setStaleSteps((prev) => {
      const next = new Set(prev);
      for (let s = n + 1; s <= 6; s++) next.add(s as Step);
      return next;
    });
    setStepStatus((prev) => {
      const next = { ...prev };
      for (let s = n + 1; s <= 6; s++) next[s as Step] = "idle";
      return next;
    });
    // Also clear downstream data to prevent stale previews
    if (n < 2) setProjectAssess(null);
    if (n < 3) { setCharacters([]); setRelationships([]); }
    if (n < 4) setEpisodes([]);
    if (n < 5) { setCharacterArcs([]); setSkippedChars([]); }
  }

  // ── Step 1 + 2: Auto-run parse → assessment → character extraction ──
  async function startPipeline() {
    if (!file) return;
    if (!textGuard()) return;

    // Guard: warn if pipeline is already running
    if (pipelineActive) {
      if (!window.confirm("已有导入进行中, 是否重新开始?")) return;
      resetPipeline();
      await apiFetch(`/api/projects/${projectId}/import/logs`, { method: "DELETE" });
    }

    setPipelineActive(true);
    setHistoryMode(false);
    setLogs([]);

    // Clear old logs
    await apiFetch(`/api/projects/${projectId}/import/logs`, { method: "DELETE" });

    // Step 1: Parse
    setCurrentStep(1);
    setStepStatus((prev) => ({ ...prev, 1: "running" }));
    addLog(1, "running", `解析文件: ${file.name}`);

    let text: string;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch(`/api/projects/${projectId}/import/parse`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      text = data.text;
      setFullText(text);
      addLog(1, "done", `解析完成，共 ${data.charCount} 字`);
      setStepStatus((prev) => ({ ...prev, 1: "done" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Parse failed";
      addLog(1, "error", `文件解析失败: ${msg}`);
      setStepStatus((prev) => ({ ...prev, 1: "error" }));
      setPipelineActive(false);
      return;
    }

    // Step 2: Project assessment
    setCurrentStep(2);
    setStepStatus((prev) => ({ ...prev, 2: "running" }));
    addLog(2, "running", "开始项目定位分析...");

    let assess: typeof projectAssess = null;
    try {
      const assessRes = await apiFetch(`/api/projects/${projectId}/import/assess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, modelConfig: getModelConfig() }),
      });
      if (!assessRes.ok) {
        const errData = await assessRes.json();
        throw new Error(errData.error || `HTTP ${assessRes.status}`);
      }
      assess = await assessRes.json();
      setProjectAssess(assess);
      addLog(2, "done", `项目定位完成: ${assess?.visualStyle?.slice(0, 30) || "..."}`);
      setStepStatus((prev) => ({ ...prev, 2: "done" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Assess failed";
      addLog(2, "error", `项目定位失败: ${msg}`);
      setStepStatus((prev) => ({ ...prev, 2: "error" }));
      setPipelineActive(false);
      return;
    }
    
    setPipelineActive(false);
  }

  // ── Step 1 only: Retry parse ──
  async function retryParse() {
    if (!file) return;
    if (pipelineActive) { toast.warning("正在处理中，请等待完成"); return; }
    setPipelineActive(true);

    setStepStatus((prev) => ({ ...prev, 1: "running" }));
    addLog(1, "running", `重试解析文件: ${file.name}`);

    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch(`/api/projects/${projectId}/import/parse`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setFullText(data.text);
      addLog(1, "done", `解析完成，共 ${data.charCount} 字`);
      setStepStatus((prev) => ({ ...prev, 1: "done" }));
      // Text changed — invalidate all downstream steps
      markDownstreamStale(1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Parse failed";
      addLog(1, "error", `文件解析失败: ${msg}`);
      setStepStatus((prev) => ({ ...prev, 1: "error" }));
    } finally {
      setPipelineActive(false);
    }
  }

  // ── Step 2 only: Retry project assessment ──
  async function retryAssess() {
    if (!fullText) return;
    if (!textGuard()) return;
    if (pipelineActive) { toast.warning("正在处理中，请等待完成"); return; }
    setPipelineActive(true);

    setStepStatus((prev) => ({ ...prev, 2: "running" }));
    addLog(2, "running", "重试项目定位分析...");

    try {
      const res = await apiFetch(`/api/projects/${projectId}/import/assess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: fullText, modelConfig: getModelConfig() }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const assess = await res.json();
      setProjectAssess(assess);
      addLog(2, "done", `项目定位完成: ${assess?.visualStyle?.slice(0, 30)}`);
      setStepStatus((prev) => ({ ...prev, 2: "done" }));
      markDownstreamStale(2);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Assess failed";
      addLog(2, "error", `项目定位失败: ${msg}`);
      setStepStatus((prev) => ({ ...prev, 2: "error" }));
    } finally {
      setPipelineActive(false);
    }
  }

  // ── Step 3 only: Retry character extraction ──
  async function retryCharacterExtract() {
    if (!fullText) return;
    if (!textGuard()) return;
    if (pipelineActive) { toast.warning("正在处理中，请等待完成"); return; }
    setPipelineActive(true);

    setStepStatus((prev) => ({ ...prev, 3: "running" }));
    addLog(3, "running", "重试角色提取...");

    try {
      const res = await apiFetch(`/api/projects/${projectId}/import/characters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: fullText,
          modelConfig: getModelConfig(),
          styleContext: projectAssess ? { visualStyle: projectAssess.visualStyle, eraAesthetic: projectAssess.eraAesthetic } : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setCharacters(data.characters);
      setRelationships(data.relationships || []);
      const mainCount = data.characters.filter((c: ExtractedCharacter) => c.scope === "main").length;
      const guestCount = data.characters.length - mainCount;
      addLog(3, "done", `提取完成: ${mainCount} 个主角, ${guestCount} 个配角`);
      setStepStatus((prev) => ({ ...prev, 3: "done" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Extract failed";
      addLog(3, "error", `角色提取失败: ${msg}`);
      setStepStatus((prev) => ({ ...prev, 3: "error" }));
    } finally {
      setPipelineActive(false);
    }
  }

  // ── Step 3 retry + invalidate downstream ──
  async function retryCharacterExtractAndInvalidate() {
    await retryCharacterExtract();
    markDownstreamStale(3);
  }

  // ── Step 3 → proceed to split ──
  async function proceedToSplit() {
    setStepStatus((prev) => ({ ...prev, 4: "running" }));
    await runSplit();
  }

  // ── Step 4: Split (triggered by user after reviewing characters) ──
  async function runSplit() {
    if (!textGuard()) return;
    if (pipelineActive) { toast.warning("正在处理中，请等待完成"); return; }
    setPipelineActive(true);

    setCurrentStep(4);
    setStepStatus((prev) => ({ ...prev, 4: "running" }));
    addLog(4, "running", "开始自动分集...");

    try {
      const res = await apiFetch(`/api/projects/${projectId}/import/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: fullText,
          allCharacters: characters.map((c) => ({ name: c.name, scope: c.scope })),
          modelConfig: getModelConfig(),
          styleContext: projectAssess ? {
            visualStyle: projectAssess.visualStyle,
            eraAesthetic: projectAssess.eraAesthetic,
            moodDirection: projectAssess.moodDirection,
            worldSetting: projectAssess.worldSetting,
          } : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setEpisodes(data.episodes);
      addLog(4, "done", `分集完成，共 ${data.episodes.length} 集`);
      setStepStatus((prev) => ({ ...prev, 4: "done" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Split failed";
      addLog(4, "error", `分集失败: ${msg}`);
      setStepStatus((prev) => ({ ...prev, 4: "error" }));
    } finally {
      setPipelineActive(false);
    }
  }

  // ── Step 4 retry + invalidate downstream ──
  async function retrySplitAndInvalidate() {
    await runSplit();
    markDownstreamStale(4);
  }

  // ── Step 4 → proceed to arc design ──
  async function proceedToArc() {
    setStepStatus((prev) => ({ ...prev, 5: "running" }));
    await runArc();
  }

    // ── Step 5: Character arcs (triggered by user after reviewing episodes) ──
  async function runArc() {
    if (!textGuard()) return;
    if (pipelineActive) { toast.warning("正在处理中，请等待完成"); return; }
    setPipelineActive(true);

    setCurrentStep(5);
    setStepStatus((prev) => ({ ...prev, 5: "running" }));
    addLog(5, "running", "开始角色弧光设计...");

    try {
      const res = await apiFetch(`/api/projects/${projectId}/import/arc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characters: characters.map((c) => ({ name: c.name, scope: c.scope, description: c.description })),
          episodes: episodes.map((ep, i) => ({ title: ep.title, sequence: i + 1, idea: ep.idea, characters: ep.characters })),
          projectAssess: projectAssess ? {
            visualStyle: projectAssess.visualStyle,
            eraAesthetic: projectAssess.eraAesthetic,
          } : { visualStyle: "", eraAesthetic: "" },
          modelConfig: getModelConfig(),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const arcData = await res.json();
      setCharacterArcs(arcData.characterArcs || []);
      setSkippedChars(arcData.skippedCharacters || []);
      const totalPhases = (arcData.characterArcs || []).reduce(
        (sum: number, a: any) => sum + (a.phases?.length || 0), 0
      );
      addLog(5, "done", `弧光设计完成: ${arcData.characterArcs?.length || 0} 个角色 / ${totalPhases} 个阶段`);
      setStepStatus((prev) => ({ ...prev, 5: "done" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Arc failed";
      addLog(5, "error", `弧光设计失败: ${msg}`);
      setStepStatus((prev) => ({ ...prev, 5: "error" }));
    } finally {
      setPipelineActive(false);
    }
  }

  // ── Step 5 retry + invalidate downstream ──
  async function retryArcAndInvalidate() {
    await runArc();
    markDownstreamStale(5);
  }

  // ── Step 5 → 进入 Step 6：展示数据总览，由用户确认后再写入 ──
  function proceedToGenerate() {
    setCurrentStep(6);
    setStepStatus((prev) => ({ ...prev, 6: "running" }));
  }

  // ── Step 6: Generate episodes + characters (with optional regenerate) ──
  async function runGenerate(regenerate = false) {
    if (pipelineActive) { toast.warning("正在处理中，请等待完成"); return; }
    setPipelineActive(true);

    setCurrentStep(6);
    setStepStatus((prev) => ({ ...prev, 6: "running" }));
    addLog(6, "running", regenerate
      ? "清空并重建分集和角色..."
      : `创建 ${episodes.length} 集和角色...`);

    try {
      const res = await apiFetch(`/api/projects/${projectId}/import/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episodes,
          characters,
          relationships,
          projectAssess: projectAssess ? {
            visualStyle: projectAssess.visualStyle,
            eraAesthetic: projectAssess.eraAesthetic,
            moodDirection: projectAssess.moodDirection,
          } : undefined,
          characterArcs: characterArcs.length > 0 ? characterArcs : undefined,
          regenerate,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      addLog(6, "done", `导入完成！创建了 ${data.characterCount} 个角色和 ${data.episodes.length} 集`);
      setStepStatus((prev) => ({ ...prev, 6: "done" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Generate failed";
      addLog(6, "error", `创建失败: ${msg}`);
      setStepStatus((prev) => ({ ...prev, 6: "error" }));
    } finally {
      setPipelineActive(false);
    }
  }

  // Retry handler for any failed step
  function retryStep() {
    const failedStep = ([1, 2, 3, 4, 5, 6] as Step[]).find((s) => stepStatus[s] === "error");
    if (!failedStep) return;
    switch (failedStep) {
      case 1:
        retryParse();
        break;
      case 2:
        retryAssess();
        break;
      case 3:
        retryCharacterExtract();
        break;
      case 4:
        runSplit();
        break;
      case 5:
        runArc();
        break;
      case 6:
        runGenerate(false);
        break;
    }
  }

  function toggleScope(idx: number) {
    setCharacters((prev) =>
      prev.map((c, i) =>
        i === idx ? { ...c, scope: c.scope === "main" ? "guest" : "main" } : c
      )
    );
  }

  function updateEpisode(idx: number, field: keyof SplitEpisode, value: string) {
    setEpisodes((prev) =>
      prev.map((ep, i) => (i === idx ? { ...ep, [field]: value } : ep))
    );
  }

  function removeEpisode(idx: number) {
    setEpisodes((prev) => prev.filter((_, i) => i !== idx));
  }

  const stepIcon = (status: string) => {
    switch (status) {
      case "running": return <Loader2 className="h-4 w-4 animate-spin" />;
      case "done": return <Check className="h-4 w-4" />;
      case "error": return <AlertCircle className="h-4 w-4" />;
      default: return null;
    }
  };

  const stepColor = (status: string, selected: boolean) => {
    const base = (() => {
      switch (status) {
        case "running": return "border-primary/30 bg-primary/5 text-primary";
        case "done": return "border-transparent bg-[--surface] text-[--text-primary]";
        case "error": return "border-red-300 bg-red-50 text-red-500";
        default: return "border-transparent bg-[--surface] text-[--text-muted]";
      }
    })();
    if (selected) return base + " !bg-primary/10 !border-primary/40 !text-primary shadow-sm";
    return base;
  };

  // ── Confirmation phase / static preview helpers ──
  const isConfirmPhase = (s: Step): boolean => {
    if (s === 6) return stepStatus[6] === "done" && !historyMode;
    if (historyMode) return stepStatus[s] === "done"; // show retry buttons for all done steps
    return stepStatus[s] === "done" && stepStatus[(s + 1) as Step] === "idle";
  };

  // ── Middle content renderer ──
  function renderStepContent() {
    // Determine which step's content to display
    let displayStep: Step | null = selectedStep;

    if (!displayStep) {
      // Auto-detect: find confirm phase step
      for (const s of [1, 2, 3, 4, 5, 6] as Step[]) {
        if (isConfirmPhase(s)) { displayStep = s; break; }
      }
      // Auto-detect: find running step
      if (!displayStep) {
        for (const s of [1, 2, 3, 4, 5, 6] as Step[]) {
          if (stepStatus[s] === "running") { displayStep = s; break; }
        }
      }
      // Auto-detect: find error step
      if (!displayStep) {
        for (const s of [1, 2, 3, 4, 5, 6] as Step[]) {
          if (stepStatus[s] === "error") { displayStep = s; break; }
        }
      }
    }

    // Case 1: No step selected & no active pipeline & currentStep === 0 — upload area
    if (!displayStep && currentStep === 0 && !historyMode) {
      return (
        <div className="mx-auto w-full max-w-xl space-y-6">
          {/* Drop zone */}
          <div
            className={`relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-12 transition-colors ${
              dragOver
                ? "border-primary bg-primary/5"
                : file
                  ? "border-emerald-300 bg-emerald-50/50"
                  : "border-[--border-subtle] bg-white"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onClick={() => inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED}
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
            />
            {file ? (
              <div className="flex items-center gap-3">
                <FileText className="h-10 w-10 text-emerald-500" />
                <div>
                  <p className="text-sm font-medium text-[--text-primary]">{file.name}</p>
                  <p className="text-xs text-[--text-muted]">{(file.size / 1024).toFixed(1)} KB</p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); setFile(null); }}
                  className="ml-2 flex h-6 w-6 items-center justify-center rounded-full hover:bg-black/5"
                >
                  <X className="h-3.5 w-3.5 text-[--text-muted]" />
                </button>
              </div>
            ) : (
              <>
                <Upload className="mb-3 h-10 w-10 text-[--text-muted]" />
                <p className="text-sm font-medium text-[--text-primary]">{t("dropHint")}</p>
                <p className="mt-1 text-xs text-[--text-muted]">{t("supportedFormats")}</p>
              </>
            )}
          </div>

          <Button
            onClick={startPipeline}
            disabled={!file}
            className="w-full rounded-xl"
            size="lg"
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {t("startImport")}
          </Button>
        </div>
      );
    }

    // Case 5: No step selected — empty state
    if (!displayStep) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[--text-muted]">
          <FileText className="h-12 w-12 opacity-30" />
          <p className="text-sm">{t("selectStepHint") || "请从左侧选择一个已完成的步骤查看详情"}</p>
        </div>
      );
    }

    const s = displayStep;
    const confirm = isConfirmPhase(s);

    // Case 2: Step is running
    if (stepStatus[s] === "running") {
      const latestLog = [...logs].reverse().find(l => l.step === s);
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-sm font-medium text-[--text-primary]">{t("processing") || "处理中..."}</p>
          {latestLog && (
            <p className="max-w-md text-center text-xs text-[--text-muted]">{latestLog.message}</p>
          )}
        </div>
      );
    }

    // Case 3: Step has error
    if (stepStatus[s] === "error") {
      const errorLog = [...logs].reverse().find(l => l.step === s && l.status === "error");
      const retryHandler: Record<Step, () => void> = {
        1: retryParse, 2: retryAssess, 3: retryCharacterExtract,
        4: runSplit, 5: runArc, 6: () => runGenerate(false),
      };
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
            <AlertCircle className="h-6 w-6 text-red-500" />
          </div>
          <p className="text-sm font-medium text-[--text-primary]">{t("stepFailed") || "步骤执行失败"}</p>
          {errorLog && (
            <p className="max-w-md text-center text-xs text-red-500">{errorLog.message}</p>
          )}
          <Button onClick={retryHandler[s]} className="rounded-xl">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t("retry") || "重试"}
          </Button>
        </div>
      );
    }

    // Case 4: Step done — render step-specific content
    switch (s) {
      // ── Step 1: character count + text preview (first 500 chars) ──
      case 1:
        return (
          <div className="space-y-4">
            <h3 className="font-display text-lg font-bold text-[--text-primary]">
              {t("parseComplete") || "文件解析完成"}
            </h3>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 px-4 py-3">
              <span className="text-sm text-[--text-muted]">{t("totalCharacters") || "总字数"}: </span>
              <span className="text-lg font-bold text-emerald-600">{fullText.length.toLocaleString()}</span>
            </div>
            <div>
              <h4 className="mb-2 text-sm font-medium text-[--text-secondary]">{t("textPreview") || "文本预览"}</h4>
              <div className="max-h-48 overflow-y-auto rounded-xl border border-[--border-subtle] bg-white p-4">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-[--text-primary]">
                  {fullText.slice(0, 500)}{fullText.length > 500 && "..."}
                </p>
              </div>
            </div>
          </div>
        );

      // ── Step 2: editable project fields + confirm button (confirm phase only) ──
      case 2:
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-[--text-primary]">
                {t("reviewAssess") || "项目定位确认"}
              </h3>
              {confirm && (
                <Button
                  onClick={() => {
                    setStepStatus((prev) => ({ ...prev, 3: "running" }));
                    retryCharacterExtract();
                  }}
                  className="rounded-xl"
                >
                  {t("confirmAndExtract") || "确认定位并提取角色"}
                </Button>
              )}
            </div>
            <p className="text-sm text-[--text-muted]">{t("reviewAssessHint") || "以下是AI分析的项目定位，请确认或返回修改。这些字段将影响后续所有创作。"}</p>
            {projectAssess ? (
              <div className="grid gap-3">
                {[
                  { key: "visualStyle", label: "视觉风格", value: projectAssess.visualStyle },
                  { key: "eraAesthetic", label: "时代美学", value: projectAssess.eraAesthetic },
                  { key: "moodDirection", label: "情绪基调", value: projectAssess.moodDirection },
                  { key: "worldSetting", label: "世界观", value: projectAssess.worldSetting },
                  { key: "genre", label: "题材类型", value: projectAssess.genre },
                  { key: "targetAudience", label: "目标受众", value: projectAssess.targetAudience },
                ].filter((f) => f.value != null).map((field) => (
                  <div key={field.key} className="rounded-xl border border-[--border-subtle] bg-white p-3">
                    <div className="text-xs font-medium text-[--text-muted] mb-1">{field.label}</div>
                    {confirm ? (
                      <Input
                        value={field.value}
                        onChange={(e) => {
                          setProjectAssess((prev) => prev ? { ...prev, [field.key]: e.target.value } : null);
                        }}
                        className="text-sm border-0 bg-transparent p-0 h-auto shadow-none focus-visible:ring-0"
                      />
                    ) : (
                      <div className="text-sm text-[--text-primary]">{field.value}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[--text-muted]">{t("noData") || "暂无数据"}</p>
            )}
          </div>
        );

      // ── Step 3: character cards + [retry] + [confirmAndSplit] (confirm phase only) ──
      case 3:
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-[--text-primary]">
                {t("reviewCharacters")}
              </h3>
              {confirm && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={retryCharacterExtractAndInvalidate}
                    className="rounded-xl"
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    {t("retryExtract") || "重新提取"}
                  </Button>
                  <Button onClick={proceedToSplit} className="rounded-xl">
                    {t("confirmAndSplit") || "确认并去分集"}
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
            <p className="text-sm text-[--text-muted]">{t("reviewCharactersHint")}</p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
              {characters.map((char, idx) => (
                <div
                  key={idx}
                  className="group relative overflow-hidden rounded-[14px] border border-[--border-subtle] bg-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/5 hover:border-[--border-hover]"
                >
                  {/* Top accent strip */}
                  <div className={`h-1 w-full ${char.scope === "main" ? "bg-gradient-to-r from-blue-500 to-blue-400" : "bg-gradient-to-r from-purple-500 to-purple-400"}`} />
                  <div className="p-3.5">
                    {/* Avatar + Name */}
                    <div className="mb-2.5 flex items-center gap-2.5">
                      <div
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-sm font-bold text-white"
                        style={{ background: `linear-gradient(135deg, hsl(${(char.name.charCodeAt(0) * 37) % 360}, 45%, 45%), hsl(${(char.name.charCodeAt(0) * 37) % 360}, 50%, 55%))` }}
                      >
                        {char.name.charAt(0)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-bold text-[--text-primary]">{char.name}</div>
                        <div className="flex items-center gap-1.5 text-[10px] text-[--text-muted]">
                          <span>{t("frequency")} {char.frequency}</span>
                          {char.visualHint && (
                            <>
                              <span className="h-[3px] w-[3px] rounded-full bg-[#ddd]" />
                              <span className="truncate">{char.visualHint}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    {/* Visual hint tag */}
                    {char.visualHint && (
                      <div className="mb-2 inline-block rounded-md bg-[--surface] px-2 py-0.5 text-[10px] font-medium text-[--text-muted]">
                        {char.visualHint}
                      </div>
                    )}
                    {/* Description */}
                    <p className="line-clamp-2 text-[11px] leading-relaxed text-[--text-muted]">{char.description}</p>
                  </div>
                  {/* Scope badge (floating, clickable in confirm mode) */}
                  {confirm ? (
                    <button
                      onClick={() => toggleScope(idx)}
                      className={`absolute right-3 top-3 rounded-[8px] px-2 py-0.5 text-[9px] font-bold tracking-wide transition-colors ${
                        char.scope === "main"
                          ? "bg-blue-50 text-blue-600 hover:bg-blue-100"
                          : "bg-purple-50 text-purple-600 hover:bg-purple-100"
                      }`}
                    >
                      {char.scope === "main" ? t("main") : t("guest")}
                    </button>
                  ) : (
                    <span className={`absolute right-3 top-3 rounded-[8px] px-2 py-0.5 text-[9px] font-bold tracking-wide ${
                      char.scope === "main" ? "bg-blue-50 text-blue-600" : "bg-purple-50 text-purple-600"
                    }`}>
                      {char.scope === "main" ? t("main") : t("guest")}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Character relationships */}
            {relationships.length > 0 && (
              <div className="mt-6 space-y-3">
                <h4 className="text-sm font-semibold text-[--text-secondary]">
                  {t("characterRelations") || "角色关系"} ({relationships.length})
                </h4>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2">
                  {relationships.map((rel, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 rounded-xl border border-[--border-subtle] bg-white/60 p-3 text-sm"
                    >
                      <span className="font-medium text-[--text-primary]">{rel.characterA}</span>
                      <span className="text-xs text-[--text-muted]">
                        {rel.relationType === "ally" ? "盟友" :
                         rel.relationType === "enemy" ? "敌对" :
                         rel.relationType === "lover" ? "恋人" :
                         rel.relationType === "family" ? "亲属" :
                         rel.relationType === "mentor" ? "师徒" :
                         rel.relationType === "rival" ? "对手" :
                         rel.relationType === "stranger" ? "陌路" :
                         rel.relationType === "neutral" ? "中立" : rel.relationType}
                      </span>
                      <span className="font-medium text-[--text-primary]">{rel.characterB}</span>
                      {rel.description && (
                        <span className="ml-1 text-xs text-[--text-muted]">— {rel.description}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );

      // ── Step 4: episode list + [retry] + [confirmAndArc] (confirm phase only) ──
      case 4:
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-[--text-primary]">
                {t("reviewEpisodes")} ({episodes.length})
              </h3>
              {confirm && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={retrySplitAndInvalidate}
                    className="rounded-xl"
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    {t("retrySplit") || "重新分集"}
                  </Button>
                  <Button onClick={proceedToArc} className="rounded-xl">
                    {t("confirmAndArc") || "确认并设计弧光"}
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
            <p className="text-sm text-[--text-muted]">{t("reviewEpisodesHint")}</p>
            <div className="space-y-3">
              {episodes.map((ep, idx) => (
                <div
                  key={idx}
                  className="rounded-xl border border-[--border-subtle] bg-white p-4"
                >
                  <div className="mb-2 flex items-center gap-3">
                    <span className="shrink-0 rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
                      EP.{String(idx + 1).padStart(2, "0")}
                    </span>
                    {confirm ? (
                      <Input
                        value={ep.title}
                        onChange={(e) => updateEpisode(idx, "title", e.target.value)}
                        className="h-8 text-sm font-semibold"
                      />
                    ) : (
                      <span className="text-sm font-semibold text-[--text-primary]">{ep.title}</span>
                    )}
                    {confirm && (
                      <button
                        onClick={() => removeEpisode(idx)}
                        className="shrink-0 text-[--text-muted] hover:text-red-500"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-[--text-muted]">{ep.description}</p>
                  {ep.characters && ep.characters.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {ep.characters.map((name) => {
                        const isMain = characters.some((c) => c.name === name && c.scope === "main");
                        return (
                          <span key={name} className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${isMain ? "bg-blue-50 text-blue-600" : "bg-purple-50 text-purple-600"}`}>
                            {name}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {ep.keywords && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {ep.keywords.split(/[,，]/).map((kw) => kw.trim()).filter(Boolean).map((kw) => (
                        <span key={kw} className="rounded bg-primary/8 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {kw}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );

      // ── Step 5: arc results + [retry] + [confirmAndGenerate] (confirm phase only) ──
      case 5:
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-[--text-primary]">
                {t("reviewArcs") || "角色弧光设计确认"} ({characterArcs.length} 角色{skippedChars.length > 0 ? `，跳过 ${skippedChars.length} 个` : ""})
              </h3>
              {confirm && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={retryArcAndInvalidate}
                    className="rounded-xl"
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    {t("retryArc") || "重新设计弧光"}
                  </Button>
                  <Button onClick={proceedToGenerate} className="rounded-xl">
                    {t("confirmAndGenerate") || "确认并创建分集"}
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
            <p className="text-sm text-[--text-muted]">{t("reviewArcsHint") || "以下是AI设计的角色弧光。请确认各角色在剧集中的发展轨迹。"}</p>
            <div className="space-y-3">
              {characterArcs.map((arc: any, ai: number) => {
                const charInfo = characters.find(
                  (c) => c.name.toLowerCase().trim() === arc.characterName?.toLowerCase().trim()
                );
                return (
                  <div key={ai} className="rounded-xl border border-[--border-subtle] bg-white p-4">
                    <div className="mb-3 flex items-center gap-3">
                      <div
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
                        style={{ background: `linear-gradient(135deg, hsl(${(arc.characterName?.charCodeAt?.(0) ?? 0 * 37) % 360}, 45%, 45%), hsl(${(arc.characterName?.charCodeAt?.(0) ?? 0 * 37) % 360}, 50%, 55%))` }}
                      >
                        {(arc.characterName || "?").charAt(0)}
                      </div>
                      <div>
                        <span className="text-sm font-bold text-[--text-primary]">{arc.characterName}</span>
                        {charInfo && (
                          <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                            charInfo.scope === "main" ? "bg-blue-50 text-blue-600" : "bg-purple-50 text-purple-600"
                          }`}>
                            {charInfo.scope === "main" ? t("main") : t("guest")}
                          </span>
                        )}
                        <span className="ml-1 text-xs text-[--text-muted]">{arc.totalPhases || arc.phases?.length || 0} 个阶段</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {(arc.phases || []).map((phase: any, pi: number) => (
                        <div key={pi} className="ml-4 rounded-lg border border-[--border-subtle] bg-[--surface] p-3">
                          <div className="mb-1 flex items-center gap-2">
                            <span className="text-xs font-semibold text-primary">{phase.phaseName}</span>
                            {(phase.episodeStart || phase.episodeEnd) && (
                              <span className="text-[10px] text-[--text-muted]">
                                EP.{phase.episodeStart}{phase.episodeEnd && phase.episodeEnd !== phase.episodeStart ? `–${phase.episodeEnd}` : ""}
                              </span>
                            )}
                          </div>
                          {phase.triggerEvent && (
                            <p className="text-[11px] text-[--text-muted]">
                              <span className="font-medium text-[--text-secondary]">触发: </span>
                              {phase.triggerEvent}
                            </p>
                          )}
                          {phase.statusChange && (
                            <p className="text-[11px] text-[--text-muted]">
                              <span className="font-medium text-[--text-secondary]">状态: </span>
                              {phase.statusChange}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {skippedChars.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs font-medium text-amber-700 mb-1">跳过的角色</p>
                  {skippedChars.map((sc: any, si: number) => (
                    <p key={si} className="text-[11px] text-amber-600">
                      {sc.characterName}: {sc.reason}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        );

      // ── Step 6: import complete ──
      case 6: {
        const mainCount = characters.filter((c) => c.scope === "main").length;
        const guestCount = characters.length - mainCount;
        const totalPhases = characterArcs.reduce(
          (sum: number, a) => sum + (a.phases?.length || 0),
          0
        );

        if (stepStatus[6] === "done") {
          // 已写入 → "导入完成" 屏幕
          return (
            <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
                <Check className="h-6 w-6 text-emerald-600" />
              </div>
              <div>
                <h3 className="font-display text-lg font-bold text-[--text-primary]">
                  {t("importComplete") || "导入完成"}
                </h3>
                <p className="mt-1 text-sm text-[--text-muted]">
                  {t("importCompleteHint") || "分集和角色已写入，可以开始制作漫画了。"}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => router.push(`/${locale}/project/${projectId}/episodes`)}
                  className="rounded-xl"
                >
                  {t("goToProject") || "进入项目"}
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    if (!textGuard()) return;
                    setStepStatus((prev) => ({ ...prev, 6: "running" }));
                    setPipelineActive(true);
                    await runGenerate(true);
                    setPipelineActive(false);
                  }}
                  className="rounded-xl"
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  重新生成
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setHistoryMode(false);
                  setSelectedStep(null);
                  resetPipeline();
                }}
              >
                {t("newImport") || "开始新导入"}
              </Button>
            </div>
          );
        }

        // 未写入：数据总览 + "确认写入"
        const stats = [
          { label: "分集", value: String(episodes.length) },
          { label: "角色", value: `${characters.length}（主 ${mainCount} / 配 ${guestCount}）` },
          { label: "关系", value: String(relationships.length) },
          { label: "视觉阶段", value: String(totalPhases) },
        ];
        return (
          <div className="mx-auto mt-8 max-w-lg space-y-4">
            <h3 className="font-display text-lg font-bold text-[--text-primary]">导入数据总览</h3>
            <p className="text-sm text-[--text-muted]">
              重新导入为「只追加、不清理」：确认后将写入数据库；多出的角色卡可在「角色管理」中手动删减。
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label} className="rounded-xl border border-[--border-subtle] bg-white p-3 text-center">
                  <div className="text-xl font-bold text-[--text-primary]">{s.value}</div>
                  <div className="mt-1 text-xs text-[--text-muted]">{s.label}</div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <Button
                onClick={async () => {
                  if (!textGuard()) return;
                  setPipelineActive(true);
                  setStepStatus((prev) => ({ ...prev, 6: "running" }));
                  await runGenerate(true);
                  setPipelineActive(false);
                }}
                disabled={pipelineActive}
                className="rounded-xl"
              >
                <Check className="mr-1.5 h-3.5 w-3.5" />
                确认写入
              </Button>
              {pipelineActive && <span className="text-xs text-[--text-muted]">正在写入...</span>}
            </div>
          </div>
        );
      }

      default:
        return null;
    }
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* Left: Steps sidebar */}
      <div className="flex w-56 shrink-0 flex-col border-r border-[--border-subtle] bg-white p-4">
        <button
          onClick={() => router.push(`/${locale}/project/${projectId}/episodes`)}
          className="mb-6 flex items-center gap-2 text-sm text-[--text-muted] hover:text-primary transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("backToEpisodes")}
        </button>

        <h2 className="mb-4 font-display text-lg font-bold text-[--text-primary]">
          {t("title")}
        </h2>

        <div className="flex flex-col gap-2">
          {STEPS.map(({ num, icon: Icon, label }) => {
            // Completed steps are always clickable (not limited to historyMode).
            // Current active step is highlighted.
            const isClickable = stepStatus[num] !== "idle";
            const isSelected = selectedStep === num;
            const isCurrent = currentStep === num && !historyMode;
            return (
              <button
                key={num}
                disabled={!isClickable}
                onClick={() => {
                  if (!isClickable) return;
                  setSelectedStep(isSelected ? null : num);
                }}
                className={`relative flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all duration-200 ${
                  stepColor(stepStatus[num], isSelected || isCurrent)
                } ${isClickable ? "cursor-pointer hover:bg-primary/5" : ""}`}
              >
                {/* Left accent bar for selected or current */}
                {(isSelected || isCurrent) && (
                  <div className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                )}
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                  stepStatus[num] === "done"
                    ? isSelected || isCurrent ? "bg-primary/15 text-primary" : "bg-emerald-100 text-emerald-600"
                    : stepStatus[num] === "running" ? "bg-primary/15"
                    : stepStatus[num] === "error" ? "bg-red-100"
                    : "bg-white"
                }`}>
                  {stepIcon(stepStatus[num]) || <Icon className="h-4 w-4" />}
                </div>
                <span className="text-sm font-medium">
                  {t(label)}
                  {staleSteps.has(num) && (
                    <span className="ml-1 text-[10px] text-amber-500">{t("staleFlag") || "需重新执行"}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {/* Model selector for text LLM steps (2/3/4/5) */}
        <div className="mt-4 border-t border-[--border-subtle] pt-3">
          <InlineModelPicker capability="text" />
        </div>
      </div>

      {/* Middle: Content area */}
      <div className="flex flex-1 flex-col overflow-y-auto bg-[--surface] p-6">
        {loadingHistory ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-[--text-muted]">加载导入记录...</p>
          </div>
        ) : (
          renderStepContent()
        )}
      </div>

      {/* Right: Log panel (always visible when pipeline started or history mode) */}
      {(currentStep > 0 || historyMode) && (
        <div className="flex w-72 shrink-0 flex-col border-l border-[--border-subtle] bg-white overflow-y-auto">
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-sm font-semibold text-[--text-secondary]">
                {t("processLog")}
                {selectedStep && (
                  <span className="ml-2 text-xs font-normal text-[--text-muted]">
                    — {t(STEPS[selectedStep - 1].label)}
                  </span>
                )}
              </h3>
              {selectedStep && (
                <button
                  onClick={() => setSelectedStep(null)}
                  className="text-xs text-primary hover:underline"
                >
                  {t("showAll")}
                </button>
              )}
            </div>

            <div className="rounded-xl border border-[--border-subtle] bg-white p-3">
              <div className="max-h-[calc(100vh-12rem)] space-y-1.5 overflow-y-auto font-mono text-xs">
                {(selectedStep ? logs.filter(l => l.step === selectedStep) : logs).map((log, idx) => (
                  <div key={idx} className="flex items-start gap-2">
                    <span
                      className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                        log.status === "done"
                          ? "bg-emerald-500"
                          : log.status === "error"
                            ? "bg-red-500"
                            : "bg-amber-400"
                      }`}
                    />
                    {!selectedStep && (
                      <span className="shrink-0 text-[--text-muted]">[Step {log.step}]</span>
                    )}
                    <span className={log.status === "error" ? "text-red-500" : "text-[--text-primary]"}>
                      {log.message}
                    </span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>

            {/* Per-step retry buttons when a step has failed */}
            {([1, 2, 3, 4, 5, 6] as Step[]).some((s) => stepStatus[s] === "error") && !historyMode && (
              <div className="flex flex-wrap gap-2 mt-3">
                {([1, 2, 3, 4, 5, 6] as Step[]).map((s) => {
                  if (stepStatus[s] !== "error") return null;
                  const labelMap: Record<Step, string> = {
                    1: "重试解析", 2: "重试评估", 3: "重试提取",
                    4: "重试分集", 5: "重试弧光", 6: "重试生成",
                  };
                  const handlerMap: Record<Step, () => void> = {
                    1: retryParse, 2: retryAssess, 3: retryCharacterExtract,
                    4: runSplit, 5: runArc, 6: () => runGenerate(false),
                  };
                  return (
                    <Button key={s} variant="outline" size="sm" onClick={handlerMap[s]}>
                      <AlertCircle className="mr-1.5 h-3.5 w-3.5" />
                      {labelMap[s]}
                    </Button>
                  );
                })}
              </div>
            )}

            {historyMode && (
              <div className="flex gap-2 mt-3 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setHistoryMode(false);
                    setSelectedStep(null);
                    resetPipeline();
                  }}
                >
                  {t("newImport")}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

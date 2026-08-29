"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/stores/project-store";
import { useModelStore } from "@/stores/model-store";
import { useTranslations } from "next-intl";
import { Sparkles, Loader2, FileText, Lightbulb, ListOrdered } from "lucide-react";
import { InlineModelPicker } from "@/components/editor/model-selector";
import { AgentPicker } from "@/components/agent-picker";
import { apiFetch } from "@/lib/api-fetch";
import { useModelGuard } from "@/hooks/use-model-guard";
import { PromptEditButton } from "@/components/prompt-templates/prompt-edit-button";
import { toast } from "sonner";

export function ScriptEditor() {
  const t = useTranslations();
  const { project, updateIdea, updateScript, fetchProject } = useProjectStore();
  const getModelConfig = useModelStore((s) => s.getModelConfig);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generatingOutline, setGeneratingOutline] = useState(false);
  const [outline, setOutline] = useState(project?.outline || "");
  const [targetDur, setTargetDur] = useState<number>(project?.targetDuration ?? 0);
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<{ sceneCount: number; dialogueCount: number; scenes: any[] } | null>(null);
  const [parseExpanded, setParseExpanded] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const textGuard = useModelGuard("text");
  const scriptTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Compute parse result from stored screenplay on mount.
  // CRITICAL: when the current episode has no stored screenplay (e.g. only
  // the outline is done, no generated script yet), the previous episode's
  // parse result must be cleared — otherwise stale "剧本结构化" output from
  // EP01/EP02 leaks into EP03's page after client-side navigation.
  useEffect(() => {
    if (project?.screenplay) {
      try {
        const s = JSON.parse(project.screenplay);
        const scenes = s.scenes || [];
        setParseResult({
          sceneCount: scenes.length,
          dialogueCount: scenes.reduce((n: number, x: any) => n + (x.dialogues?.length || 0), 0),
          scenes,
        });
      } catch { setParseResult(null); }
    } else {
      setParseResult(null);
    }
  }, [project?.screenplay]);

  // Sync outline from project when project data changes
  useEffect(() => {
    if (project?.outline !== undefined) {
      setOutline(project.outline || "");
    }
  }, [project?.outline]);

  useEffect(() => {
    if (generating && scriptTextareaRef.current) {
      const el = scriptTextareaRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [project?.script, generating]);

  // Auto-save: debounced (1.5s after last keystroke) + onBlur fallback
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  const persistNow = useCallback(async () => {
    const state = useProjectStore.getState();
    const proj = state.project;
    if (!proj || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const episodeId = state.currentEpisodeId;
    const url = episodeId
      ? `/api/projects/${proj.id}/episodes/${episodeId}`
      : `/api/projects/${proj.id}`;
    try {
      await apiFetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea: proj.idea, script: proj.script, outline: proj.outline }),
      });
    } catch (err) {
      console.error("Auto-save error:", err);
    }
    savingRef.current = false;
    setSaving(false);
  }, []);

  const scheduleSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      persistNow();
    }, 1500);
  }, [persistNow]);

  // 目标时长（集级）：与 store 同步 + 防抖持久化到 episodes.target_duration
  const targetDurRef = useRef(targetDur);
  useEffect(() => {
    targetDurRef.current = targetDur;
  }, [targetDur]);
  useEffect(() => {
    if (project?.targetDuration !== undefined) {
      setTargetDur(project.targetDuration || 0);
    }
  }, [project?.targetDuration]);
  const targetDurDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistTargetDur = useCallback(async () => {
    const state = useProjectStore.getState();
    const proj = state.project;
    const episodeId = state.currentEpisodeId;
    if (!proj || !episodeId) return;
    try {
      await apiFetch(`/api/projects/${proj.id}/episodes/${episodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetDuration: targetDurRef.current || 0 }),
      });
    } catch (err) {
      console.error("Target duration save error:", err);
    }
  }, []);
  const scheduleTargetDurSave = useCallback(() => {
    if (targetDurDebounceRef.current) clearTimeout(targetDurDebounceRef.current);
    targetDurDebounceRef.current = setTimeout(() => {
      persistTargetDur();
    }, 1500);
  }, [persistTargetDur]);

  // Clean up debounce on unmount and flush pending save
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        persistNow();
      }
    };
  }, [persistNow]);

  if (!project) return null;

  function handleSave() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    persistNow();
  }

  async function handleGenerateOutline() {
    if (!project) return;
    if (!textGuard()) return;
    setGeneratingOutline(true);
    setOutline("");

    try {
      const currentEpisodeId = useProjectStore.getState().currentEpisodeId;
      const resp = await apiFetch(`/api/projects/${project.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "script_outline",
          payload: { idea: project.idea || "" },
          modelConfig: getModelConfig(),
          episodeId: currentEpisodeId,
        }),
      });
      if (!resp.ok) throw new Error("Failed to generate outline");

      // Stream response
      if (resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullText += decoder.decode(value, { stream: true });
          setOutline(fullText);
        }

        // Update store so it persists
        useProjectStore.setState((state) => ({
          project: state.project ? { ...state.project, outline: fullText } : null,
        }));
      }

      await fetchProject(project.id, currentEpisodeId ?? undefined);
    } catch (err) {
      console.error("Outline generate error:", err);
      toast.error(t("common.generationFailed"));
    } finally {
      setGeneratingOutline(false);
    }
  }

  function handleOutlineChange(value: string) {
    setOutline(value);
    // Update project store so auto-save picks it up
    useProjectStore.setState((state) => ({
      project: state.project ? { ...state.project, outline: value } : null,
    }));
    scheduleSave();
  }

  async function runParse() {
    if (!project) return;
    const currentEpisodeId = useProjectStore.getState().currentEpisodeId;
    if (!currentEpisodeId) return;
    setParsing(true);
    setParseResult(null);
    try {
      const resp = await apiFetch(`/api/projects/${project.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "script_parse",
          modelConfig: getModelConfig(),
          episodeId: currentEpisodeId,
        }),
      });
      if (resp.ok && resp.body) {
        const r = resp.body.getReader();
        const d = new TextDecoder();
        let t = "";
        while (true) { const { done, value } = await r.read(); if (done) break; t += d.decode(value, { stream: true }); }
        try {
          const p = JSON.parse(t.trim());
          const scenes = p.scenes || [];
          setParseResult({ sceneCount: scenes.length, dialogueCount: scenes.reduce((s: number, x: any) => s + (x.dialogues?.length || 0), 0), scenes });
        } catch { setParseResult({ sceneCount: 0, dialogueCount: 0, scenes: [] }); }
      }
    } catch { /* silent */ }
    setParsing(false);
  }

  async function handleGenerateScript() {
    if (!project) return;
    if (!textGuard()) return;
    setGenerating(true);

    const idea = project.idea || "";
    const currentEpisodeId = useProjectStore.getState().currentEpisodeId;
    let currentOutline = outline;

    try {
      // Step 1: Auto-generate outline if empty (streaming)
      if (!currentOutline.trim()) {
        setGeneratingOutline(true);
        toast.info(t("project.generatingOutlineFirst") || "Generating outline first...");

        const outlineResp = await apiFetch(`/api/projects/${project.id}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "script_outline",
            payload: { idea },
            modelConfig: getModelConfig(),
            episodeId: currentEpisodeId,
          }),
        });

        if (outlineResp.ok && outlineResp.body) {
          const reader = outlineResp.body.getReader();
          const decoder = new TextDecoder();
          let fullOutline = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullOutline += decoder.decode(value, { stream: true });
            setOutline(fullOutline);
          }

          currentOutline = fullOutline;
          useProjectStore.setState((state) => ({
            project: state.project ? { ...state.project, outline: fullOutline } : null,
          }));
        }
        setGeneratingOutline(false);
      }

      // Step 2: Generate script (with outline if available)
      updateScript("");

      const response = await apiFetch(`/api/projects/${project.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "script_generate",
          payload: { idea, outline: currentOutline || undefined },
          modelConfig: getModelConfig(),
          episodeId: currentEpisodeId,
        }),
      });

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullText += decoder.decode(value, { stream: true });
          updateScript(fullText);
        }
      }

      await fetchProject(project.id, currentEpisodeId ?? undefined);

      // 质量闸（不阻塞）：时长设置提示 + 声音密度 80% 基线检查
      const fresh = useProjectStore.getState().project;
      const scriptText = fresh?.script || "";
      const dur = fresh?.targetDuration ?? 0;
      if (dur === 0) {
        toast.info(t("project.noTargetDuration") || "未设置目标时长，本次按自由发挥规划");
      }
      if (scriptText) {
        const parts = scriptText.split(/^(?=场景\s*\d+)/m);
        let totalScenes = 0;
        let voicedScenes = 0;
        for (let i = 1; i < parts.length; i++) {
          totalScenes++;
          const p = parts[i];
          const hasDialogue = /"[^"]*"/.test(p) || /“[^”]*”/.test(p);
          const hasNarration = /^旁白[：:]/m.test(p);
          const hasInner = /（内心）/.test(p);
          if (hasDialogue || hasNarration || hasInner) voicedScenes++;
        }
        if (totalScenes > 0 && voicedScenes / totalScenes < 0.8) {
          toast.warning(
            `声音密度 ${Math.round((voicedScenes / totalScenes) * 100)}% 低于 80% 基线：部分镜头缺少对白/旁白/内心戏，建议重新生成以补全声音层`
          );
        }
      }
    } catch (err) {
      console.error("Script generate error:", err);
      toast.error(t("common.generationFailed"));
    }

    setGeneratingOutline(false);
    setGenerating(false);
  }

  return (
    <div className="animate-page-in space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/8">
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <h2 className="font-display text-xl font-bold tracking-tight text-[--text-primary]">
            {t("project.script")}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-[--text-muted]">
            {t("project.targetDuration") || "目标时长（秒）"}
            <input
              type="number"
              min={0}
              value={targetDur}
              onChange={(e) => {
                const raw = e.target.value;
                const num = raw === "" ? 0 : Math.max(0, parseInt(raw, 10) || 0);
                setTargetDur(num);
                useProjectStore.setState((state) => ({
                  project: state.project ? { ...state.project, targetDuration: num } : null,
                }));
                scheduleTargetDurSave();
              }}
              className="w-16 rounded-lg border border-[--border-subtle] bg-[--surface] px-2 py-1 text-xs text-[--text-primary] focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>
          <PromptEditButton promptKeys={["script_outline", "script_generate", "script_parse"]} projectId={project.id} />
          <InlineModelPicker capability="text" />
          {saving && (
            <span className="flex items-center gap-1.5 text-xs text-[--text-muted]">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("common.saving")}
            </span>
          )}
        </div>
      </div>

      {/* Idea input */}
      <div className="rounded-2xl border border-[--border-subtle] bg-white p-1.5">
        <div className="flex items-center gap-2 px-5 pt-3 pb-1">
          <Lightbulb className="h-3.5 w-3.5 text-amber-500" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[--text-muted]">
            {t("project.idea")}
          </span>
        </div>
        <Textarea
          value={project.idea}
          onChange={(e) => { updateIdea(e.target.value); scheduleSave(); }}
          onBlur={handleSave}
          placeholder={t("project.scriptIdeaPlaceholder")}
          rows={4}
          disabled={generating}
          className={`h-[30vh] resize-none overflow-y-auto rounded-xl border-0 bg-transparent px-5 pb-4 font-mono text-sm leading-relaxed placeholder:text-[--text-muted] focus-visible:ring-0 ${
            generating ? "opacity-40" : ""
          }`}
        />
      </div>

      {/* Outline + Generated script — side by side, fixed height */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Outline section */}
        <div className="flex flex-col rounded-2xl border border-[--border-subtle] bg-white p-1.5">
          <div className="flex items-center justify-between px-5 pt-3 pb-1">
            <div className="flex items-center gap-2">
              <ListOrdered className="h-3.5 w-3.5 text-violet-500" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[--text-muted]">
                {t("project.outline")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <AgentPicker projectId={project.id} category="script_outline" />
              <Button
                size="sm"
                onClick={handleGenerateOutline}
                disabled={generatingOutline || generating || !project.idea?.trim()}
              >
                {generatingOutline ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {generatingOutline ? t("common.generating") : t("project.generateOutline")}
              </Button>
            </div>
          </div>

          <Textarea
            value={outline}
            onChange={(e) => handleOutlineChange(e.target.value)}
            onBlur={handleSave}
            placeholder={t("project.outlinePlaceholder")}
            disabled={generatingOutline}
            className={`h-[55vh] max-h-[55vh] resize-none overflow-y-auto rounded-xl border-0 bg-transparent px-5 pb-4 font-mono text-sm leading-relaxed placeholder:text-[--text-muted] focus-visible:ring-0 ${
              generatingOutline ? "opacity-40" : ""
            }`}
          />
        </div>

        {/* Generated script */}
        <div className="flex flex-col rounded-2xl border border-[--border-subtle] bg-white p-1.5">
          <div className="flex items-center justify-between px-5 pt-3 pb-1">
            <div className="flex items-center gap-2">
              <FileText className="h-3.5 w-3.5 text-primary" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[--text-muted]">
                {t("project.generatedScript")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <AgentPicker projectId={project.id} category="script_generate" />
              <Button
                size="sm"
                onClick={handleGenerateScript}
                disabled={generating || generatingOutline || !project.idea?.trim()}
              >
                {generating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {generating ? t("common.generating") : t("project.generateScript")}
              </Button>
            </div>
          </div>
          {project.script ? (
            <Textarea
              ref={scriptTextareaRef}
              value={project.script}
              onChange={(e) => { updateScript(e.target.value); if (!generating) scheduleSave(); }}
              onBlur={() => { if (!generating) handleSave(); }}
              disabled={generating}
              className={`h-[55vh] max-h-[55vh] resize-none overflow-y-auto rounded-xl border-0 bg-transparent px-5 pb-4 font-mono text-sm leading-relaxed placeholder:text-[--text-muted] focus-visible:ring-0 ${
                generating ? "opacity-40" : ""
              }`}
            />
          ) : (
            <div className="h-[55vh] max-h-[55vh] overflow-y-auto px-5 pb-4 pt-2 text-sm text-[--text-muted]">
              {t("project.scriptPlaceholder") || "点击上方按钮生成剧本..."}
            </div>
          )}
        </div>
      </div>

      {/* Screenplay parse panel */}
      <div className="rounded-2xl border border-[--border-subtle] bg-white p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-base">📊</span>
            <span className="text-sm font-medium text-[--text-primary]">
              {t("project.structuredParse")}
            </span>
          </div>
          <Button
            size="sm"
            onClick={runParse}
            disabled={parsing || !project?.script?.trim()}
          >
            {parsing ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                {t("common.generating")}
              </>
            ) : (
              <>
                <Sparkles className="mr-1 h-3.5 w-3.5" />
                {t("project.parse")}
              </>
            )}
          </Button>
        </div>
        {parseResult && !parsing && (
          <>
            <div className="mt-2 flex items-center gap-3 text-sm text-[--text-muted]">
              <span>📋 {t("project.sceneCount", { count: parseResult.sceneCount })}</span>
              <span>💬 {t("project.dialogueCount", { count: parseResult.dialogueCount })}</span>
            </div>
            {/* Scene list */}
            <div className="mt-3 space-y-2">
              {parseResult.scenes.slice(0, parseExpanded ? parseResult.scenes.length : 1).map((scene: any, i: number) => (
                <div key={i} className="rounded-xl border border-[--border-subtle] bg-[--surface] p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      {t("project.sceneLabel", { index: i + 1 })}
                    </span>
                    {scene.sceneTitle && (
                      <span className="text-sm font-medium text-[--text-primary]">{scene.sceneTitle}</span>
                    )}
                  </div>
                  {scene.sceneDescription && (
                    <p className="mt-1 text-xs leading-relaxed text-[--text-muted]">{scene.sceneDescription.slice(0, 120)}{scene.sceneDescription.length > 120 ? "..." : ""}</p>
                  )}
                  {scene.dialogues?.length > 0 && (
                    <div className="mt-2 space-y-0.5">
                      {scene.dialogues.slice(0, 2).map((d: any, j: number) => (
                        <p key={j} className="text-xs text-[--text-muted]">
                          <span className="font-medium text-[--text-secondary]">{d.character}:</span> {d.text.slice(0, 60)}{d.text.length > 60 ? "..." : ""}
                        </p>
                      ))}
                      {scene.dialogues.length > 2 && (
                        <p className="text-[10px] text-[--text-muted]">... {scene.dialogues.length - 2} 句</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {/* Controls */}
            {parseResult.scenes.length > 1 && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => setParseExpanded(!parseExpanded)}
                  className="text-xs text-primary hover:underline"
                >
                  {parseExpanded ? t("project.collapse") : t("project.expandAll", { count: parseResult.scenes.length })}
                </button>
                <button
                  onClick={() => setShowRawJson(!showRawJson)}
                  className="text-xs text-[--text-muted] hover:text-[--text-secondary]"
                >
                  {showRawJson ? t("project.hideRaw") : t("project.showRaw")}
                </button>
              </div>
            )}
            {/* Raw JSON */}
            {showRawJson && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-[--surface] p-3 text-[10px] leading-relaxed text-[--text-muted]">
                {JSON.stringify(parseResult.scenes, null, 2)}
              </pre>
            )}
          </>
        )}
        {!parseResult && !parsing && (
          <p className="mt-2 text-xs text-[--text-muted]">
            {t("project.parseHint")}
          </p>
        )}
      </div>
    </div>
  );
}

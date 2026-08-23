"use client";

import { useEffect, useState, useMemo, useCallback, use } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { CharacterCard } from "@/components/editor/character-card";
import { CharacterRelations } from "@/components/editor/character-relations";
import { InlineModelPicker } from "@/components/editor/model-selector";
import { useModelStore } from "@/stores/model-store";
import { useModelGuard } from "@/hooks/use-model-guard";
import Link from "next/link";
import { toast } from "sonner";

interface Character {
  id: string;
  projectId: string;
  name: string;
  baseName: string;
  description: string;
  visualHint: string | null;
  referenceImage: string | null;
  referenceImageHistory: string | null;
  scope: string;
  episodeId: string | null;
  phaseName: string | null;
  episodeSequences: string | null;
  visualChanges: string | null;
  t2iStructure: string | null;
  r2iStructure: string | null;
  createdAt: number;
}

interface Episode {
  id: string;
  title: string;
  sequence: number;
}

export default function CharactersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  const locale = useLocale();
  const t = useTranslations();
  const tc = useTranslations("common");
  const tChar = useTranslations("character");

  const [characters, setCharacters] = useState<Character[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [activeTab, setActiveTab] = useState<"template" | "phase" | "episodes">(() => {
    const saved = (typeof sessionStorage !== "undefined" ? sessionStorage.getItem("characters_activeTab") : null) as
      | "template"
      | "phase"
      | "episodes"
      | null;
    return saved && ["template", "phase", "episodes"].includes(saved) ? saved : "template";
  });

  const getModelConfig = useModelStore((s) => s.getModelConfig);
  const textGuard = useModelGuard("text");

  const fetchData = useCallback(async () => {
    const [chars, eps] = await Promise.all([
      apiFetch(`/api/projects/${projectId}/characters`).then((r) => r.json()),
      apiFetch(`/api/projects/${projectId}/episodes`).then((r) => r.json()),
    ]);
    setCharacters(chars);
    setEpisodes(eps);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Persist the active tab so a page refresh keeps the current tab (visual phase / EP roles, etc.)
  useEffect(() => {
    try {
      sessionStorage.setItem("characters_activeTab", activeTab);
    } catch {
      // sessionStorage unavailable (private mode, etc.) — ignore
    }
  }, [activeTab]);

  const templateChars = useMemo(
    () => characters.filter((c) => !c.episodeId && !c.phaseName && (c.scope === "main" || c.scope === "guest")),
    [characters]
  );

  const phaseChars = useMemo(
    () => characters.filter((c) => !c.episodeId && c.phaseName),
    [characters]
  );

  // Compute Phase count per baseName for display in Template tab
  const phaseCountByBaseName = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of phaseChars) {
      if (c.baseName) {
        map[c.baseName] = (map[c.baseName] || 0) + 1;
      }
    }
    return map;
  }, [phaseChars]);

  // Group phase chars by baseName
  const phaseByBaseName = useMemo(() => {
    const map = new Map<string, Character[]>();
    for (const c of phaseChars) {
      const key = c.baseName || c.name;
      const list = map.get(key) || [];
      list.push(c);
      map.set(key, list);
    }
    return map;
  }, [phaseChars]);

  const guestChars = useMemo(
    () => characters.filter((c) => c.scope === "support"),
    [characters]
  );

  const guestByEpisode = useMemo(() => {
    const map = new Map<string, Character[]>();
    const orphans: Character[] = [];
    for (const c of guestChars) {
      if (c.episodeId) {
        const list = map.get(c.episodeId) || [];
        list.push(c);
        map.set(c.episodeId, list);
      } else {
        orphans.push(c);
      }
    }
    if (orphans.length > 0) map.set("__orphans__", orphans);
    return map;
  }, [guestChars]);

  const episodeNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const ep of episodes) {
      map.set(ep.id, ep.title);
    }
    return map;
  }, [episodes]);

  async function handleExtract() {
    if (!textGuard()) return;
    setExtracting(true);
    try {
      await apiFetch(`/api/projects/${projectId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "character_extract",
          modelConfig: getModelConfig(),
        }),
      });
      toast.success("角色提取完成");
    } catch (err) {
      toast.error(tc("generationFailed"));
    }
    setExtracting(false);
    fetchData();
  }

  async function handleDelete(characterId: string, name: string) {
    if (!confirm(tChar("deleteConfirm", { name }))) return;
    await apiFetch(`/api/projects/${projectId}/characters/${characterId}`, {
      method: "DELETE",
    });
    toast.success(tc("delete"));
    fetchData();
  }


  const [reextracting, setReextracting] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [batchGenerating, setBatchGenerating] = useState(false);

  async function handleReextract() {
    if (!textGuard()) return;
    setReextracting(true);
    try {
      await apiFetch(`/api/projects/${projectId}/characters/reextract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelConfig: getModelConfig(), language: locale }),
      });
      toast.success("角色定义更新完成");
    } catch {
      toast.error("角色定义更新失败");
    }
    setReextracting(false);
    fetchData();
  }

  async function handleEnrichPhases() {
    if (!textGuard()) return;
    setEnriching(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/characters/enrich-phases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelConfig: getModelConfig(), language: locale }),
      });
      const data = await res.json();
      const updated = data.updated ?? 0;
      const failures: string[] = data.failures ?? [];
      toast.success(
        failures.length > 0
          ? `角色视觉更新完成：${updated} 个阶段已更新，${failures.length} 个角色失败（${failures.join("、")}）`
          : `角色视觉更新完成：${updated} 个阶段已更新`
      );
    } catch {
      toast.error("角色视觉更新失败");
    }
    setEnriching(false);
    fetchData();
  }

  async function handleBatchGen(type: string) {
    if (!textGuard()) return;
    setBatchGenerating(true);
    try {
      await apiFetch(`/api/projects/${projectId}/characters/batch-generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, modelConfig: getModelConfig(), language: locale }),
      });
      toast.success("批量生成完成");
    } catch {
      toast.error("批量生成失败");
    }
    setBatchGenerating(false);
  }

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm text-[--text-muted]">{tc("loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[--surface] p-6 pb-24 lg:pb-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href={`/${locale}/project/${projectId}/episodes`}
            className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/8 transition-colors hover:bg-primary/15"
          >
            <ArrowLeft className="h-5 w-5 text-primary" />
          </Link>
          <div>
            <h2 className="font-display text-xl font-bold tracking-tight text-[--text-primary]">
              {tChar("management")}
            </h2>
            <p className="text-xs text-[--text-muted]">
              {characters.length} {t("episode.count")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <InlineModelPicker capability="text" />
        </div>
      </div>

      {/* Tab Bar */}
      <div className="mb-6 flex gap-1 rounded-xl bg-[--surface-alt] p-1 w-fit">
        {(["template", "phase", "episodes"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-all ${
              activeTab === tab
                ? "bg-white shadow-sm text-[--text-primary]"
                : "text-[--text-muted] hover:text-[--text-secondary]"
            }`}
          >
            {tab === "template" ? "角色定义" : tab === "phase" ? "视觉阶段" : "EP 角色"}
          </button>
        ))}
      </div>

      {/* Template Characters (角色定义) */}
      {activeTab === "template" && (
        <>
          <section className="mb-8">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="font-display text-lg font-semibold text-[--text-primary]">
                  {tChar("mainSection")}
                </h3>
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-100 px-1.5 text-[11px] font-semibold text-blue-700">
                  {templateChars.length}
                </span>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleReextract} disabled={reextracting} className="rounded-lg text-xs h-8">
                  {reextracting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                  更新角色定义
                </Button>
                <Button onClick={() => handleBatchGen("t2i_prompt")} disabled={batchGenerating} className="rounded-lg text-xs h-8">
                  提示词批量生成
                </Button>
                <Button onClick={() => handleBatchGen("t2i_image")} disabled={batchGenerating} className="rounded-lg text-xs h-8">
                  参考图批量生成
                </Button>
              </div>
            </div>
            {templateChars.length === 0 ? (
              <div className="flex min-h-[120px] items-center justify-center rounded-2xl border border-dashed border-[--border-subtle] bg-white/50 p-6">
                <p className="text-sm text-[--text-muted]">{tChar("noMain")}</p>
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 xl:grid-cols-4">
                {templateChars.map((char) => (
                  <div key={char.id} className="space-y-1">
                    <CharacterCard
                      id={char.id}
                      projectId={projectId}
                      name={char.name}
                      description={char.description}
                      visualHint={char.visualHint}
                      t2iStructure={char.t2iStructure}
                      referenceImage={char.referenceImage}
                      referenceImageHistory={char.referenceImageHistory}
                      scope={char.scope}
                      onUpdate={fetchData}
                      onDelete={() => handleDelete(char.id, char.name)}
                    />
                    {phaseCountByBaseName[char.baseName] > 0 && (
                      <p className="text-xs text-muted-foreground text-center">
                        {phaseCountByBaseName[char.baseName]} 个视觉阶段
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Character Relations */}
          {characters.length >= 2 && (
            <section className="mb-8">
              <CharacterRelations
                projectId={projectId}
                characters={characters.map((c) => ({ id: c.id, name: c.name }))}
              />
            </section>
          )}
        </>
      )}

      {/* Phase Characters (视觉阶段) */}
      {activeTab === "phase" && (
        <section className="mb-8">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="font-display text-lg font-semibold text-[--text-primary]">
                视觉阶段
              </h3>
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-100 px-1.5 text-[11px] font-semibold text-indigo-700">
                {phaseChars.length}
              </span>
            </div>
            <div className="flex gap-2">
              <Button onClick={handleEnrichPhases} disabled={enriching} className="rounded-lg text-xs h-8">
                {enriching ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                更新角色视觉
              </Button>
              <Button onClick={() => handleBatchGen("r2i_prompt")} disabled={batchGenerating} className="rounded-lg text-xs h-8">
                提示词批量生成
              </Button>
              <Button onClick={() => handleBatchGen("r2i_image")} disabled={batchGenerating} className="rounded-lg text-xs h-8">
                参考图批量生成
              </Button>
            </div>
          </div>
          {phaseChars.length === 0 ? (
            <div className="flex min-h-[120px] items-center justify-center rounded-2xl border border-dashed border-[--border-subtle] bg-white/50 p-6">
              <p className="text-sm text-[--text-muted]">暂无视觉阶段数据</p>
            </div>
          ) : (
            <div className="space-y-6">
              {Array.from(phaseByBaseName.entries()).map(([baseName, chars]) => (
                <div key={baseName}>
                  <h4 className="mb-3 text-sm font-medium text-[--text-secondary]">
                    {baseName}
                  </h4>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 xl:grid-cols-4">
                    {chars.map((char) => (
                      <CharacterCard
                        key={char.id}
                        id={char.id}
                        projectId={projectId}
                        name={char.name}
                        baseName={char.baseName}
                        description={char.description}
                        visualHint={char.visualHint}
                        t2iStructure={char.t2iStructure}
                        r2iStructure={char.r2iStructure}
                        referenceImage={char.referenceImage}
                        referenceImageHistory={char.referenceImageHistory}
                        scope={char.scope}
                        phaseName={char.phaseName}
                        episodeSequences={char.episodeSequences}
                        visualChanges={char.visualChanges}
                        createdAt={char.createdAt}
                        onUpdate={fetchData}
                        onDelete={() => handleDelete(char.id, char.name)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Episodes Characters (EP 角色) */}
      {activeTab === "episodes" && (
        <section>
          <div className="mb-4 flex items-center gap-2">
            <h3 className="font-display text-lg font-semibold text-[--text-primary]">
              {tChar("guestSection")}
            </h3>
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-purple-100 px-1.5 text-[11px] font-semibold text-purple-700">
              {guestChars.length}
            </span>
          </div>
          {guestChars.length === 0 ? (
            <div className="flex min-h-[120px] items-center justify-center rounded-2xl border border-dashed border-[--border-subtle] bg-white/50 p-6">
              <p className="text-sm text-[--text-muted]">{tChar("noGuest")}</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Orphan guest characters (no episode assignment) */}
              {guestByEpisode.has("__orphans__") && (
                <div>
                  <h4 className="mb-3 text-sm font-medium text-[--text-secondary]">{t("common.unassigned")}</h4>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 xl:grid-cols-4">
                    {guestByEpisode.get("__orphans__")!.map((char) => (
                      <CharacterCard
                        key={char.id}
                        id={char.id}
                        projectId={projectId}
                        name={char.name}
                        description={char.description}
                        visualHint={char.visualHint}
                        t2iStructure={char.t2iStructure}
                        referenceImage={char.referenceImage}
                        referenceImageHistory={char.referenceImageHistory}
                        scope={char.scope}
                        onUpdate={fetchData}
                        onDelete={() => handleDelete(char.id, char.name)}
                      />
                    ))}
                  </div>
                </div>
              )}
              {episodes
                .filter((ep) => guestByEpisode.has(ep.id))
                .map((ep) => (
                  <div key={ep.id}>
                    <h4 className="mb-3 text-sm font-medium text-[--text-secondary]">
                      EP.{String(ep.sequence).padStart(2, "0")} —{" "}
                      {episodeNameMap.get(ep.id)}
                    </h4>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 xl:grid-cols-4">
                      {guestByEpisode.get(ep.id)!.map((char) => (
                        <CharacterCard
                          key={char.id}
                          id={char.id}
                          projectId={projectId}
                          name={char.name}
                          description={char.description}
                          visualHint={char.visualHint}
                          t2iStructure={char.t2iStructure}
                          referenceImage={char.referenceImage}
                          referenceImageHistory={char.referenceImageHistory}
                          scope={char.scope}
                          episodeName={`EP.${String(ep.sequence).padStart(2, "0")} ${ep.title}`}
                          onUpdate={fetchData}
                          onDelete={() => handleDelete(char.id, char.name)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

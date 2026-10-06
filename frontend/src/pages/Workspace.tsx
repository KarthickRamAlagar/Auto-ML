import { Folder, Lock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { AskCard, type Opt } from "@/components/chat/AskCard";
import { ConfirmCard } from "@/components/chat/ConfirmCard";
import { DatasetCards } from "@/components/chat/DatasetCards";
import { EdaColumnsCard } from "@/components/chat/EdaColumnsCard";
import { AssistantMsg, Prose } from "@/components/chat/Message";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { PrepCard } from "@/components/chat/PrepCard";
import { RunBlock } from "@/components/chat/RunBlock";
import { SplitCard, type SplitChoice } from "@/components/chat/SplitCard";
import { TuningCard } from "@/components/chat/TuningCard";
import { AppShell } from "@/components/layout/AppShell";
import { ResetCountdown } from "@/components/layout/UsageMeter";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/progress";
import { api, ApiError } from "@/lib/api";
import { useChats } from "@/lib/chats";
import { chatPath, newChatPath, projectPath } from "@/lib/ids";
import { useMe } from "@/lib/me";
import { askNotifyPermission } from "@/lib/notify";
import { getPrefs } from "@/lib/prefs";
import { useSeo } from "@/lib/seo";
import type { Chat, DatasetSession, JobConfig, JobView, ModelInfo, ModelSpec, Preprocess, Task, Usage } from "@/lib/types";
import { useNavigate } from "react-router-dom";

interface Rerun {
  config: JobConfig;
  dataset: { name: string | null; ref: string | null; source: string };
  title: string;
  group_id: string | null;
}

const DOMAINS = ["Finance", "Healthcare", "E-commerce", "Real estate", "Education", "Manufacturing"];

interface Flow {
  task?: Task;
  domain?: string;
  session?: DatasetSession;
  target?: string;
  eda?: boolean;
  edaCols?: string[] | null;
  prep?: { p: Preprocess; summary: string };
  split?: { c: SplitChoice; summary: string };
  modelIds?: string[];
  specs?: { v: ModelSpec[]; summary: string };
  run?: { jobId: string; needsPayment: boolean };
}

const ORDER = ["task", "domain", "dataset", "target", "eda", "edaCols", "prep", "split", "models", "tune", "confirm", "run"] as const;
type Stage = (typeof ORDER)[number];

function currentStage(f: Flow): Stage {
  if (!f.task) return "task";
  if (!f.domain) return "domain";
  if (!f.session) return "dataset";
  if (!f.target) return "target";
  if (f.eda === undefined) return "eda";
  if (f.eda && f.edaCols === undefined) return "edaCols";
  if (!f.prep) return "prep";
  if (!f.split) return "split";
  if (!f.modelIds) return "models";
  if (!f.specs) return "tune";
  if (!f.run) return "confirm";
  return "run";
}

function TargetCard({ session, task, done, onPick }: { session: DatasetSession; task: Task; done?: boolean; onPick: (t: string) => void }) {
  const [t, setT] = useState(session.suggested_target);
  if (done) return null;
  const cols = session.profile.columns;
  const col = cols.find((c) => c.name === t);
  const warn = col && ((task === "regression" && col.kind !== "numeric") || (task === "classification" && col.kind === "numeric" && col.unique > 20));
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      <p className="font-serif text-[16px] font-medium">Which column should the model predict?</p>
      <p className="text-[13px] text-muted-foreground">
        {session.name}: {session.profile.rows.toLocaleString("en-IN")} rows, {session.profile.cols} columns. I picked <b>{session.suggested_target}</b> as the most likely target.
      </p>
      <Select value={t} onChange={(e) => setT(e.target.value)} aria-label="Target column">
        {cols.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} ({c.kind}, {c.unique} unique{c.name === session.suggested_target ? ", recommended" : ""})
          </option>
        ))}
      </Select>
      {warn && <p className="text-xs text-warning">This column looks {task === "regression" ? "non-numeric, which regression cannot predict" : "continuous, which suits regression better than classification"}.</p>}
      <div className="flex justify-end">
        <Button onClick={() => onPick(t)}>Continue</Button>
      </div>
    </div>
  );
}

/** Route entry: /auto-ml/chat/:chatId */
export default function Workspace() {
  const { chatId = "" } = useParams();
  return <ChatView key={chatId} chatId={chatId} />;
}

function ChatView({ chatId }: { chatId: string }) {
  useSeo({ title: "Chat · Auto ML", noindex: true });
  const [sp] = useSearchParams();
  const { chats, groups, refresh: refreshChats } = useChats();
  const projectParam = sp.get("project");
  const [boot, setBoot] = useState<"loading" | "new" | "existing" | "error">("loading");
  const [chat, setChat] = useState<Chat | null>(null);
  const [existingView, setExistingView] = useState<JobView | null>(null);
  const [bootErr, setBootErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<Chat>(`/api/chats/${chatId}`)
      .then(async (c) => {
        const v = await api.get<JobView>(`/api/jobs/${c.job_id}`).catch(() => null);
        if (!alive) return;
        setChat(c);
        setExistingView(v);
        setBoot("existing");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) setBoot("new");
        else {
          setBootErr((e as Error).message);
          setBoot("error");
        }
      });
    return () => {
      alive = false;
    };
  }, [chatId]);

  const group = projectParam ? groups.find((g) => g.id === projectParam) : undefined;
  const title = boot === "existing" ? chat?.title : group ? `New chat · ${group.name}` : "New chat";

  return (
    <AppShell title={title}>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-5 px-4 py-6">
          {boot === "loading" && (
            <div className="grid place-items-center py-20">
              <Spinner />
            </div>
          )}
          {boot === "error" && <p className="text-sm text-destructive">{bootErr}</p>}
          {boot === "existing" && chat && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>
                  {chat.dataset} · {chat.domain} · {chat.task}
                </span>
                {chat.group_id && groups.find((g) => g.id === chat.group_id) && (
                  <Link to={projectPath(chat.group_id)} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:bg-accent">
                    <Folder className="size-3" /> {groups.find((g) => g.id === chat.group_id)?.name}
                  </Link>
                )}
              </div>
              {existingView ? (
                <RunBlock jobId={chat.job_id} needsPayment={existingView.locks.needs_payment} onFinished={() => void refreshChats()} />
              ) : (
                <Unavailable chat={chat} />
              )}
              <p className="text-xs text-muted-foreground">
                Results, EDA and code stay saved{chat.expires_at ? ` until ${new Date(chat.expires_at * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : " for 15 days"}. Datasets are never stored, so a re-run needs the same dataset again.{" "}
                <Link to={newChatPath(chat.group_id ?? undefined)} className="text-primary underline">
                  Start a new chat
                </Link>
              </p>
            </div>
          )}
          {boot === "new" && <NewChat chatId={chatId} projectId={group?.id ?? null} chats={chats} />}
        </div>
      </div>
    </AppShell>
  );
}

function Unavailable({ chat }: { chat: Chat }) {
  const nav = useNavigate();
  const { deleteChat } = useChats();
  const [busy, setBusy] = useState(false);
  const interrupted = chat.status === "interrupted";
  return (
    <div className="space-y-3 rounded-xl border bg-card p-5 shadow-sm">
      <p className="font-serif text-[17px] font-medium">{interrupted ? "This run was interrupted" : "Results for this chat are no longer available"}</p>
      <p className="text-sm text-muted-foreground">
        {interrupted
          ? "The server restarted or the run took too long before it finished, so no results were saved. If you had reserved a model it has been given back."
          : "Saved results are kept for 15 days, and runs made before saving was introduced were never archived."}{" "}
        Your settings are saved, so you can repeat it by choosing the same dataset again.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => nav(`${newChatPath(chat.group_id ?? undefined)}${chat.group_id ? "&" : "?"}rerun=${chat.id}`)}>Re-run with same settings</Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm("Delete this chat?")) return;
            setBusy(true);
            try {
              await deleteChat(chat.id);
              nav(newChatPath(chat.group_id ?? undefined));
            } finally {
              setBusy(false);
            }
          }}
        >
          Delete chat
        </Button>
      </div>
    </div>
  );
}

function NewChat({ chatId, projectId, chats }: { chatId: string; projectId: string | null; chats: Chat[] }) {
  const nav = useNavigate();
  const { groups, refresh: refreshChats } = useChats();
  const { usage, refresh, setUsage } = useMe();
  const earlier = useMemo(() => (projectId ? chats.filter((c) => c.group_id === projectId) : []), [chats, projectId]);
  const group = groups.find((g) => g.id === projectId);
  const [flow, setFlow] = useState<Flow>(() => {
    const last = earlier[0];
    return last ? { task: last.task, domain: last.domain } : {};
  });
  const [ans, setAns] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    const last = earlier[0];
    if (last) {
      init.task = last.task === "classification" ? "Classification" : "Regression";
      init.domain = last.domain;
    }
    return init;
  });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sp] = useSearchParams();
  const rerunId = sp.get("rerun");
  const [rerun, setRerun] = useState<Rerun | null>(null);
  const [rerunErr, setRerunErr] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const stage = currentStage(flow);
  const reached = (s: Stage) => ORDER.indexOf(s) <= ORDER.indexOf(stage);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [stage]);

  useEffect(() => {
    if (!rerunId) return;
    let alive = true;
    api
      .get<Rerun>(`/api/chats/${rerunId}/rerun`)
      .then(async (r) => {
        if (!alive) return;
        setRerun(r);
        const m = await api.get<{ models: ModelInfo[] }>(`/api/models?task=${r.config.task}&domain=${encodeURIComponent(r.config.domain)}`).catch(() => null);
        if (alive && m) setModels(m.models);
        setFlow((f) => ({ ...f, task: r.config.task, domain: r.config.domain }));
        setAns((a) => ({ ...a, task: r.config.task === "classification" ? "Classification" : "Regression", domain: r.config.domain }));
      })
      .catch((e: Error) => alive && setRerunErr(e.message));
    return () => {
      alive = false;
    };
  }, [rerunId]);

  /** A dataset was chosen. When repeating a run, restore every other answer and jump to the confirm step. */
  const pickSession = (s: DatasetSession) => {
    const cfg = rerun?.config;
    if (!cfg) return set({ session: s }, "dataset", s.name);
    if (!s.profile.columns.some((c) => c.name === cfg.target)) {
      setRerunErr(`This dataset has no “${cfg.target}” column, so the saved settings can't be reused. Choose the same dataset as before.`);
      return;
    }
    setRerunErr(null);
    const cols = new Set(s.profile.columns.map((c) => c.name));
    const edaCols = cfg.eda_columns ? cfg.eda_columns.filter((c) => cols.has(c)) : null;
    const prep = { ...cfg.preprocess, drop_columns: (cfg.preprocess.drop_columns ?? []).filter((c) => cols.has(c)) };
    const split: SplitChoice = { split: cfg.split, test_size: cfg.test_size, time_column: cfg.time_column ?? null, cv_folds: cfg.cv_folds };
    const names = cfg.models.map((sp) => models.find((m) => m.id === sp.id)?.name ?? sp.id);
    setFlow({
      task: cfg.task,
      domain: cfg.domain,
      session: s,
      target: cfg.target,
      eda: cfg.eda,
      edaCols: cfg.eda ? edaCols : undefined,
      prep: { p: prep, summary: "Same as the earlier run" },
      split: { c: split, summary: `${cfg.split}, test ${Math.round(cfg.test_size * 100)}%, ${cfg.cv_folds}-fold CV` },
      modelIds: cfg.models.map((m) => m.id),
      specs: { v: cfg.models, summary: `${cfg.models.length} model(s), same settings as before` },
    });
    setAns((a) => ({ ...a, dataset: s.name, target: cfg.target, eda: cfg.eda ? "Yes" : "Skip", edaCols: edaCols ? `${edaCols.length} columns` : "all columns", prep: "Same as the earlier run", split: "Same as the earlier run", models: names.join(", "), tune: "Same as the earlier run" }));
  };

  const reloadSame = async () => {
    const d = rerun?.dataset;
    if (!d) return;
    setReloading(true);
    setRerunErr(null);
    try {
      const s = d.ref?.startsWith("http") ? await api.post<DatasetSession>("/api/datasets/from-url", { url: d.ref }) : await api.post<DatasetSession>("/api/datasets/select", { id: d.ref });
      pickSession(s);
    } catch (e) {
      setRerunErr((e as Error).message);
    } finally {
      setReloading(false);
    }
  };

  const set = useCallback((patch: Partial<Flow>, key?: string, text?: string) => {
    setFlow((f) => ({ ...f, ...patch }));
    if (key && text !== undefined) setAns((a) => ({ ...a, [key]: text }));
  }, []);

  const start = async (o: { videos: boolean; team: boolean }) => {
    const { task, domain, session, target, prep, split, specs } = flow;
    if (!task || !domain || !session || !target || !prep || !split || !specs) return;
    setStarting(true);
    setErr(null);
    void askNotifyPermission(); // the click is the user gesture browsers require
    const cfg: JobConfig = {
      dataset_id: session.dataset_id,
      task,
      domain,
      target,
      eda: flow.eda ?? getPrefs().eda,
      eda_columns: flow.eda ? flow.edaCols ?? null : null,
      preprocess: prep.p,
      split: split.c.split,
      test_size: split.c.test_size,
      time_column: split.c.time_column,
      cv_folds: split.c.cv_folds,
      models: specs.v,
      videos: o.videos,
      team: o.team,
    };
    const q = new URLSearchParams({ chat_id: chatId });
    if (group) q.set("group_id", group.id);
    try {
      const r = await api.post<{ job_id: string; needs_payment: boolean; usage: Usage }>(`/api/jobs?${q}`, cfg);
      setUsage(r.usage);
      setAns((a) => ({ ...a, confirm: "Allowed" }));
      setFlow((f) => ({ ...f, run: { jobId: r.job_id, needsPayment: r.needs_payment } }));
      void refreshChats();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
      void refresh();
    } finally {
      setStarting(false);
    }
  };

  const locked = !!usage && !usage.unlimited && usage.total_remaining <= 0 && !flow.run;
  const taskOpts: Opt[] = [
    { value: "classification", label: "Classification", hint: "Predict a category, such as default / no default.", recommended: true },
    { value: "regression", label: "Regression", hint: "Predict a number, such as a price or score." },
  ];
  const domainOpts: Opt[] = DOMAINS.map((d, i) => ({ value: d, label: d, recommended: i === 0, hint: i === 0 ? "Most datasets and the clearest examples." : undefined }));
  const edaOpts: Opt[] = [
    { value: "yes", label: "Yes, explore the data first", hint: "Distributions, missing values, correlations and a plain-English inference.", recommended: true },
    { value: "no", label: "Skip EDA", hint: "Go straight to modelling." },
  ];
  const confirmRows = [
    { label: "Task", value: `${flow.task ?? ""} · ${flow.domain ?? ""}` },
    { label: "Dataset", value: flow.session?.name ?? "" },
    { label: "Target", value: flow.target ?? "" },
    { label: "EDA", value: flow.eda ? (ans.edaCols ?? "all columns") : "skipped" },
    { label: "Preparation", value: flow.prep?.summary ?? "" },
    { label: "Split", value: flow.split?.summary ?? "" },
    { label: "Models", value: ans.models ?? "" },
    { label: "Tuning", value: flow.specs?.summary ?? "" },
    ...(group ? [{ label: "Project", value: group.name }] : []),
  ];

  if (locked)
    return (
      <div className="mx-auto mt-16 max-w-md space-y-3 rounded-2xl border bg-card p-8 text-center shadow-sm">
        <Lock className="mx-auto size-8 text-muted-foreground" />
        <h2 className="font-serif text-xl">You've used all your models for now</h2>
        <p className="text-sm text-muted-foreground">
          Your free and paid model runs are finished for this window. <ResetCountdown />
        </p>
      </div>
    );

  return (
    <>
      <div className="max-w-3xl space-y-5">
        <AssistantMsg>
          <Prose>
            <p>Hi! I'll help you train and compare machine learning models, step by step. Your data is used in memory only and is never stored.</p>
          </Prose>
        </AssistantMsg>

        {group && earlier.length > 0 && (
          <div className="rounded-xl border bg-card p-4 text-sm">
            <p className="mb-1 flex items-center gap-2 font-medium">
              <Folder className="size-4 text-muted-foreground" /> Earlier results in “{group.name}”
            </p>
            <p className="mb-2 text-[13px] text-muted-foreground">
              I reused your last task and domain. Datasets aren't stored, so pick the dataset again; the previous results stay available here and on the project page.
            </p>
            <ul className="space-y-1">
              {earlier.slice(0, 3).map((c) => (
                <li key={c.id}>
                  <a href={chatPath(c.id)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    {c.title}
                  </a>
                  <span className="text-muted-foreground">
                    {" "}
                    · {c.winner ? `best: ${c.winner.name}` : c.status}
                  </span>
                </li>
              ))}
            </ul>
            <Link to={projectPath(group.id)} className="mt-2 inline-block text-xs text-primary underline">
              Open project page
            </Link>
          </div>
        )}

        <AskCard question="What kind of problem is it?" options={taskOpts} answered={ans.task} onAnswer={(v, d) => set({ task: v[0] as Task }, "task", d)} />

        {reached("domain") && (
          <AskCard question="Which domain is your data from?" options={domainOpts} allowOther otherPlaceholder="Another domain (e.g. Sports)" answered={ans.domain} onAnswer={(v, d) => set({ domain: v[0] }, "domain", d)} />
        )}

        {reached("dataset") && flow.task && flow.domain && (
          <AssistantMsg>
            {!flow.session ? (
              <>
                <Prose>
                  <p>Here are {flow.domain.toLowerCase()} datasets I found. Pick one, or bring your own.</p>
                </Prose>
                {rerun && (
                  <div className="mb-3 space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-4 text-sm">
                    <p className="font-medium">Repeating “{rerun.title}”</p>
                    <p className="text-[13px] text-muted-foreground">
                      Datasets are never stored. Your earlier settings are ready; I just need the same dataset again{rerun.dataset.name ? ` (${rerun.dataset.name})` : ""}.
                      {rerun.dataset.ref ? "" : " Upload the same file, or paste its link or name below."}
                    </p>
                    {rerun.dataset.ref && (
                      <Button size="sm" onClick={reloadSame} disabled={reloading}>
                        {reloading && <Spinner />} Load {rerun.dataset.name || "the same dataset"} again
                      </Button>
                    )}
                    {rerunErr && <p className="text-xs text-destructive">{rerunErr}</p>}
                  </div>
                )}
                <DatasetCards domain={flow.domain} task={flow.task} onPick={pickSession} initialSource={rerun ? (rerun.dataset.ref ? "recommended" : "own") : "recommended"} />
              </>
            ) : (
              <Prose>
                <p>
                  Using <b>{flow.session.name}</b> ({flow.session.profile.rows.toLocaleString("en-IN")} rows, {flow.session.profile.cols} columns).
                </p>
              </Prose>
            )}
          </AssistantMsg>
        )}

        {reached("target") && !flow.target && flow.session && flow.task && (
          <AssistantMsg>
            <TargetCard session={flow.session} task={flow.task} onPick={(t) => set({ target: t }, "target", t)} />
          </AssistantMsg>
        )}
        {ans.target && <p className="text-sm text-muted-foreground">Target: <b className="text-foreground">{ans.target}</b></p>}

        {reached("eda") && flow.target && (
          <AskCard question="Do you want exploratory data analysis (EDA) with charts?" options={edaOpts} answered={ans.eda} onAnswer={(v, d) => set({ eda: v[0] === "yes" }, "eda", d)} />
        )}

        {reached("edaCols") && flow.eda && flow.session && flow.target && flow.task && flow.edaCols === undefined && (
          <EdaColumnsCard
            datasetId={flow.session.dataset_id}
            target={flow.target}
            task={flow.task}
            done={flow.edaCols !== undefined}
            onReady={(cols, summary) => set({ edaCols: cols }, "edaCols", summary)}
          />
        )}

        {reached("prep") && flow.session && flow.target && (
          <PrepCard columns={flow.session.profile.columns} target={flow.target} done={!!flow.prep} onSubmit={(p, summary) => set({ prep: { p, summary } }, "prep", summary)} />
        )}

        {reached("split") && flow.session && (
          <SplitCard datetimeColumns={flow.session.datetime_columns} done={!!flow.split} onSubmit={(c, summary) => set({ split: { c, summary } }, "split", summary)} />
        )}

        {reached("models") && flow.task && flow.domain && (
          <ModelPicker task={flow.task} domain={flow.domain} done={!!flow.modelIds} onLoaded={setModels} onSubmit={(ids, summary) => set({ modelIds: ids }, "models", summary)} />
        )}

        {reached("tune") && flow.modelIds && flow.session && flow.target && flow.task && (
          <TuningCard models={models.filter((m) => flow.modelIds?.includes(m.id))} datasetId={flow.session!.dataset_id} target={flow.target!} task={flow.task!} done={!!flow.specs} onSubmit={(v, summary) => set({ specs: { v, summary } }, "tune", summary)} />
        )}

        {reached("confirm") && flow.specs && (
          <>
            <ConfirmCard
              modelCount={flow.specs.v.length}
              rows={confirmRows}
              done={!!flow.run}
              onRun={start}
              onEdit={() => setFlow((f) => ({ task: f.task, domain: f.domain, session: f.session, target: f.target, eda: f.eda, edaCols: f.edaCols }))}
              onCancel={() => nav(newChatPath(projectId ?? undefined))}
            />
            {starting && <Spinner />}
            {err && <p className="text-sm text-destructive">{err}</p>}
          </>
        )}
      </div>

      {flow.run && <RunBlock key={flow.run.jobId} jobId={flow.run.jobId} needsPayment={flow.run.needsPayment} onFinished={() => void refreshChats()} />}
      <div ref={endRef} />
    </>
  );
}

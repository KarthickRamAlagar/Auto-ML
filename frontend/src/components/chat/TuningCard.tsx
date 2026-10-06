import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/progress";
import { Segmented } from "@/components/ui/segmented";
import { api } from "@/lib/api";
import type { ModelInfo, ModelPlan, ModelSpec, ParamSpec, PlanParam, Task } from "@/lib/types";

type Mode = "default" | "grid" | "custom";
type Vals = Record<string, string>;

const str = (v: unknown) => (v == null ? "" : String(v));

export function TuningCard({
  models,
  datasetId,
  target,
  task,
  done,
  onSubmit,
}: {
  models: ModelInfo[];
  datasetId: string;
  target: string;
  task: Task;
  done?: boolean;
  onSubmit: (specs: ModelSpec[], summary: string) => void;
}) {
  const [plan, setPlan] = useState<ModelPlan | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modes, setModes] = useState<Record<string, Mode>>(() => Object.fromEntries(models.map((m) => [m.id, m.has_grid ? "grid" : "default"])));
  const [vals, setVals] = useState<Record<string, Vals>>(() =>
    Object.fromEntries(models.map((m) => [m.id, Object.fromEntries(m.params.map((p) => [p.name, str(p.default)]))])),
  );

  useEffect(() => {
    if (done) {
      setLoading(false);
      return;
    }
    let alive = true;
    api
      .post<ModelPlan>("/api/models/plan", { dataset_id: datasetId, target, task, model_ids: models.map((m) => m.id) })
      .then((r) => {
        if (!alive) return;
        setPlan(r);
        // Start every model on the system recommendation, still editable.
        setModes(Object.fromEntries(models.map((m) => [m.id, r.plans[m.id]?.params.some((p) => p.ask) ? "custom" : m.has_grid ? "grid" : "default"])));
        setVals(Object.fromEntries(models.map((m) => [m.id, Object.fromEntries((r.plans[m.id]?.params ?? m.params).map((p) => [p.name, str((p as Partial<PlanParam>).recommended !== undefined ? (p as PlanParam).recommended : p.default)]))])));
      })
      .catch((e: Error) => alive && setPlanErr(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (done) return null;
  if (loading)
    return (
      <div className="flex items-center gap-3 rounded-xl border bg-card p-4 text-sm text-muted-foreground">
        <Spinner /> Checking your data to recommend settings for each model…
      </div>
    );

  const paramsOf = (m: ModelInfo): (ParamSpec & Partial<PlanParam>)[] => (plan?.plans[m.id]?.params ?? m.params).filter((p) => !("ask" in p) || (p as PlanParam).ask);
  // Decision tree: only show the knobs that apply to the chosen pruning strategy.
  const PRE = ["max_depth", "min_samples_leaf"];
  const visible = (m: ModelInfo) => {
    const ps = paramsOf(m);
    if (m.id !== "tree") return ps;
    const pr = vals[m.id]?.pruning ?? "none";
    return ps.filter((p) => !(PRE.includes(p.name) && (pr === "none" || pr === "post")) && !(p.name === "ccp_alpha" && (pr === "none" || pr === "pre")));
  };
  const setMode = (id: string, mode: Mode) => setModes((s) => ({ ...s, [id]: mode }));
  const setVal = (id: string, name: string, v: string) => setVals((s) => ({ ...s, [id]: { ...s[id], [name]: v } }));
  const all = (mode: Mode) => setModes(Object.fromEntries(models.map((m) => [m.id, mode === "grid" && !m.has_grid ? "default" : mode === "custom" && paramsOf(m).length === 0 ? "default" : mode])));
  const reset = (m: ModelInfo) => setVals((s) => ({ ...s, [m.id]: Object.fromEntries(paramsOf(m).map((p) => [p.name, str(p.recommended !== undefined ? p.recommended : p.default)])) }));

  const submit = () => {
    const specs: ModelSpec[] = models.map((m) => {
      const mode = modes[m.id];
      const params: ModelSpec["params"] = {};
      if (mode === "custom") {
        for (const p of paramsOf(m)) {
          const raw = (vals[m.id]?.[p.name] ?? "").trim();
          if (raw === "") params[p.name] = null;
          else if (p.type === "choice") params[p.name] = raw;
          else {
            let n = Number(raw);
            if (Number.isNaN(n)) continue;
            if (p.min != null) n = Math.max(p.min, n);
            if (p.max != null) n = Math.min(p.max, n);
            params[p.name] = p.type === "int" ? Math.round(n) : n;
          }
        }
      }
      return { id: m.id, tuning: mode, params };
    });
    const g = specs.filter((s) => s.tuning === "grid").length;
    const c = specs.filter((s) => s.tuning === "custom").length;
    onSubmit(specs, `${models.length} model(s): ${c} with your/AI settings, ${g} auto-tuned, ${models.length - g - c} default`);
  };

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
      <div>
        <p className="font-serif text-[16px] font-medium">Set each model's hyperparameters</p>
        <p className="text-[13px] text-muted-foreground">
          Only the settings that matter for your data are shown. Each has a recommended value with the reason; change any of them, or switch to Auto-tune (cross-validated grid search) or Default.
        </p>
      </div>
      {plan && (
        <div className="flex gap-2 rounded-lg bg-primary/5 p-3 text-[13px]">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
          <div>
            <p>{plan.summary.text}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Based on {plan.facts.rows.toLocaleString("en-IN")} rows and {plan.facts.cols} columns{plan.summary.source === "llm" ? " · wording by AI, values measured on a sample" : ""}.
            </p>
          </div>
        </div>
      )}
      {planErr && <p className="text-xs text-muted-foreground">Couldn't compute recommendations ({planErr}). Standard defaults and auto-tune are available.</p>}
      <div className="flex flex-wrap gap-2">
        {plan && (
          <Button size="sm" variant="outline" onClick={() => all("custom")}>
            Use recommended for all
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => all("grid")}>
          Auto-tune all
        </Button>
        <Button size="sm" variant="outline" onClick={() => all("default")}>
          Defaults for all
        </Button>
      </div>
      <div className="space-y-3">
        {models.map((m) => {
          const ps = paramsOf(m);
          return (
            <div key={m.id} className="rounded-lg border p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {m.name}
                  {modes[m.id] === "custom" && plan && <Badge>AI recommended</Badge>}
                </span>
                <Segmented
                  label={`${m.name} tuning`}
                  value={modes[m.id]}
                  onChange={(v) => setMode(m.id, v)}
                  options={[
                    { v: "default", label: "Default" },
                    { v: "grid", label: "Auto-tune", disabled: !m.has_grid },
                    { v: "custom", label: plan ? "Recommended / edit" : "Custom", disabled: ps.length === 0 },
                  ]}
                />
              </div>
              {!m.has_grid && modes[m.id] !== "custom" && <p className="text-xs text-muted-foreground">No tunable grid for this model; defaults are used unless you choose Recommended / edit.</p>}
              {modes[m.id] === "custom" && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {visible(m).map((p) => (
                      <label key={p.name} className="space-y-1 text-[13px]">
                        <span className="font-medium">{p.label}</span>
                        {p.type === "choice" ? (
                          <Select value={vals[m.id]?.[p.name] ?? ""} onChange={(e) => setVal(m.id, p.name, e.target.value)}>
                            {p.options.map((o) => (
                              <option key={String(o)} value={String(o)}>
                                {String(o)}
                                {p.recommended !== undefined && String(o) === String(p.recommended) ? " (recommended)" : ""}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Input
                            type="number"
                            inputMode="decimal"
                            step={p.type === "int" ? 1 : "any"}
                            min={p.min ?? undefined}
                            max={p.max ?? undefined}
                            placeholder={p.default == null ? "none" : String(p.default)}
                            value={vals[m.id]?.[p.name] ?? ""}
                            onChange={(e) => setVal(m.id, p.name, e.target.value)}
                          />
                        )}
                        <span className="block text-xs text-muted-foreground">{p.reason || p.help}</span>
                      </label>
                    ))}
                  </div>
                  {plan && (
                    <button type="button" className="mt-2 text-xs text-primary hover:underline" onClick={() => reset(m)}>
                      Reset to recommended
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-end">
        <Button onClick={submit}>Continue</Button>
      </div>
    </div>
  );
}

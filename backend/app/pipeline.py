"""The ML pipeline: validate -> (EDA) -> preprocess -> split -> train each model -> verdict.

Every stage emits events (step_start / log / step_end / eda / model_result) which the job layer streams to the
browser. Each step also carries the Python code that corresponds to it, generated from the SAME option objects
that configure the run, so the "Running code" view matches what executed.
"""
from __future__ import annotations

import itertools
import time
import warnings
from contextlib import contextmanager
from typing import Any, Callable, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from sklearn.base import clone
from sklearn.compose import ColumnTransformer
from sklearn.decomposition import PCA
from sklearn.feature_selection import SelectKBest, VarianceThreshold, f_classif, f_regression
from sklearn.impute import SimpleImputer
from sklearn.metrics import (accuracy_score, confusion_matrix, f1_score, mean_absolute_error, mean_squared_error,
                             precision_score, r2_score, recall_score, roc_auc_score)
from sklearn.model_selection import GridSearchCV, KFold, StratifiedKFold, TimeSeriesSplit, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import LabelEncoder, MinMaxScaler, OneHotEncoder, OrdinalEncoder, RobustScaler, StandardScaler

from .datasets import column_kind
from .eda import _n, build_eda
from .models_registry import MODELS, clean_params

SVM_TRAIN_CAP = 8000
GRID_SAMPLE_CAP = 10000


# --------------------------------------------------------------------------- config
class Preprocess(BaseModel):
    impute: Literal["median_mode", "mean_mode", "drop_rows"] = "median_mode"
    encode: Literal["onehot", "ordinal"] = "onehot"
    scale: Literal["none", "standard", "minmax", "robust"] = "standard"
    feature_selection: Literal["none", "kbest", "variance"] = "none"
    k_best: int = Field(10, ge=1, le=200)
    reduction: Literal["none", "pca"] = "none"
    pca_variance: float = Field(0.95, ge=0.5, le=0.999)
    drop_columns: list[str] = Field(default_factory=list, max_length=500)


class ModelSpec(BaseModel):
    id: str
    tuning: Literal["default", "grid", "custom"] = "default"
    params: dict[str, Any] = Field(default_factory=dict)


class JobConfig(BaseModel):
    dataset_id: str
    task: Literal["classification", "regression"]
    domain: str = Field("Other", max_length=40)
    target: str = Field(max_length=200)
    eda: bool = True
    eda_columns: list[str] | None = Field(default=None, max_length=60)
    preprocess: Preprocess = Field(default_factory=Preprocess)
    split: Literal["random", "chronological"] = "random"
    test_size: float = Field(0.2, ge=0.1, le=0.4)
    time_column: str | None = None
    cv_folds: int = Field(3, ge=2, le=5)
    models: list[ModelSpec] = Field(min_length=1, max_length=12)
    videos: bool = False
    team: bool = False


class PipelineError(Exception):
    pass


Emit = Callable[[dict], None]


@contextmanager
def step(emit: Emit, sid: str, title: str, code: str | None = None, model_id: str | None = None):
    t0 = time.time()
    emit({"type": "step_start", "id": sid, "title": title, "code": code, "model_id": model_id})

    def log(text: str) -> None:
        emit({"type": "log", "step": sid, "text": text})

    try:
        yield log
    except Exception as exc:
        emit({"type": "step_end", "id": sid, "status": "error", "ms": int((time.time() - t0) * 1000),
              "error": str(exc)[:300], "model_id": model_id})
        raise
    emit({"type": "step_end", "id": sid, "status": "done", "ms": int((time.time() - t0) * 1000), "model_id": model_id})


def _json(o: Any) -> Any:
    if isinstance(o, dict):
        return {str(k): _json(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_json(v) for v in o]
    return _n(o)


# --------------------------------------------------------------------------- code generation
def _repr_kwargs(kw: dict) -> str:
    return ", ".join(f"{k}={v!r}" for k, v in kw.items())


def code_load(name: str, rows: int, cols: int, note: str) -> str:
    return (f'import pandas as pd\nimport numpy as np\n\ndf = pd.read_csv("{name}.csv")\n'
            f"print(df.shape)  # {rows} rows x {cols} columns\n{note}")


def code_prep(cfg: JobConfig, num: list[str], cat: list[str], dropped: list[str]) -> str:
    pp = cfg.preprocess
    scaler = {"standard": "StandardScaler()", "minmax": "MinMaxScaler()", "robust": "RobustScaler()"}.get(pp.scale)
    imp = "median" if pp.impute == "median_mode" else "mean"
    enc = ("OneHotEncoder(handle_unknown='infrequent_if_exist', max_categories=20, sparse_output=False)"
           if pp.encode == "onehot" else "OrdinalEncoder(handle_unknown='use_encoded_value', unknown_value=-1)")
    lines = [
        "from sklearn.compose import ColumnTransformer",
        "from sklearn.pipeline import Pipeline",
        "from sklearn.impute import SimpleImputer",
        "from sklearn.preprocessing import StandardScaler, MinMaxScaler, RobustScaler, OneHotEncoder, OrdinalEncoder",
        "",
        f"target = {cfg.target!r}",
        "y = df[target]",
        f"X = df.drop(columns=[target] + {dropped!r})",
        f"numeric_features = {num!r}",
        f"categorical_features = {cat!r}",
        "",
        f"numeric_pipe = Pipeline([('imputer', SimpleImputer(strategy='{imp}'))"
        + (f", ('scaler', {scaler})" if scaler else "") + "])",
        f"categorical_pipe = Pipeline([('imputer', SimpleImputer(strategy='most_frequent')), ('encoder', {enc})])",
        "preprocess = ColumnTransformer([('num', numeric_pipe, numeric_features), ('cat', categorical_pipe, categorical_features)])",
        "steps = [('prep', preprocess)]",
    ]
    if pp.feature_selection == "kbest":
        fn = "f_classif" if cfg.task == "classification" else "f_regression"
        lines += ["from sklearn.feature_selection import SelectKBest, " + fn,
                  f"steps.append(('select', SelectKBest({fn}, k={pp.k_best})))"]
    elif pp.feature_selection == "variance":
        lines += ["from sklearn.feature_selection import VarianceThreshold",
                  "steps.append(('select', VarianceThreshold(threshold=0.01)))"]
    if pp.reduction == "pca":
        lines += ["from sklearn.decomposition import PCA",
                  f"steps.append(('pca', PCA(n_components={pp.pca_variance}, svd_solver='full')))"]
    return "\n".join(lines)


def code_split(cfg: JobConfig) -> str:
    if cfg.split == "chronological":
        tc = cfg.time_column
        sort = f"df = df.sort_values({tc!r}).reset_index(drop=True)  # do this before building X and y\n" if tc else ""
        return (f"{sort}cut = int(len(X) * {1 - cfg.test_size:.2f})\n"
                "X_train, X_test = X.iloc[:cut], X.iloc[cut:]\ny_train, y_test = y.iloc[:cut], y.iloc[cut:]")
    strat = ", stratify=y" if cfg.task == "classification" else ""
    return ("from sklearn.model_selection import train_test_split\n"
            f"X_train, X_test, y_train, y_test = train_test_split(X, y, test_size={cfg.test_size}, random_state=42{strat})")


def code_model(cfg: JobConfig, mid: str, kwargs: dict, mode: str, grid: dict | None, cv: int) -> str:
    m = MODELS[mid]
    mod, cls = m.class_path(cfg.task)
    scoring = "f1_weighted" if cfg.task == "classification" else "r2"
    cv_code = (f"TimeSeriesSplit(n_splits={cv})" if cfg.split == "chronological"
               else (f"StratifiedKFold(n_splits={cv}, shuffle=True, random_state=42)" if cfg.task == "classification"
                     else f"KFold(n_splits={cv}, shuffle=True, random_state=42)"))
    lines = [f"from {mod} import {cls}", "from sklearn.pipeline import Pipeline",
             f"model = Pipeline(steps + [('model', {cls}({_repr_kwargs(kwargs)}))])"]
    if mode == "grid" and grid:
        pg = {f"model__{k}": v for k, v in grid.items()}
        lines += ["from sklearn.model_selection import GridSearchCV, StratifiedKFold, KFold, TimeSeriesSplit",
                  f"param_grid = {pg!r}",
                  f"search = GridSearchCV(model, param_grid, cv={cv_code}, scoring='{scoring}', n_jobs=1)",
                  "search.fit(X_train, y_train)",
                  "print(search.best_params_, search.best_score_)",
                  "model = search.best_estimator_"]
    else:
        lines.append("model.fit(X_train, y_train)")
    lines.append("pred = model.predict(X_test)")
    if cfg.task == "classification":
        lines += ["from sklearn.metrics import accuracy_score, f1_score, classification_report",
                  "print('accuracy', accuracy_score(y_test, pred))",
                  "print('f1 (weighted)', f1_score(y_test, pred, average='weighted'))"]
    else:
        lines += ["from sklearn.metrics import r2_score, mean_squared_error, mean_absolute_error",
                  "print('R2', r2_score(y_test, pred))",
                  "print('RMSE', mean_squared_error(y_test, pred) ** 0.5)",
                  "print('MAE', mean_absolute_error(y_test, pred))"]
    return "\n".join(lines)


# --------------------------------------------------------------------------- preprocessing
def classify_features(X: pd.DataFrame, time_col: str | None) -> tuple[list[str], list[str], list[tuple[str, str]]]:
    num, cat, dropped = [], [], []
    n = len(X)
    for c in X.columns:
        s = X[c]
        kind = column_kind(s)
        if c == time_col or kind == "datetime":
            dropped.append((c, "date/time column (used for ordering only)"))
        elif s.nunique(dropna=True) <= 1:
            dropped.append((c, "constant column"))
        elif kind == "numeric":
            num.append(c)
        elif kind == "boolean":
            X[c] = s.astype(int)
            num.append(c)
        elif kind == "text" or (n > 50 and s.nunique(dropna=True) > 0.9 * n):
            dropped.append((c, "free text / ID-like column"))
        else:
            cat.append(c)
    return num, cat, dropped


def build_column_transformer(cfg: JobConfig, num: list[str], cat: list[str]) -> ColumnTransformer:
    pp = cfg.preprocess
    scaler = {"standard": StandardScaler, "minmax": MinMaxScaler, "robust": RobustScaler}.get(pp.scale)
    parts = []
    if num:
        ns = [("imputer", SimpleImputer(strategy="median" if pp.impute == "median_mode" else "mean"))]
        if scaler:
            ns.append(("scaler", scaler()))
        parts.append(("num", Pipeline(ns), num))
    if cat:
        enc = (OneHotEncoder(handle_unknown="infrequent_if_exist", max_categories=20, sparse_output=False)
               if pp.encode == "onehot" else OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1))
        parts.append(("cat", Pipeline([("imputer", SimpleImputer(strategy="most_frequent")), ("encoder", enc)]), cat))
    return ColumnTransformer(parts, remainder="drop")


def build_steps(cfg: JobConfig, ct: ColumnTransformer, Xtr: pd.DataFrame, ytr) -> tuple[list, list[str]]:
    pp = cfg.preprocess
    notes: list[str] = []
    steps: list = [("prep", ct)]
    needs_shape = pp.feature_selection != "none" or pp.reduction == "pca"
    Xt = clone(ct).fit(Xtr, ytr).transform(Xtr) if needs_shape else None
    if pp.feature_selection == "kbest":
        k = min(pp.k_best, Xt.shape[1])
        fn = f_classif if cfg.task == "classification" else f_regression
        steps.append(("select", SelectKBest(fn, k=k)))
        notes.append(f"SelectKBest keeps {k} of {Xt.shape[1]} features")
    elif pp.feature_selection == "variance":
        thr = 0.01 if (Xt.var(axis=0) > 0.01).any() else 0.0
        steps.append(("select", VarianceThreshold(threshold=thr)))
        notes.append(f"VarianceThreshold({thr}) over {Xt.shape[1]} features")
    if pp.reduction == "pca":
        steps.append(("pca", PCA(n_components=pp.pca_variance, svd_solver="full")))
        notes.append(f"PCA keeps {pp.pca_variance:.0%} of variance")
    return steps, notes


def make_cv(cfg: JobConfig, ytr):
    if cfg.split == "chronological":
        return TimeSeriesSplit(n_splits=cfg.cv_folds)
    if cfg.task == "classification":
        counts = np.bincount(ytr)
        counts = counts[counts > 0]
        if counts.min() >= cfg.cv_folds:
            return StratifiedKFold(n_splits=cfg.cv_folds, shuffle=True, random_state=42)
    return KFold(n_splits=cfg.cv_folds, shuffle=True, random_state=42)


# --------------------------------------------------------------------------- metrics
def evaluate(task: str, est, Xtr, ytr, Xte, yte, n_classes: int) -> dict:
    pred = est.predict(Xte)
    ptr = est.predict(Xtr)
    if task == "classification":
        avg = "weighted"
        m = {
            "accuracy": accuracy_score(yte, pred),
            "precision": precision_score(yte, pred, average=avg, zero_division=0),
            "recall": recall_score(yte, pred, average=avg, zero_division=0),
            "f1": f1_score(yte, pred, average=avg, zero_division=0),
        }
        try:
            if n_classes == 2:
                score = est.predict_proba(Xte)[:, 1] if hasattr(est, "predict_proba") else est.decision_function(Xte)
                m["roc_auc"] = roc_auc_score(yte, score)
            elif hasattr(est, "predict_proba"):
                proba = est.predict_proba(Xte)
                if proba.shape[1] == n_classes:
                    m["roc_auc"] = roc_auc_score(yte, proba, multi_class="ovr", average="weighted")
        except Exception:  # noqa: BLE001 - AUC is optional (e.g. a class missing from the test split)
            pass
        return {"metrics": m, "primary": m["f1"], "train_primary": f1_score(ytr, ptr, average=avg, zero_division=0),
                "pred": pred}
    mse = mean_squared_error(yte, pred)
    m = {"r2": r2_score(yte, pred), "rmse": float(np.sqrt(mse)), "mse": mse, "mae": mean_absolute_error(yte, pred)}
    return {"metrics": m, "primary": m["r2"], "train_primary": r2_score(ytr, ptr), "pred": pred}


def _strip(params: dict) -> dict:
    return {k.split("__", 1)[1] if k.startswith("model__") else k: v for k, v in params.items()}


# --------------------------------------------------------------------------- training one model
def train_model(cfg: JobConfig, spec: ModelSpec, steps: list, Xtr, ytr, Xte, yte, classes: list[str],
                emit: Emit, rng: np.random.Generator) -> dict:
    mid = spec.id
    m = MODELS[mid]
    sid = f"train:{mid}"
    user = clean_params(mid, spec.params) if spec.tuning == "custom" else {}
    kwargs = m.kwargs(cfg.task, user)
    grid = m.grid.get(cfg.task) or {}
    mode = spec.tuning
    notes: list[str] = []
    if mode == "grid" and not grid:
        mode = "default"
        notes.append("No tunable parameters; used defaults.")
    code = code_model(cfg, mid, kwargs, mode, grid if mode == "grid" else None, cfg.cv_folds)

    with step(emit, sid, f"Train {m.name}", code, model_id=mid) as log:
        t0 = time.time()
        pipe = Pipeline(clone(Pipeline(steps)).steps + [("model", m.make(cfg.task, user))])
        fit_X, fit_y = Xtr, ytr
        if mid == "svm" and len(Xtr) > SVM_TRAIN_CAP:
            idx = rng.choice(len(Xtr), SVM_TRAIN_CAP, replace=False)
            fit_X, fit_y = Xtr.iloc[idx], ytr[idx]
            notes.append(f"SVM trained on a {SVM_TRAIN_CAP:,}-row sample (SVM is slow on large data).")
            log(notes[-1])
        result: dict = {"id": mid, "name": m.name, "tuning": mode, "params": _json(kwargs), "notes": notes}
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if mode == "grid":
                n_cand = int(np.prod([len(v) for v in grid.values()]))
                log(f"Grid search: {n_cand} candidates x {cfg.cv_folds} folds = {n_cand * cfg.cv_folds} fits")
                search_X, search_y = fit_X, fit_y
                if len(fit_X) > GRID_SAMPLE_CAP:
                    idx = rng.choice(len(fit_X), GRID_SAMPLE_CAP, replace=False)
                    idx.sort()
                    search_X, search_y = fit_X.iloc[idx], fit_y[idx]
                    log(f"Searching on a {GRID_SAMPLE_CAP:,}-row sample, then refitting on all training rows.")
                    notes.append("Grid search ran on a sample; final model refit on the full training set.")
                scoring = "f1_weighted" if cfg.task == "classification" else "r2"
                gs = GridSearchCV(pipe, {f"model__{k}": v for k, v in grid.items()}, cv=make_cv(cfg, search_y),
                                  scoring=scoring, n_jobs=1, refit=len(fit_X) <= GRID_SAMPLE_CAP)
                gs.fit(search_X, search_y)
                best = _strip(gs.best_params_)
                log(f"Best parameters: {best}  (CV {scoring} = {gs.best_score_:.4f})")
                if len(fit_X) > GRID_SAMPLE_CAP:
                    est = clone(pipe).set_params(**gs.best_params_).fit(fit_X, fit_y)
                else:
                    est = gs.best_estimator_
                cvr = gs.cv_results_
                order = np.argsort(cvr["rank_test_score"])[:5]
                result["best_params"] = _json(best)
                result["cv_score"] = _n(gs.best_score_)
                result["grid_top"] = [{"params": _json(_strip(cvr["params"][i])), "score": _n(cvr["mean_test_score"][i])}
                                      for i in order]
                if mid == "knn":
                    by_k: dict[int, float] = {}
                    for p, s in zip(cvr["params"], cvr["mean_test_score"]):
                        k = int(p["model__n_neighbors"])
                        by_k[k] = max(by_k.get(k, -1e9), float(s))
                    result["curve"] = [{"k": k, "score": _n(v)} for k, v in sorted(by_k.items())]
            else:
                log("Fitting model with " + (", ".join(f"{k}={v}" for k, v in kwargs.items()) or "default parameters"))
                est = pipe.fit(fit_X, fit_y)
            ev = evaluate(cfg.task, est, fit_X, fit_y, Xte, yte, len(classes))
        result["metrics"] = _json(ev["metrics"])
        result["primary"] = _n(ev["primary"])
        result["train_primary"] = _n(ev["train_primary"])
        if cfg.task == "classification" and len(classes) <= 10:
            cm = confusion_matrix(yte, ev["pred"], labels=list(range(len(classes))))
            result["confusion"] = {"labels": classes, "matrix": cm.tolist()}
        if mid == "tree":
            result["tree"] = _tree_json(est, classes, cfg.task)
        result["train_seconds"] = round(time.time() - t0, 2)
        shown = ", ".join(f"{k}={v:.4f}" for k, v in result["metrics"].items() if v is not None)
        log(f"Test metrics: {shown}")
        result["status"] = "done"
        result["code"] = code
        return result


# --------------------------------------------------------------------------- decision tree picture
def _tree_json(est, classes: list[str], task: str, max_depth: int = 4) -> dict | None:
    """Top levels of a fitted decision tree as plain JSON, for the browser to draw."""
    try:
        tree_model = est.named_steps["model"] if hasattr(est, "named_steps") else est
        t = tree_model.tree_
        try:
            names = [str(x) for x in est[:-1].get_feature_names_out()]
        except Exception:  # noqa: BLE001
            names = [f"feature_{i}" for i in range(tree_model.n_features_in_)]
        names = [n.split("__", 1)[-1] for n in names]

        def node(i: int, depth: int) -> dict:
            n_samples = int(t.n_node_samples[i])
            if task == "classification":
                counts = t.value[i][0]
                k = int(np.argmax(counts))
                out = {"n": n_samples, "label": classes[k] if k < len(classes) else str(k),
                       "share": round(float(counts[k] / max(counts.sum(), 1e-12)), 3)}
            else:
                out = {"n": n_samples, "value": round(float(t.value[i][0][0]), 3)}
            out["impurity"] = round(float(t.impurity[i]), 4)
            if t.children_left[i] != -1:
                f = int(t.feature[i])
                out["feature"] = names[f] if f < len(names) else f"feature_{f}"
                out["threshold"] = round(float(t.threshold[i]), 4)
                if depth < max_depth:
                    out["left"] = node(int(t.children_left[i]), depth + 1)
                    out["right"] = node(int(t.children_right[i]), depth + 1)
                else:
                    out["cut"] = True  # more levels exist below
            return out

        return {"root": node(0, 0), "depth": int(tree_model.get_depth()), "leaves": int(tree_model.get_n_leaves()),
                "shown_depth": max_depth, "task": task}
    except Exception:  # noqa: BLE001 - the picture is a bonus; never fail the run for it
        return None


# --------------------------------------------------------------------------- verdict
_LINEAR = {"logreg", "linreg", "ridge", "lasso", "elastic"}
_TREES = {"tree", "rf", "extra", "gb", "ada"}


def make_verdict(task: str, domain: str, models: list[dict], locked: int = 0, imbalance: float | None = None) -> dict:
    done = [m for m in models if m.get("status") == "done" and m.get("primary") is not None]
    metric = "F1 (weighted)" if task == "classification" else "R²"
    if not done:
        msg = ("Every model in this run is locked until you pay. Unlock them to see the results."
               if locked else "No model finished successfully.")
        return {"winner": None, "ranking": [], "text": [msg], "warnings": [],
                "metric": metric, "locked_models": locked}
    ranked = sorted(done, key=lambda m: -m["primary"])
    w = ranked[0]
    text = [f"{w['name']} is the best model for your {domain} data, scoring {metric} {w['primary']:.3f} on the held-out test set."]
    if len(ranked) > 1:
        r = ranked[1]
        gap = w["primary"] - r["primary"]
        if gap < 0.01:
            text.append(f"It is a close race: {r['name']} is only {gap:.3f} behind. When scores are this close, prefer the "
                        "simpler or faster model.")
        else:
            text.append(f"It leads the runner-up, {r['name']}, by {gap:.3f}.")
    if w["id"] in _LINEAR:
        text.append("A linear model won, which suggests the signal is mostly additive. More complex models did not find "
                    "extra structure to exploit.")
    elif w["id"] in _TREES:
        text.append("A tree-based model won, which suggests non-linear effects or feature interactions matter in this data.")
    elif w["id"] in {"knn", "svm", "mlp"}:
        text.append("A distance/kernel-based model won; scaling the features was important for this result.")
    elif w["id"] == "nb":
        text.append("Naive Bayes won, which usually means the dataset is small or its features are close to independent.")
    warns = []
    if w.get("train_primary") is not None and w["train_primary"] - w["primary"] > 0.1:
        warns.append(f"Possible overfitting: {w['name']} scores {w['train_primary']:.3f} on training data but "
                     f"{w['primary']:.3f} on test data. Try stronger regularisation, a shallower model or more data.")
    if task == "classification" and imbalance and imbalance >= 3:
        warns.append("Classes are imbalanced, so accuracy can look good while minority classes are missed. "
                     "Compare F1 and the confusion matrix.")
    if len(ranked) >= 3:
        text.append(f"Weakest result: {ranked[-1]['name']} ({ranked[-1]['primary']:.3f}).")
    text.append("Next steps: tune the top two models further, check feature importance, and validate on fresh data "
                "before using this model in practice.")
    if locked:
        warns.append(f"{locked} model(s) are locked, so this verdict only considers the unlocked ones.")
    return {
        "winner": {"id": w["id"], "name": w["name"], "score": w["primary"]},
        "ranking": [{"id": m["id"], "name": m["name"], "score": m["primary"], "rank": i + 1} for i, m in enumerate(ranked)],
        "text": text, "warnings": warns, "metric": metric, "locked_models": locked,
    }


# --------------------------------------------------------------------------- main entry
def run_pipeline(df: pd.DataFrame, cfg: JobConfig, dataset_name: str, emit: Emit, max_rows: int, max_seconds: int) -> dict:
    t_start = time.time()
    rng = np.random.default_rng(42)
    results: dict = {"models": {}, "order": [], "codes": {"models": {}}, "meta": {}, "eda": None}
    task = cfg.task

    # 1. load -------------------------------------------------------------
    if cfg.target not in df.columns:
        raise PipelineError(f"Target column '{cfg.target}' not found.")
    bad = [m.id for m in cfg.models if m.id not in MODELS or task not in MODELS[m.id].classes]
    if bad:
        raise PipelineError(f"Model(s) not available for {task}: {', '.join(bad)}")
    with step(emit, "load", "Load dataset") as log:
        tcol = cfg.time_column if cfg.time_column in df.columns else None
        if cfg.split == "chronological" and tcol:
            df = df.assign(**{tcol: pd.to_datetime(df[tcol], errors="coerce")}).sort_values(tcol).reset_index(drop=True)
        note = ""
        if len(df) > max_rows:
            df = (df.tail(max_rows) if cfg.split == "chronological" else df.sample(max_rows, random_state=42)).reset_index(drop=True)
            note = f"# NOTE: sampled to {max_rows:,} rows to fit the free server"
            log(f"Dataset has more than {max_rows:,} rows; using a {max_rows:,}-row "
                f"{'most-recent' if cfg.split == 'chronological' else 'random'} sample.")
        log(f"{len(df):,} rows x {df.shape[1]} columns loaded; target = '{cfg.target}'")
        results["codes"]["load"] = code_load(dataset_name.replace(" ", "_"), len(df), df.shape[1], note)
    emit({"type": "step_code", "id": "load", "code": results["codes"]["load"]})

    # 2. EDA --------------------------------------------------------------
    if cfg.eda:
        with step(emit, "eda", "Exploratory data analysis",
                  "print(df.describe(include='all'))\nprint(df.isna().sum())\nprint(df.corr(numeric_only=True))\n"
                  "df.hist(figsize=(12, 8))") as log:
            eda = build_eda(df, cfg.target, task, cfg.eda_columns)
            results["eda"] = eda
            log(f"{eda['overview']['missing_cells']:,} missing cells, {eda['overview']['duplicates']} duplicate rows, "
                f"{len(eda['inference'])} findings")
            emit({"type": "eda", "data": eda})

    # 3. preprocessing ----------------------------------------------------
    with step(emit, "prep", "Clean data and build preprocessing") as log:
        work = df.copy()
        before = len(work)
        work = work[work[cfg.target].notna()]
        if len(work) < before:
            log(f"Dropped {before - len(work)} rows with a missing target.")
        if task == "classification":
            tser = work[cfg.target]
            nun = tser.nunique()
            if nun < 2:
                raise PipelineError("The target has only one class.")
            if nun > 50:
                raise PipelineError(f"The target has {nun} distinct values; that looks like a numeric target. Choose regression.")
            if pd.api.types.is_float_dtype(tser) and nun > 20:
                raise PipelineError("The target looks continuous. Choose regression instead.")
            le = LabelEncoder()
            y = pd.Series(le.fit_transform(tser.astype(str)), index=work.index)
            classes = [str(c) for c in le.classes_]
            log(f"Classification with {len(classes)} classes: {', '.join(classes[:6])}{'...' if len(classes) > 6 else ''}")
        else:
            y = pd.to_numeric(work[cfg.target], errors="coerce")
            if y.isna().mean() > 0.1:
                raise PipelineError("The target is not numeric; choose classification or another target column.")
            work, y = work[y.notna()], y[y.notna()]
            classes = []
        feature_cols = [c for c in work.columns if c != cfg.target and c not in cfg.preprocess.drop_columns]
        X = work[feature_cols].copy()
        num, cat, dropped = classify_features(X, tcol)
        for c, why in dropped:
            log(f"Dropped '{c}': {why}")
        for c in cfg.preprocess.drop_columns:
            log(f"Dropped '{c}': removed by you")
        X = X[num + cat]
        if not (num or cat):
            raise PipelineError("No usable feature columns remain.")
        if cfg.preprocess.impute == "drop_rows":
            keep = ~X.isna().any(axis=1)
            log(f"Dropped {int((~keep).sum())} rows containing missing values.")
            X, y = X[keep], y[keep]
        if len(X) < 30:
            raise PipelineError("Fewer than 30 usable rows remain after cleaning.")
        pp = cfg.preprocess
        log(f"{len(num)} numeric and {len(cat)} categorical features; impute={pp.impute}, scale={pp.scale}, encode={pp.encode}")
        all_dropped = [c for c, _ in dropped] + list(cfg.preprocess.drop_columns)
        results["codes"]["prep"] = code_prep(cfg, num, cat, all_dropped)
        results["meta"].update({"features": len(num) + len(cat), "numeric": len(num), "categorical": len(cat),
                                "dropped": [{"column": c, "reason": r} for c, r in dropped], "classes": classes})
    emit({"type": "step_code", "id": "prep", "code": results["codes"]["prep"]})

    # 4. split ------------------------------------------------------------
    with step(emit, "split", f"Split data ({cfg.split}, {int(cfg.test_size * 100)}% test)") as log:
        X = X.reset_index(drop=True)
        y = y.reset_index(drop=True)
        def random_split():
            strat = None
            if task == "classification":
                vc = y.value_counts()
                strat = y if vc.min() >= 2 else None
            return train_test_split(X, y, test_size=cfg.test_size, random_state=42, stratify=strat)

        if cfg.split == "chronological":
            cut = int(len(X) * (1 - cfg.test_size))
            Xtr, Xte, ytr, yte = X.iloc[:cut], X.iloc[cut:], y.iloc[:cut], y.iloc[cut:]
            log("Chronological split: the most recent rows form the test set"
                + ("" if tcol else " (no date column chosen, so row order is assumed to be time order)."))
            if task == "classification" and y.iloc[:cut].nunique() < y.nunique():
                # rows sorted by class (or a rare class only appears late): a chronological split would train on a subset of the classes
                log("The older rows do not contain every class (the data looks sorted by the target), so a chronological split "
                    "cannot work here. Switching to a random, stratified split instead.")
                cfg = cfg.model_copy(update={"split": "random"})
                Xtr, Xte, ytr, yte = random_split()
        else:
            Xtr, Xte, ytr, yte = random_split()
        Xtr, Xte = Xtr.reset_index(drop=True), Xte.reset_index(drop=True)
        ytr, yte = ytr.to_numpy(), yte.to_numpy()
        if task == "classification" and len(np.unique(ytr)) < 2:
            raise PipelineError("The training split contains only one class; use a random split.")
        log(f"Train: {len(Xtr):,} rows, Test: {len(Xte):,} rows")
        ct = build_column_transformer(cfg, num, cat)
        steps, notes = build_steps(cfg, ct, Xtr, ytr)
        for n in notes:
            log(n)
        results["codes"]["split"] = code_split(cfg)
        results["meta"].update({"train_rows": len(Xtr), "test_rows": len(Xte), "prep_notes": notes})
    emit({"type": "step_code", "id": "split", "code": results["codes"]["split"]})

    # 5. models -----------------------------------------------------------
    imbalance = (results["eda"] or {}).get("target", {}).get("imbalance_ratio") if results["eda"] else None
    for spec in cfg.models:
        results["order"].append(spec.id)
        if time.time() - t_start > max_seconds:
            res = {"id": spec.id, "name": MODELS[spec.id].name, "status": "skipped",
                   "error": "Skipped: job time limit reached on the free server."}
            emit({"type": "step_start", "id": f"train:{spec.id}", "title": f"Train {res['name']}", "code": None, "model_id": spec.id})
            emit({"type": "step_end", "id": f"train:{spec.id}", "status": "skipped", "ms": 0, "model_id": spec.id})
        else:
            try:
                res = train_model(cfg, spec, steps, Xtr, ytr, Xte, yte, classes, emit, rng)
                results["codes"]["models"][spec.id] = res["code"]
            except Exception as exc:  # noqa: BLE001 - one failing model must not kill the run
                res = {"id": spec.id, "name": MODELS[spec.id].name, "status": "error", "error": str(exc)[:300]}
        results["models"][spec.id] = res
        emit({"type": "model_result", "model_id": spec.id, "result": res})

    results["meta"]["imbalance"] = imbalance
    results["meta"]["seconds"] = round(time.time() - t_start, 1)
    return results

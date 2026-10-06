# Architecture notes

**Request path.** Browser → FastAPI (`/api/*`). Every route except `/api/health` requires a Firebase ID token (dev: `Bearer dev:<email>` when `AUTH_MODE=dev`, refused in production).

**A run.** `POST /api/jobs` validates the config, reserves quota under a lock, then a 2-thread pool runs the pipeline.
Each step appends an event (`step_start`, `step_code`, `log`, `step_end`, `model_result`, `job_end`) to the job. `GET /api/jobs/{id}/events?from=N` streams them as SSE and the client resumes from the last sequence number after a drop.

**Entitlements.** Models beyond the free allowance are *paid models*. Until the payment is claimed their events and results are redacted on the server (code, logs and metrics are never sent), so unlocking cannot be done from the browser.

**Pricing and limits** are pure functions (`pricing.py`, `limits.py`) using Decimal and the server clock; the browser only displays what `/api/quote` returns.

**Quiz.** `quiz.py` holds the question deadline (75 s + 2 s grace) and correct answers; the client only gets option letters and the seconds left.

**LLM.** The router rotates across 5 groups (1 primary + 4 backups each) with 60 s cool-downs. The prompt contains model names and scores only, never data; a rules-based narrator is the fallback.

**Data.** Firestore holds users, payments, projects (summaries), feedback, events and the free-access list. Datasets and trained models are never persisted.

## V2 additions

- **Chats and projects**: a chat is one run; its id is generated in the browser and used as the project record id (`POST /api/jobs?chat_id=…&group_id=…`). A "project" in the UI is a backend *group* (`/api/groups`). Routes: `/api/chats`, `/api/chats/{id}` (GET/PATCH/DELETE), `/api/groups`.
- **Archives**: when a job finishes, results (not datasets) are stored as one zlib-compressed JSON blob per job (Firestore forbids nested arrays and caps documents at 1 MB). `JobManager.get` falls back to the archive, so results survive restarts and the in-memory TTL; entitlement flags are re-persisted when they change.
- **EDA for wide datasets**: `eda.recommend_eda_columns` ranks features by |Pearson r|, correlation ratio or Cramér's V against the target (threshold 15 features); the chosen list is `JobConfig.eda_columns`.
- **LLM providers** (`llm_providers.py`): per provider, `GET /models` and a capability ranking pick the best model; `LLM_GROUPS` overrides. Admin page shows the choice and never shows keys.
- **Lectures** (`videos.py`): YouTube Data API v3 search per model, 7-day cache, curated IDs and search-link fallback.
- **PDF**: `frontend/src/lib/pdf.ts` renders the report's `[data-pdf]` blocks with html2canvas onto A4 pages with jsPDF (forced light theme; no `color-mix()` in charts because html2canvas can't parse it).
- **CORS** allows GET, POST, PATCH, DELETE.

## V2.1 additions

- **Retention**: `jobs.sweep_retention` deletes chats and archives not updated for `RETENTION_DAYS`; `expires_at` is returned with each chat. Interrupted runs are reconciled once (`jobs.reconcile`) with a single refund of reserved models.
- **Dataset sources** (`datasets.py`): `suggest(domain, task, q, source, include_small)` for `recommended | kaggle | huggingface | uci`, all filtered by `size_rule()` (50,000 rows and 30 columns). Kaggle: public list API, shape verified after download (`422` if below the rule). Hugging Face: datasets-server `/info`. UCI: `/api/datasets/list` index cached 24 h. `load_external(ref)` loads `kaggle:`, `hf:`, `uci:` refs; chats store `dataset_ref` for one-click re-runs (`GET /api/chats/{id}/rerun`).
- **Model advisor** (`advisor.py`): `POST /api/models/parse` (rules, then LLM) maps typed text to model ids; `POST /api/models/plan` measures recommendations on a sample (tree pruning via held-out score and cost-complexity path, Ridge/Lasso/Elastic via CV, KNN K, MLP heuristics). The LLM only rewrites the summary. Virtual params (`pruning`, `hidden_layers`, `early_stopping`) are translated in `models_registry`. `pipeline._tree_json` returns the top 4 levels of a fitted tree for the browser SVG (`TreeView`).
- **Payments**: `GET /api/payments/{id}`, `POST /api/payments/{id}/remind` (429 with `seconds_left` until the wait has passed; the wait restarts after each reminder), `GET /api/payments/mine?page=` (7 per page), `GET /api/admin/notifications` (polled every 20 s by the dashboard). `notify.notify_admin_reminder` sends the email.
- **Lectures**: `videos.find_many` with error classification (`no_key`, `key_invalid`, `api_disabled`, `quota`, `key_restricted`, ...); `POST /api/admin/youtube/test`. The browser shows a thumbnail card and loads the youtube-nocookie iframe on click.
- **Browser notifications**: `frontend/src/lib/notify.ts` (permission requested on the *Allow & run* click; notifies only when the tab is hidden).
- **Lectures by language**: `GET /api/jobs/{id}/lectures?lang=` (402 while locked) returns up to 3 videos per model (`relevanceLanguage` + language name in the query, cached per model+language for 7 days); on failure verified curated videos from `videos.json` are returned with `reason`/`detail`/`note`.

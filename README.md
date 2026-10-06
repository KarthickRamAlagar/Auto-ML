# Auto ML · V2.1

A chat-guided AutoML web app (Assignment 2 prototype). The user picks a task and domain, finds or uploads a dataset,
answers a few questions (EDA, preprocessing, split, algorithms, tuning), and watches real scikit-learn models train
with live code. Results include a verdict, EDA charts, exportable code, optional video lectures and a printable report.

```
frontend/   React 18 + Vite + TypeScript + Tailwind + shadcn-style Radix components + Recharts + Firebase Auth
backend/    FastAPI + scikit-learn (training runs in-process), Firestore via the Admin SDK
firestore.rules   deny-all (the browser never talks to Firestore)
```

## Run it locally (no accounts needed)

```bash
# 1. backend  (dev auth: any email works, admin = ADMIN_EMAILS)
cd backend
pip install -r requirements.txt
cp .env.example .env            # optional; defaults work
ADMIN_EMAILS=you@example.com uvicorn app.main:app --port 7860
python -m pytest -q             # 58 tests

# 2. frontend
cd ../frontend
npm install
cp .env.example .env            # leave Firebase vars empty -> local dev login
npm run dev                     # http://localhost:5173
```

Sign in with any email. Use the email in `ADMIN_EMAILS` to see the admin page (`/admin`) and to get free unlimited runs.
Use a different email to experience the limits, quiz and payment drawer.

## What is implemented

| Area | Behaviour |
|---|---|
| Chat flow | task → domain → dataset cards → target → EDA → preprocessing → split → algorithms → tuning → permission card → run. A recommended option is marked at every step. |
| Datasets | 9 built-in (5 synthetic, 4 scikit-learn), live Kaggle and Hugging Face search, CSV upload (25 MB), CSV link (https, SSRF-guarded). Held in memory only, deleted when the run ends. |
| Models | 14 estimators (classification and regression), default / grid-search / custom hyperparameters, domain-ranked suggestions. |
| Live view | Server-Sent Events stream each step with its code and logs; the same parameters build the model and the exported script. |
| Results | Verdict and leaderboard, per-model metrics, confusion matrix, K curve, EDA tab with inference, Code tab (+ `.py` download), Lectures tab, PDF report (`/report/:jobId`, uses the browser's Save as PDF). |
| Limits | 10 free + 15 paid (₹2) models per account per rolling 5h40m window, started at the first run; verified spend over ₹50 / ₹100 shortens it by 3% / 6%. Server clock only. |
| Pricing | ₹2 per video lecture, +5% team of 2, quiz ₹0.25 per correct answer (max 50% off, 7 questions), rounded to a whole rupee. Reports: 2 free, then ₹5. |
| Payment | Static UPI QR in a bottom drawer with an `AML-XXXXX` reference in the note. "I've paid" unlocks results provisionally and emails the admin (Resend) with a deep link; reject re-locks and pauses paid features. |
| Quiz arena | 7 MCQs (data engineering, data science, backend, frontend), 75 s per question enforced by the server (answers never reach the browser), shuffled options, plays while training runs. |
| Admin | Overview charts (revenue per day, runs, sign-ups, domains, models), payment queue with approve/reject and deep link, users, free-access list, feedback. |
| SEO | Per-route title/description/canonical, JSON-LD, build-time pre-rendered `/` and `/pricing`, sitemap, robots. App routes are `noindex`. |
| Security | Firebase ID-token verification, admin allowlist, server-side result redaction for unpaid models, rate limits, upload and URL guards (private-IP and redirect checks), security headers, restricted CORS, `no-store` on `/api`, CSP on Vercel, Firestore deny-all rules. |

## Deploy

### 1. Firebase (Auth + Firestore, free Spark plan)
1. Create a project; enable **Authentication → Google**; add your Vercel domain under authorised domains.
2. Create a **Firestore** database (production mode) and publish `firestore.rules`.
3. Project settings → Service accounts → generate a key; you will paste its JSON as a secret in step 2.
4. Project settings → Your apps → Web app: copy the config values for the frontend.

### 2. Backend on Hugging Face Spaces (Docker)
1. New Space → SDK **Docker**; upload the contents of `backend/` (Dockerfile at the root of the Space). Port 7860.
2. Add these **secrets / variables**:

| Name | Value |
|---|---|
| `APP_ENV` | `production` |
| `STORE_BACKEND` | `firestore` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | the service-account JSON |
| `FRONTEND_ORIGINS` | `https://your-app.vercel.app` |
| `PUBLIC_APP_URL` | `https://your-app.vercel.app` |
| `ADMIN_EMAILS` | your email, your friend's email |
| `UPI_ID`, `UPI_PAYEE_NAME` | your UPI VPA and the name on it |
| `ADMIN_NOTIFY_EMAIL`, `RESEND_API_KEY`, `MAIL_FROM` | payment alert emails (Resend free tier) |
| `KAGGLE_API_TOKEN` | optional, enables Kaggle search and download |
| `HF_TOKEN` | optional, Hugging Face read token (higher rate limits) |
| `YOUTUBE_API_KEYS` | optional, `key1,key2` |
| `GROQ_API_KEYS`, `GEMINI_API_KEYS`, `MISTRAL_API_KEYS`, `CEREBRAS_API_KEYS`, `OPENROUTER_API_KEYS` | optional, up to 5 comma-separated keys each |
| `RETENTION_DAYS`, `MIN_DATASET_ROWS`, `MIN_DATASET_COLS`, `REMIND_AFTER_SECONDS` | optional tuning, see `backend/.env.example` |

### 3. Frontend on Vercel
Import `frontend/` (framework: Vite). Set `VITE_API_URL` (the Space URL, e.g. `https://user-space.hf.space`), `VITE_SITE_URL`
and the four `VITE_FIREBASE_*` values. `npm run build` type-checks, builds and pre-renders; `vercel.json` adds the SPA rewrite and headers.

## What changed in V2

- **URLs**: `/auto-ml/chat/<chatId>` for a chat, `/auto-ml/project/<projectId>` for a project. `/app` still works and redirects to a fresh chat. The logo always goes to the home page.
- **Chats and projects**: every run is a chat. Move chats into projects from the sidebar menu. A project page lists its chats and shows each saved Results / EDA / Code (download the .py or the PDF). Datasets are never stored, so runs can't be repeated, but a new chat inside a project reuses the task and domain and shows the earlier results. Results are saved as one compressed document per chat (`archives`), so they survive restarts.
- **Bento results**, pagination (datasets, models, EDA, lectures, admin lists), full-width bottom payment drawer.
- **Wide datasets** (more than 15 feature columns): the app ranks columns by relevance to the target and asks which ones the EDA should cover.
- **Real PDF download** (built in the browser; no print dialog).
- **AI models**: set provider keys and the server picks the best available model per provider. Check Admin -> AI & integrations.
- **YouTube lectures** fetched per model with `YOUTUBE_API_KEY`.

### Keys to add (backend environment, never in the frontend or in git)

| Variable | Where to get it |
|---|---|
| `KAGGLE_API_TOKEN` | kaggle.com/settings -> API -> Generate New Token (or `KAGGLE_USERNAME` + `KAGGLE_KEY`) |
| `YOUTUBE_API_KEY` | Google Cloud Console -> YouTube Data API v3 -> API key |
| `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY` | each provider's console (any subset) |

Locally (Git Bash): `export YOUTUBE_API_KEY="..."` before starting uvicorn, then open Admin -> AI & integrations to confirm each one shows as connected.

## What changed in V2.1

- **Chats**: opening a chat shows that chat's own saved results; chats whose run was interrupted (or predates saving) show a clear "not available" card with *Re-run with same settings* instead of "Not Found". The project count next to project names is gone. Results are kept **15 days** (`RETENTION_DAYS`), datasets never.
- **Re-run**: repeats a chat's settings. Built-in / Kaggle / UCI / Hugging Face datasets reload in one click; uploads and links need the same file or URL again. Everything else is restored and you land on the confirm step.
- **Dataset sources** as tabs: Recommended, Kaggle, Hugging Face, UCI, Upload/link. Every source follows the same rule: **at least 50,000 rows and 30 columns** (`MIN_DATASET_ROWS/COLS`; a checkbox adds small practice sets). Kaggle's list API has no row counts, so the shape is verified after download and rejected if too small.
- **Models**: type the models you want ("random forest, decision tree and a neural network"), then a parameter form shows only the settings that matter, each with a recommended value and reason measured on a sample of your data (decision tree pre/post-pruning, ridge/lasso alpha, KNN K, MLP layers / activation / learning rate / early stopping). The Decision Tree result is drawn as a tree.
- **EDA** starts with observations, column count and a paginated (10 per page) feature list.
- **Lectures** ask which language you want (18 languages, remembered), then show the best video per model in an in-page player with two similar videos as thumbnail cards on the right (click one to play it). If the YouTube key is missing or refused, hand-picked verified English videos (`backend/app/videos.json`) are shown instead, with the reason. Admin -> AI & integrations has **Test YouTube** and shows Google's exact message.
- **Layout/pagination**: decision-tree cards use the full width; Settings has paginated Notifications and Payments; pagers on Admin lists, notifications and Settings are always visible.
- **Payments**: after "I've paid" one status card is shown, locked until the admin decides. After 7 minutes a **Remind admin** button emails the admin and flags the payment in the Admin dashboard (banner + browser notification). **Account menu -> Payments & notifications** lists every payment as a card, 7 per page.
- **Notifications**: the browser asks permission when you click *Allow & run* and notifies you when the run finishes (or a payment is decided) while the tab is in the background.

- **AI keys**: each provider accepts several keys (`GROQ_API_KEYS=k1,k2,k3,k4,k5`). A failing key is skipped (parked 1 minute for rate limits, 10 minutes for bad key/model) and the next one answers. Admin -> AI & integrations -> *Test the AI connection* tests every key and shows each one's error.
- **YouTube keys**: `YOUTUBE_API_KEYS=key1,key2` (or a comma-separated `YOUTUBE_API_KEY`) are tried in order; Test YouTube reports each key. Gemini now prefers Flash models (they have a free quota); Groq's gpt-oss models get extra token room because they spend tokens on hidden reasoning.
- **Splits**: if a chronological split would leave the training rows without every class (data sorted by the target), the run switches to a random stratified split and says so in the log.

New backend environment variables (all optional): `HF_TOKEN`, `RETENTION_DAYS`, `MIN_DATASET_ROWS`, `MIN_DATASET_COLS`, `MAX_EXTERNAL_MB`, `REMIND_AFTER_SECONDS`.

## Honest limits of V1

- **Single process.** Running jobs, in-memory datasets and quizzes live in one worker (by design: nothing is stored). A Space restart ends active runs and the run is refunded; finished results are archived and kept for `RETENTION_DAYS` (15 days).
- **Free Spaces sleep** after inactivity, so the first request can take about a minute.
- **Quiz protection is a deterrent, not DRM.** It blocks copy, select, context menu and print shortcuts, hides the question when the window loses focus, and watermarks it with the user's email. Browsers cannot block OS screenshots or a phone camera.
- **Payments are honour-based until the admin verifies.** The UPI QR has no automatic confirmation; the admin checks the bank app against the `AML-` reference.
- **Video lectures**: with `YOUTUBE_API_KEY` the app searches YouTube per model. Without it, add IDs by hand in `backend/app/videos.json` or the tab links to a YouTube search.
- **Not exercised in testing** (no network or credentials in the build sandbox): live Kaggle / Hugging Face downloads, the Firestore store, the Resend email, and real LLM keys. The in-memory store, scoring, quota, quiz and payment logic are covered by the test suite and a browser run.
- The logo and the name "Auto ML" are placeholders.

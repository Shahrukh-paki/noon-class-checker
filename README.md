# Noon Class Connection checker

Fills the **Class Connection** board in the NTS WebApp automatically during lectures.

## What it does

1. On school days (Monday to Friday) GitHub starts the checker twice: at about **07:13** and **12:47** Pakistan time. The first run stops at **12:50**, the second at **18:20**. This covers Summer and Winter shifts, Friday included.
2. Every minute it opens the Noon teacher portal schedule (`teacher.noonacademy.com/dashboard/schedule`) as the **Noon TA** account and lists the classes that are **Live**.
3. It opens each live class, one at a time, and **reads** the Participants panel. Every room shows as camera on, camera off, or "The presenter hasn't joined yet".
4. It sends `{campus, room, state}` to a small Supabase function. The function finds the class that should be in that room now (using the timetable) and saves `joined`, `camera_off` or `not_joined` in `class_connection_auto`. The board shows these as "Connected (auto)", "Camera off" and "Not joined".
5. It saves the renewed Noon sign-in in Supabase every 15 minutes, so the next run can use it.

## Privacy and safety

- **Read-only.** Inside a class the checker clicks **nothing** except one **Join** button, and only before the class has loaded. It never clicks Exit, settings, bug report, microphone or camera. If the Exit button is on the page, it does not click at all.
- The camera and microphone are **blocked**. The checker can never be seen or heard in a class.
- To leave a class it closes its own browser tab. It never presses Exit.
- The Noon sign-in is never printed in the logs. Logs only show sizes such as "session saved (2,345 chars)".
- **The GitHub repo is public, so anyone can read its run logs.** The logs show class names and counts only, for example "joined 12, camera off 1, not joined 2". They do not list rooms unless you add `LOG_ROOMS: "1"`.

## One-time setup (about 20 minutes)

### (a) Create the table in Supabase
1. Open supabase.com, open the NTS project, then click **SQL Editor** and **New query**.
2. Paste everything from `supabase/noon_checker_state.sql` and click **Run**. Running it a second time does no harm.
3. The access code (the token "hash") is stored in this table by the project admin. You do not need to type it here.

### (b) Create the Edge Function
1. In Supabase, click **Edge Functions**, then **Deploy a new function**, then **Via Editor**.
2. Name it exactly `class-connection-ingest`.
3. Delete the sample code. Paste everything from `supabase/functions/class-connection-ingest/index.ts`.
4. Click **Deploy**.
5. Open the function's **Details** or settings. Turn **OFF** "Verify JWT" (also called "Enforce JWT verification") and save. The checker does not sign in to Supabase. Its own access code protects the function instead. `supabase/config.toml` holds the same setting for people who use the Supabase command line.
6. Copy the function URL. It looks like `https://vahajiqagrveyfpyeydc.supabase.co/functions/v1/class-connection-ingest`.
7. You do **not** need to add any secret in Supabase. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.

### (c) Create the GitHub repo
1. On github.com click **New repository**. Name it `noon-class-checker`, choose **Public** (public repos run for free), and click **Create**.
2. Click **uploading an existing file**. Drag in everything from this folder **except** `node_modules`, including the hidden `.github` folder. In Windows Explorer, turn on View → Show → Hidden items. Then click **Commit changes**.
3. Check that `.github/workflows/check.yml` is in the repo. If it is not, click **Add file → Create new file**, type `.github/workflows/check.yml` as the name, and paste the file's contents.

### (d) Add the 3 GitHub Secrets
Open the repo, then **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `CHECKER_FUNCTION_URL` | the function URL from step (b)6 |
| `CLASS_MONITOR_TOKEN` | the access code the project admin gives you (the same code whose hash is stored in the table) |
| `NOON_SESSION` | the Noon TA sign-in, copied in step (e) |

### (e) Copy the Noon TA sign-in without seeing it
1. Open Chrome with a profile that is used only for this. Sign in at `https://teacher.noonacademy.com` as the **Noon TA** account and wait for the Schedule to show.
2. Press **F12** to open DevTools, then click the **Console** tab. If Chrome asks, type `allow pasting` first.
3. Paste this line and press Enter:
   ```
   copy(localStorage.getItem('persist:root'))
   ```
   Nothing is shown. The sign-in is now on your clipboard.
4. In GitHub, open the `NOON_SESSION` secret (step d) and press **Ctrl+V** in the value box. Save it.
5. Close that Chrome window. **Do not click "Log out"** in Noon. Logging out can cancel the copied sign-in.
6. Do not use that same browser profile to work in Noon every day. Noon may replace the sign-in in one place and cancel it in the other.

### (f) Test it once
In the repo, click **Actions → Class Connection checker → Run workflow**. The default test run lasts 20 minutes. Click the run to watch the log:
- `signed in with the NOON_SESSION secret session` means it worked.
- `live classes: …` and `sent N rooms: written …` mean it found classes and saved their states. The board in the NTS WebApp should now show "(auto)" states.
- `no live classes right now` is normal outside lecture times.

After this, it runs by itself on school days.

### (g) "SESSION EXPIRED"
If a run fails with **SESSION EXPIRED**, Noon has ended the TA sign-in. This can happen after a password change, a log out, or a long time without use. Redo **step (e)** to paste a fresh sign-in into `NOON_SESSION`. Then **Run workflow** once, as in step (f). The checker tries the saved sign-in first and the `NOON_SESSION` secret second, so a fresh secret always fixes it.

Notes:
- The Noon TA account must be added as a TA on **every** ALP course. Otherwise its schedule does not show those classes.
- GitHub pauses scheduled runs in a public repo after 60 days without any change to the repo. If runs stop, open **Actions** and click **Enable workflow**.

## Security

- **No Supabase service key is stored in GitHub.** Only the Edge Function uses it, inside Supabase.
- The `CLASS_MONITOR_TOKEN` lets the holder do four things through the function and nothing else: write room states into `class_connection_auto`, and read or replace the saved Noon TA sign-in. Treat it like a password. Supabase stores only its SHA-256 hash. Change the code (and its hash) if it ever leaks.
- The `noon_checker_state` table has row-level security on, and the public roles have no access to it.
- The workflow runs only on a timer or when you press "Run workflow". It never runs for pull requests, so a stranger's pull request cannot read the secrets. It has read-only access to the repo.
- Only official GitHub actions are used: `actions/checkout@v4`, `actions/setup-node@v4` and `actions/cache@v4`.
- Turn on **two-factor authentication** on the GitHub account that owns the repo.

## Settings (optional, in `.github/workflows/check.yml` under `env:`)

| Setting | Meaning |
|---|---|
| `CHECK_SECONDS` | time between checks (default 60) |
| `RUN_UNTIL_PKT` | stop time in Pakistan time, e.g. `12:50` |
| `MAX_MINUTES` | stop after this many minutes |
| `CAMPUS_ALIASES` | JSON for Noon campus names that differ from the app, e.g. `{"g.yaseen":"Gulshan Yaseen"}` |
| `LOG_ROOMS` | `"1"` prints every room's state (visible to the public) |

To run the logic tests on a computer: `npm run selftest`.

## Automatic schedule and sign-in renewal (3 Nov 2026)
- **Supabase starts the runs on time** (`supabase/dispatch_schedule.sql`, pg_cron + pg_net). GitHub's own timer started runs 6-9 hours late, after school.
  - Check runs: Mon-Sat 07:35-13:15 and 13:15-18:20 PKT.
  - Keep-alive runs: every 2 hours, every day (weekends too). They only open Noon once so it renews the TA sign-in, save it to Supabase, and stop. This is what stops the sign-in from expiring over a weekend.
- GitHub's timer remains only as a backup keep-alive (20:20 and 02:20 PKT); a late keep-alive does no harm.
- A check run that completes **0 checks** now ends **red** instead of green.
- One-time setup: a fine-grained GitHub token (this repo only, **Actions: Read and write**) stored in Supabase Vault as `github_checker_dispatch_token`, then run `supabase/dispatch_schedule.sql` in the SQL editor. The token expires on the date chosen when it was made; renew it before then (see the file's header).
- Manual test: **Actions -> Class Connection checker -> Run workflow**, mode `keepalive` (about 2 minutes) or `check` with a stop time.

# Ollama Browser Agent

AI browser agent Chrome extension powered by local Ollama models. Chat with an AI that can browse the web, interact with pages, read PDFs, and execute multi-step tasks - all running locally on your machine.

Inspired by Claude's browser extension, but using your own local models.

## Features

- Chat interface with plan-and-confirm workflow
- Autonomous browser actions (click, type, navigate, scroll)
- Accessibility tree analysis (like Claude's extension)
- Visual indicators when agent is active (orange glow border)
- PDF/text file upload and analysis
- Loop detection to prevent getting stuck
- Auto tab creation when no webpage is open
- Multiple model support via Ollama
- **Auto Apply** for LinkedIn Easy Apply, Indeed "Easily apply" and Naukri jobs (local LLM answers form questions)

## Quick start (5 minutes)

```bash
# 1. Install Ollama (https://ollama.com/download), then pull the default model
ollama pull qwen2.5:7b-instruct

# 2. Allow the Chrome extension to call Ollama (see "Configure CORS" below), restart Ollama

# 3. Get the code
git clone https://github.com/BhavyaKohli-code/browserautoapplyagent.git
```

4. Open `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the cloned
   `browserautoapplyagent` folder (the one that contains `manifest.json`).
5. Click the extension icon on any normal web page → the side panel opens.
6. The panel should list your Ollama models. If it says *"Ollama not running at localhost:11434"*,
   see [Troubleshooting](#troubleshooting).

Nothing else to build or install – it is a plain Manifest V3 extension with no build step, and
pdf.js is already bundled (`pdf.min.mjs`, `pdf.worker.min.mjs`). No API keys, no cloud calls:
everything runs against Ollama on `http://localhost:11434`.

## Requirements

- Chrome, Edge, Brave or another Chromium browser (Manifest V3 + Side Panel support)
- [Ollama](https://ollama.com) installed and running
- At least one model pulled (default: `qwen2.5:7b-instruct`)
- ~8 GB RAM for 7B models, ~16 GB for 14B

## Detailed setup

### 1. Install Ollama

Download from [ollama.com](https://ollama.com) or:

**macOS:**
```bash
brew install ollama
brew services start ollama
```

**Linux:**
```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl start ollama
```

**Windows:**
Download the installer from [ollama.com/download](https://ollama.com/download/windows). Ollama runs in the system tray automatically.

Check it is running:
```bash
curl http://localhost:11434/api/tags
```

### 2. Pull a model

```bash
# Default (good for Auto Apply and simple browsing):
ollama pull qwen2.5:7b-instruct

# Better for multi-step browsing tasks:
ollama pull qwen2.5:14b

# Alternative:
ollama pull llama3.1:8b
```

You can switch models from the dropdown in the side panel.

### 3. Configure CORS

Ollama rejects requests from browser extensions unless `OLLAMA_ORIGINS` allows them.
(`chrome-extension://*` is enough; `*` also works.)

**Windows (PowerShell):**
```powershell
[System.Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", "User")
# Quit Ollama from the system tray and start it again
```

**macOS (app):**
```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
# Quit and reopen the Ollama app
```

**macOS (Homebrew service):**
```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
brew services restart ollama
```

**Linux (systemd):**
```bash
sudo systemctl edit ollama
# Add:
# [Service]
# Environment="OLLAMA_ORIGINS=chrome-extension://*"
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

### 4. Load the extension

1. Open `chrome://extensions` (Edge: `edge://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this repository's folder (the one with `manifest.json`)
5. Pin the extension, then click its icon on any webpage to open the side panel

After pulling new code (`git pull`), press the **reload** ↻ button on the extension card.

### 5. (Auto Apply only) Set your profile

Edit `profile-default.js` with your own details – name, email, phone, city, CTC, notice period,
links, and paste your resume as plain text into `resumeText` – then reload the extension.
You can also edit everything later in the **Auto Apply → Profile** section of the panel; values
saved there override the file.

## Usage

1. Open any webpage (or the agent will create one for you)
2. Click the extension icon to open the side panel
3. Click **Connect to current tab**
4. Type what you want the agent to do
5. Review the proposed plan
6. Click **Approve & Run** to execute

### Example prompts

- "Search for developer jobs on LinkedIn"
- "Summarize this page for me"
- "Fill out the form on this page"
- "Go to google.com and search for AI news"

### Attach files

Click the paperclip icon to attach PDFs or text files. The agent will extract and analyze the content.

## Auto Apply (LinkedIn + Indeed + Naukri)

The **Auto Apply** tab applies to quick-apply jobs for you, 100% locally: LinkedIn **Easy Apply**
Indeed **Easily apply** and **Naukri** Apply. Pick one site, LinkedIn + Indeed, or all three next to
the Start button.

How it works: deterministic page helpers (`linkedin-dom.js`, `indeed-dom.js`) drive each site —
search, job cards, the apply form, Next/Continue/Submit. The local LLM is only asked to answer form
questions your profile doesn't cover, one question at a time, using Ollama structured output so the
answer is always one of the form's real options. Every answer is cached in **Saved answers** and
reused on both sites, so the model is needed less and less over time.

Answer priority: your saved/edited answers → profile rules (name, phone, CTC, notice period,
sponsorship, years of experience…) → local LLM (reads your profile + resume).
Your default profile lives in `profile-default.js`; anything edited in the panel overrides it.

1. Be logged in to LinkedIn / Indeed / Naukri in this Chrome profile.
2. Open the side panel → **Auto Apply**.
3. Check **Profile** (prefilled from `profile-default.js`).
4. Set **Job search** (titles one per line, location, date posted, work type, experience;
   optional Indeed city and Naukri city).
5. Pick a **Mode**:
   - *Dry run* – fills every form up to Submit, then discards. Do this first.
   - *Ask me before each submit* – shows the answers, you click Submit / Skip.
   - *Fully automatic* – submits on its own.
6. Pick the site(s) and press **Start applying**. Keep the panel open and the Chrome window
   visible (not minimized) – Chrome freezes timers in hidden tabs. Stop any time from the panel
   or the on-page "Stop Agent" button. **Max applications** counts per site.

Review **Saved answers** after a dry run and fix anything wrong – fixes are used from then on.
**History** lists every job (with its site) and the reason when it was skipped.

Site notes:
- LinkedIn applies inside a modal on the results page. Location uses LinkedIn's `geoId`.
- Indeed opens each application in its own `smartapply.indeed.com` tab and closes it afterwards.
  The country picks the Indeed domain (India → in.indeed.com); "Indeed city" narrows it.
  Smartapply pages contain hidden honeypot "Continue" buttons (`hp-continue-button-N`); the bot
  only clicks the visible real one.
- Indeed ignores script clicks (`element.click()`) on Continue/Submit, so on Indeed the bot clicks
  with real mouse events through `chrome.debugger` (the same mechanism Playwright/Puppeteer use).
  While it does, the browser shows a "started debugging this browser" bar – that is expected.
  The debugger also auto-accepts Indeed's "Leave site?" prompt when an apply tab is closed.

Answer safety:
- Personal data (date of birth, URLs, phone, email, ID numbers) is only ever taken from your
  Profile – the AI is not allowed to guess it. If a form requires one you haven't filled in, that
  job is skipped and the log says which field to add.
- Number dropdowns ("14 - 15 LPA", "3 years") are picked by arithmetic, not by the AI.

Naukri notes:
- Naukri has **no review/Submit step**: pressing Apply either applies immediately or opens a
  recruiter chatbot on the right, and answering its last question submits. So on Naukri:
  - *Dry run* only checks that the job has a Naukri Apply button (not "Apply on company site") –
    it never presses Apply.
  - *Ask me before each submit* asks before pressing **Apply**; the chatbot questions are then
    answered automatically (profile → saved answers → local AI), and each answer is logged.
  - If the bot can't answer a chatbot question it leaves the chat unfinished and closes the tab –
    nothing is submitted.
- Each job opens in its own tab (Naukri's job pages), which is closed afterwards.
- Jobs that only "Apply on company site" are skipped. Naukri has a daily apply limit; the run
  stops when Naukri says it's reached.
- Search uses `naukri.com/<keyword>-jobs-in-<city>` with your total experience, date posted
  (1/7/30 days) and work type (office / remote / hybrid).
- Run a few jobs in *Ask me* mode first and watch the chatbot – Naukri's page markup was
  modelled, not yet verified on a live run.

General notes:
- Jobs whose forms it can't complete are discarded and logged, never half-submitted.
- It never solves CAPTCHAs or verifications – it pauses up to 3 minutes for you to do it.
- Automating LinkedIn/Indeed is against their terms and accounts can be restricted.
  Keep the default delays and a sensible number of applications per day.
- Sites change their UI often. Selectors were verified against the October 2026 UIs.

## Model recommendations

| Model | Size | Quality | Use case |
|-------|------|---------|----------|
| qwen2.5:7b | 4.7GB | Basic | Simple tasks (search, click) |
| llama3.1:8b | 4.7GB | Basic | Simple tasks |
| qwen2.5:14b | 9GB | Better | Multi-step tasks |
| qwen2.5:32b | 20GB | Good | Complex navigation |

For open-ended browsing tasks bigger models help. Auto Apply works well with `qwen2.5:7b-instruct` because the LLM only answers single form questions.

## Architecture

- `background.js` - Service worker: Ollama communication, agent loop, tab management
- `sidepanel.html/js` - Chat UI with plan approval workflow
- `accessibility-tree.js` - DOM analysis (adapted from Claude's extension)
- `visual-indicator.js` - Orange glow border when agent is active
- `register-tab.js` - Content script that registers tabs with the background
- `pdf-extract.js` - PDF text extraction using pdf.js
- `linkedin-dom.js` - LinkedIn page helpers (job cards, Easy Apply modal, form reading/filling)
- `indeed-dom.js` - Indeed page helpers (search results, smartapply form steps)
- `naukri-dom.js` - Naukri page helpers (search results, job page Apply, recruiter chatbot)
- `profile-default.js` - your default Auto Apply profile (edit this with your details)
- `autoapply.js` - Auto Apply orchestrator + answer engine (runs in the side panel)
- `autoapply-ui.js` - Auto Apply settings, log, saved answers and history UI

## Limitations

- Local models (7-14B) struggle with complex multi-step tasks
- Cannot interact with browser-internal pages (chrome://)
- Some websites block automated interactions
- No screenshot/vision support (text-only accessibility tree)

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Ollama not running at localhost:11434" | Start Ollama (`ollama serve` or the tray app) and check `curl http://localhost:11434/api/tags` |
| Requests fail with **403** | `OLLAMA_ORIGINS` is not set or Ollama wasn't restarted after setting it (step 3) |
| Model dropdown is empty | Pull a model: `ollama pull qwen2.5:7b-instruct` |
| Side panel doesn't open | Use a normal `http(s)` page, not `chrome://` or the Web Store |
| Auto Apply stalls | Keep the Chrome window visible (not minimized) and the panel open; check the log in the panel |
| "started debugging this browser" bar | Expected on Indeed – real mouse clicks are sent via `chrome.debugger` |
| Changes to the code don't show up | Reload the extension in `chrome://extensions` and reopen the side panel |

## Credits

Based on [Unlucko/ollama-browser-agent](https://github.com/Unlucko/ollama-browser-agent);
LinkedIn / Indeed Auto Apply added on top.

## License

MIT

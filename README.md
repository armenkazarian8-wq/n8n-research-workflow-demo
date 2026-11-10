# n8n Research & Content Workflow Demo

A **demo** built to show a research-and-content automation pattern for Upwork-style AI/n8n jobs.

It pulls public RSS sources, analyzes each item with **Google Gemini**, produces structured JSON (summary, category, key points, relevance score), dedupes results, writes CSV/JSON, and serves a simple filterable HTML dashboard.

> This is a demonstration project with public sample feeds. It does **not** claim past client work or production results.

## Architecture

```
Manual Trigger (or Schedule)
        │
        ▼
  List RSS sources  ──►  Fetch RSS (HN, TechCrunch, BBC Technology)
        │
        ▼
  Normalize + dedupe + cap items
        │
        ▼
  Gemini analyze via n8n Code node + helpers.httpRequest (structured JSON per item)
        │
        ▼
  Merge + sort by relevance
        │
        ├──► JSON + CSV files  (default)
        ├──► Google Sheets     (disabled swap-in)
        └──► Airtable          (disabled swap-in)
                │
                ▼
        Static HTML dashboard (filter/sort)
```

## What’s in this repo

| Path | Purpose |
|------|---------|
| `workflow/research-content-workflow.json` | Importable n8n workflow (no secrets) |
| `scripts/run-pipeline.js` | Standalone runner that executes the same pipeline end-to-end |
| `dashboard/index.html` | Filter/sort UI over `dashboard/data.json` |
| `sample-output/` | Checked-in sample rows from a real run |
| `.env.example` | Env var template for `GEMINI_API_KEY` |

## Quick start (standalone runner)

```bash
cp .env.example .env
# Put your Gemini key in .env (from https://aistudio.google.com/apikey)
npm install
npm run pipeline
```

Then open `dashboard/index.html` in a browser (or `npm run dashboard`).

## Import into n8n

1. Install/start n8n with **Node.js 18-22** (`npx n8n@1.72.1` or your usual setup). Node 24+ is not supported by n8n yet; the standalone `npm run pipeline` works on Node 18+.
2. Set environment variable **before** starting n8n:

   ```bash
   export GEMINI_API_KEY=your_key_here
   # Allow workflow expressions to read env (needed for $env.GEMINI_API_KEY)
   export N8N_BLOCK_ENV_ACCESS_IN_NODE=false
   npx n8n
   ```

3. Import via UI (**Workflows → Import from File**) or CLI:

   ```bash
   # CLI import needs a JSON array wrapper
   python3 -c 'import json; json.dump([json.load(open("workflow/research-content-workflow.json"))], open("/tmp/wf.json","w"))'
   n8n import:workflow --input=/tmp/wf.json
   n8n execute --id=research-content-demo
   ```

4. Or open the workflow in the UI and click **Test workflow** / **Execute**.
5. Optional: enable **Every 6 Hours** and disable **Manual Trigger** for scheduled runs.
6. Optional swap-ins:
   - Enable **Google Sheets (swap-in)** after connecting Google credentials and setting the spreadsheet ID.
   - Enable **Airtable (swap-in)** after connecting Airtable and setting base/table IDs.
   - Or enable **Write JSON File** and set a path writable by your n8n process.

The Gemini node reads the key via `{{ $env.GEMINI_API_KEY }}`. The exported workflow contains **no API keys**.

## Structured AI output shape

```json
{
  "summary": "2-3 sentence summary",
  "category": "AI | Startups | Security | Developer Tools | Business | Science | Other",
  "key_points": ["...", "...", "..."],
  "relevance_score": 8
}
```

## Scripts

```bash
npm run pipeline    # fetch → Gemini → write output/ + sample-output/ + dashboard/data.json
npm run dashboard   # serve dashboard on http://127.0.0.1:8765
npm run n8n         # start local n8n (uses ./ .n8n data dir; not committed)
```


## Verified in n8n

This workflow was imported and executed with the n8n CLI (not only the standalone runner):

```bash
# Requires Node.js 18-22 and GEMINI_API_KEY in the environment
export N8N_BLOCK_ENV_ACCESS_IN_NODE=false
export NODE_FUNCTION_ALLOW_BUILTIN=fs
# Import expects a JSON array:
n8n import:workflow --input=<(python3 -c 'import json;print(json.dumps([json.load(open("workflow/research-content-workflow.json"))]))')
n8n execute --id=research-content-demo --rawOutput
```

- **n8n version:** 1.72.1
- **Result:** execution completed successfully; Gemini returned structured rows; files written under `output/`, `sample-output/`, and `dashboard/data.json`
- Sample output in this repo was refreshed from that n8n run (`executed_in: "n8n"` in the JSON)
- Execution summary (no secrets): [`docs/n8n-cli-execution-proof.json`](docs/n8n-cli-execution-proof.json)

## Security

- Never commit `.env`, `node_modules/`, or `.n8n/` database files.
- Rotate any key that was pasted into chat or logs.
- Sample output may include public article titles/URLs only.

## License

MIT

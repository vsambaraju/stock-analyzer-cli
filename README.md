# stock-analyzer-cli

An AI-powered, interactive stock-analysis CLI. It runs an equity-research agent
(via the [Pi coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
framework) that produces structured, citation-backed reports from **live SEC EDGAR
and Yahoo Finance data** — no browser, no web scraping, no made-up numbers.

Each report is a drop-in Markdown "skill" invoked as a slash command (`/moat`,
`/valuation NVDA`, …). The agent gathers real data with typed tools before writing.

## Requirements

- **Node.js 18+** (uses the built-in global `fetch`)
- An **Anthropic** or **OpenAI** API key for the agent model
  - No key is needed for the *data* — EDGAR and Yahoo Finance are used without auth.

## Install & build

```bash
git clone git@github.com:vsambaraju/stock-analyzer-cli.git
cd stock-analyzer-cli
npm install
npm run build      # compiles TS to dist/ and copies the skills
```

> `dist/` is git-ignored (build output), so build once after cloning. The `bin`
> entry (`stock-analyze`) points at `dist/cli.js`.

Optionally link the `stock-analyze` command onto your PATH:

```bash
npm link           # then run `stock-analyze` from anywhere
```

## API key setup

The CLI resolves credentials in this order:

1. Environment variables (see the provider table below) or Pi's `~/.pi/agent/auth.json`
2. A saved config at `~/.stock-analyzer/config.json` (owner-only, `0600`) — Anthropic/OpenAI
3. An **interactive first-run wizard** (only if *no* provider is configured) that
   prompts for an Anthropic or OpenAI key and saves it securely

Keys are never written into the project directory and never committed.

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or just run the CLI and follow the prompt
```

## Providers & models

Any provider Pi supports works here — set its API key and it's available. Common ones:

| Provider | `--provider` | Env var |
|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Google Gemini | `google` | `GEMINI_API_KEY` |
| xAI (Grok) | `xai` | `XAI_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Azure OpenAI Responses | `azure-openai-responses` | `AZURE_OPENAI_API_KEY` (+ `AZURE_OPENAI_BASE_URL`) |
| Amazon Bedrock | `amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK` or AWS profile/IAM |

With no flags, the CLI **auto-selects** the first configured provider (priority:
anthropic → openai → google → xai → deepseek → openrouter → azure → bedrock) and a
sensible default model for it. Override at launch or switch live:

```bash
stock-analyze --provider google TSLA      # use Gemini
stock-analyze --model grok-4.5 NVDA moat  # a specific model
stock-analyze --list-models               # list configured providers + their models
```

Inside a session, `/model` lists models across your configured providers and switches
live; `/model <query>` filters (e.g. `/model gemini`) or matches an id directly
(`/model gpt-4o`). The active model is shown in the header and in `/help`.

## Usage

```bash
# interactive session (prompts for a ticker, runs the default report)
npm run dev                 # dev mode (tsx, no build needed)
stock-analyze               # after `npm run build && npm link`

# pass a ticker (and optional starting report) as arguments
stock-analyze AAPL
stock-analyze NVDA moat
```

Inside a session:

| Command | Action |
|---|---|
| `/<report> [TICKER]` | Run a report on the current stock, or on `TICKER` if given |
| `/new [TICKER]` | Switch to a different stock |
| `/model [query]` | List/switch the AI model across configured providers |
| `/help` | List all reports and controls |
| `/exit` | Quit |
| *(anything else)* | A free-form follow-up question, answered with the tools + prior reports |

After every report or follow-up, a dim footer shows what that prompt cost, e.g.:

```
  ⛁ /business NOW: 23,000 new (17,786 in · 5,214 out) + 53,376 cached · 6 tool calls · $0.0810   ·   session 76,376 total · $0.0810
```

### Token & cost accounting

A report isn't one model call — it's an **agentic loop**: the model calls several
tools (financials, filings, price history…) and is re-invoked after each result,
re-sending the growing conversation each time. The footer splits that into:

- **new** = fresh input + output — the tokens billed at (near) full price.
- **cached** = the shared prefix (system prompt + skill + earlier tool results)
  re-read on each loop step. Providers cache this automatically and bill it at a
  steep discount (OpenAI reports it as cache reads with **no** cache-write charge,
  so cache-write is 0; Anthropic bills writes separately).
- **tool calls** = how many tool rounds ran — the main reason the cached figure grows.

So a large total is usually mostly *cached* re-reads, not new work — which is why
the cost stays low (the example above is 76k tokens but only **$0.08**, because ~70%
was cached). The biggest driver of *new* input is SEC filing text (`get_filing_section`).

Switching stocks (`/new`) or quitting prints the session's cumulative total. The
line is omitted if the model runtime doesn't report usage.

## Reports (skills)

| Command | Aliases | What it does |
|---|---|---|
| `/business` | `biz`, `business_analysis` | Full business-model breakdown (what it does, how it earns, customers, geography, pricing power, cyclicality) |
| `/moat` | `moat_analysis` | Competitive-moat assessment across five sources, with a deterministic 0–10 score |
| `/risk` | `risks`, `risk_analysis` | Risk factors & red flags (concentration, disruption, outside forces, competition) |
| `/valuation` | `value`, `val` | Phase-appropriate valuation multiples and what to ignore |
| `/metrics` | `key_metrics` | Red/Yellow/Green scorecard of the metrics that matter for the company's phase |
| `/longterm` | `lt`, `long_term_potential` | Long-term growth-driver analysis (7-driver framework) |
| `/sentiment` | `price` | Price-action & market-signal read over the past year |
| `/phase` | `business_phase_analysis` | Lifecycle-phase classification (1–5) |
| `/saas` | `ai`, `apocalypse` | AI-disruption resistance score (four-lens framework) |

### Business-lifecycle phases

`/phase`, `/valuation`, and `/metrics` all share one **deterministic classifier**
(`get_business_phase`), computed once per ticker per session so the three reports
can never disagree:

1. 🌱 **Startup** — operating losses widening
2. 🚀 **Hypergrowth** — operating losses narrowing
3. ⚖️ **Self-Funding / Operating Leverage** — breakeven-to-profitable, growing, reinvesting
4. 🎁 **Capital Return** — profitable, growing, returning capital (dividends/buybacks)
5. 📉 **Decline** — breakeven-or-profitable with shrinking revenue

Capital returns are the last tiebreak, so a still-growing dividend-payer stays in
its growth phase rather than being misread as mature.

## How it works

- **`src/tools/`** — typed data tools the agent calls:
  - `market.ts` — Yahoo Finance price data/history, SEC XBRL financials & history,
    and the `get_business_phase` classifier
  - `filings.ts` / `edgar.ts` — SEC EDGAR filing lookup and section extraction
    (10-K/10-Q Item 1, 1A, 7, 7A)
- **`src/skills/*.md`** — the report protocols. Each file has a small frontmatter
  block (`name`, `order`, `aliases`, `description`, optional `kickoffHint`) and a
  prompt body. **Drop a new `.md` file here and it becomes a `/command`
  automatically** — no code changes required.
- **`src/extension.ts`** — registers the tools with the Pi agent.
- **`src/cli.ts`** — the interactive session, argument parsing, and system prompt.

### Data & limitations

- Financials come from SEC EDGAR **XBRL companyfacts**; filing text from EDGAR
  document archives; prices from the Yahoo Finance v8 chart API.
- Analyst ratings/targets, news, social sentiment, and peer lists require a paid
  market-data key and are **not** available — the affected reports say so rather
  than inventing data.
- Nothing here is investment advice; reports are research framing, not buy/sell calls.

## Development

```bash
npm run dev      # run from source with tsx
npm run build    # tsc + copy skills into dist/
npm start        # run the built CLI (node dist/cli.js)
```

## License

No license file is included; all rights reserved unless you add one.

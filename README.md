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

The CLI resolves a model key in this order:

1. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` environment variables
2. A saved config at `~/.stock-analyzer/config.json` (owner-only, `0600`)
3. An **interactive first-run wizard** that prompts for a key, verifies it, and
   saves it securely

Keys are never written into the project directory and never committed.

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or just run the CLI and follow the prompt
```

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
| `/help` | List all reports and controls |
| `/exit` | Quit |
| *(anything else)* | A free-form follow-up question, answered with the tools + prior reports |

After every report or follow-up, a dim footer shows the tokens that prompt burned
(input / output / cache read+write) plus the running session total and cost, e.g.:

```
  ⛁ /moat AAPL: 45,231 tokens (in 38,120 · out 3,411 · cache r3,500/w200) · $0.1234   ·   session: 45,231 tokens · $0.1234
```

Switching stocks (`/new`) or quitting prints the session's cumulative total. (The
line is omitted if the model runtime doesn't report usage.)

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

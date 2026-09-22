# stock-analyzer-cli

An interactive equity-research CLI. It runs an AI agent (on the
[Pi coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
framework) that produces structured, citation-backed reports from **live SEC EDGAR and
Yahoo Finance data** — every figure is fetched through a typed tool before the model
writes, so nothing in a report is recalled from memory.

Each report is a drop-in Markdown "skill" invoked as a slash command: `/moat NVDA`,
`/decide AAPL`.

> ### Disclaimer
>
> **This is a research tool, not investment advice.** Reports are analytical framing,
> not buy/sell recommendations, and no output should be relied on for a financial
> decision.
>
> **Data sources.** Filings and financials come from SEC EDGAR, the authoritative
> source. Prices and analyst consensus come from Yahoo Finance endpoints that are
> **unofficial and undocumented** — Yahoo retired its public finance API in 2017. These
> endpoints are not licensed for this use, are accessed contrary to
> [Yahoo's Terms of Service](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html),
> and may change or break without notice. Use this for **personal research only**; do
> not build a commercial product or a hosted service on the Yahoo-backed tools.
>
> **Consensus is opinion.** Analyst estimates, price targets, ratings and the earnings
> calendar are third-party opinion, not filed fact, and are labelled as such in every
> report. `/story` and `/moat` read only SEC data.
>
> Provided "as is", without warranty of any kind — see [LICENSE](LICENSE).

## Requirements

- **Node.js 22.19+**, required by the Pi agent framework. On older Node, `npm` silently
  resolves Pi to its `legacy-node20` tag instead of failing, so check `node --version`
  first.
- **An API key for the agent model** — Anthropic, OpenAI, Google, xAI, DeepSeek or
  OpenRouter. No key is needed for the *data*: EDGAR and Yahoo are used without auth.
- **A contact address for SEC EDGAR**, which its fair-access policy requires on every
  request. The CLI asks once on first run; as a Pi package, set
  `SEC_USER_AGENT="Your Name you@example.com"`.

## Install

Two ways to run this, with the same reports and the same data tools either way.

### As a standalone CLI

```bash
npm install -g stock-analyzer-cli
stock-analyze                 # interactive session
stock-analyze NVDA moat       # straight into a report
```

### Inside Pi

If you already use [pi](https://pi.dev), this is the shortest path — pi supplies the
model, key management and session loop, so there is nothing to configure:

```bash
pi install npm:stock-analyzer-cli
pi -e npm:stock-analyzer-cli     # or try it once, without installing
```

Every report is then a slash command in your pi session, aliases included.

### From source

```bash
git clone git@github.com:vsambaraju/stock-analyzer-cli.git
cd stock-analyzer-cli
npm install                   # also builds, via the prepare script
npm link                      # optional: puts `stock-analyze` on your PATH
```

`dist/` is git-ignored build output; `npm run build` rebuilds it after editing sources.

## API keys

Credentials resolve in this order:

1. Environment variables (table below), or Pi's `~/.pi/agent/auth.json`
2. `~/.stock-analyzer/config.json` (owner-only, `0600`)
3. An interactive first-run wizard, only if no provider is configured

Keys are never written into the project directory and never committed.

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

With no flags the CLI auto-selects the first configured provider (anthropic → openai →
google → xai → deepseek → openrouter → azure → bedrock) and a sensible default model:

```bash
stock-analyze --provider google TSLA      # use Gemini
stock-analyze --model grok-4.5 NVDA moat  # a specific model
stock-analyze --list-models               # configured providers + their models
```

Inside a session, `/model` lists and switches models live; `/model <query>` filters
(`/model gemini`) or matches an id directly (`/model gpt-4o`).

## Usage

| Command | Action |
|---|---|
| `/<report> [TICKER]` | Run a report on the current stock, or on `TICKER` if given |
| `/moat [TICKER] [PEER…]` | Durability report, peer-checked against companies you name |
| `/new [TICKER]` | Switch to a different stock |
| `/model [query]` | List/switch the AI model across configured providers |
| `/help` | List all reports and controls |
| `/exit` | Quit |
| *(anything else)* | A free-form follow-up, answered with the tools + prior reports |

A dim footer after each turn reports token usage and tool-call count for that prompt,
and the session total on `/new` or exit. It is omitted if the model runtime doesn't
report usage.

## Reports

Five reports, ordered as a research pass. Every report name you may have used before
survives as an alias pointing at whichever report now owns it.

| Command | Aliases | What it does |
|---|---|---|
| `/story` | `business`, `biz`, `longterm`, `lt`, `growth`, `tam` | What the business is, where growth comes from, and whether its markets are expanding |
| `/moat` | `durability`, `risk`, `saas`, `ai`, `compete`, `peers` | Moat size **and** direction as a pair, the four threats to it, and an optional peer check |
| `/numbers` | `phase`, `metrics`, `scorecard` | Lifecycle phase (1–5) plus the Red/Yellow/Green scorecard for *that* phase |
| `/earnings` | `quarter`, `results`, `print`, `catalysts`, `events` | The latest print, what management guided, and the near-term calendar |
| `/decide` | `qst`, `valuation`, `value`, `sentiment`, `price`, `timing` | **Quality · Size · Timing** — the verdict, carrying the full valuation and the stage read |

Run them in that order — what it is, whether it lasts, whether it's executing, what
just happened, then the verdict. `/decide` is the only one that answers whether to own
it; `/earnings` is the one built for quarterly re-runs on a name you already know.

📖 **[docs/reports.md](docs/reports.md)** — what each report does and why: the shared
moat rubric, the three questions, the four-stage technical read, the lifecycle
classifier, and how peers and TAM are handled.

## How it works

- **`src/tools/`** — the typed data tools the agent calls:
  - `market.ts` — Yahoo price data/history, the weekly four-stage `get_technical_stage`
    read, SEC XBRL financials, and the `get_business_phase` classifier
  - `filings.ts` / `edgar.ts` — EDGAR filing lookup, section extraction (10-K/10-Q
    Item 1, 1A, 7, 7A), the decoded 8-K event log, identity and rate limiting
  - `estimates.ts` — Yahoo consensus, earnings calendar, 90-day estimate revisions
  - `segments.ts` — per-segment revenue and operating income, plus peer comparison
  - `guidance.ts` — guidance and quarterly segment highlights from the 8-K item 2.02
    earnings release
- **`src/skills/*.md`** — the report protocols. Frontmatter (`name`, `order`,
  `aliases`, `description`, optional `kickoffHint` and `args`) plus a prompt body.
  **Drop a new `.md` file here and it becomes a `/command`** — no code changes needed.
- **`src/skills-shared/*.md`** — partials pulled into more than one report by a
  `{{include: moat-rubric.md}}` line. `moat-rubric.md` holds the moat and threat
  criteria that **both** `/moat` and `/decide` score against — one copy, included
  verbatim, so the two reports cannot rate the same filings differently. Edit the
  rubric here and nowhere else. These live outside `src/skills/` because Pi turns every
  `.md` under that directory into a command of its own, and a partial is not a command.
- **`src/extension.ts`** — registers the tools with the Pi agent.
- **`src/cli.ts`** — the interactive session, argument parsing, and system prompt.

🔌 **[docs/data-sources.md](docs/data-sources.md)** — where each figure comes from and
what these sources cannot do: the SEC identity requirement, why segment data can't come
from companyfacts, how guidance is read out of an 8-K exhibit, why trailing multiples
differ from a quote site, and what is deliberately unavailable.

## Development

```bash
npm run dev      # run from source with tsx
npm run build    # tsc, then expand skill includes and chmod the CLI
npm start        # run the built CLI (node dist/cli.js)
```

Both entry points share everything that matters: `src/extension.ts` registers the data
tools, `src/skills/*.md` holds the report protocols, and `buildReportMessage()` in
`src/commands.ts` composes the prompt for both, so a report reads the same either way.

`src/pi-aliases.ts` is the one file that is **not** shared. It registers each skill's
`aliases:` as slash commands, because Pi ignores unknown frontmatter fields. It is
referenced only by the `pi` manifest in `package.json` — never from `cli.ts`, which
resolves aliases through its own lookup table. Loading it in both places would register
two competing handlers for every alias.

> Skill frontmatter must be **valid YAML**. Pi parses it with a real YAML parser and
> silently skips any skill whose frontmatter fails to parse, so values with special
> characters need quoting — e.g. `args: "[TICKER] [PEER ...]"`.

## License

[MIT](LICENSE) © Venkat Sambaraju

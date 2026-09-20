# stock-analyzer-cli

An AI-powered, interactive stock-analysis CLI. It runs an equity-research agent
(via the [Pi coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
framework) that produces structured, citation-backed reports from **live SEC EDGAR
and Yahoo Finance data** — every figure is fetched through a typed tool before the
model writes, so nothing in a report is recalled from memory.

Each report is a drop-in Markdown "skill" invoked as a slash command (`/moat`,
`/decide NVDA`, …). The agent gathers real data with typed tools before writing.

> ### Disclaimer
>
> **This is a research tool, not investment advice.** Reports are analytical
> framing, not buy/sell recommendations. Nothing here is a solicitation to trade,
> and no output should be relied on for a financial decision.
>
> **Data sources.** Filings and financials come from SEC EDGAR, the authoritative
> source. Prices and analyst consensus come from Yahoo Finance endpoints that are
> **unofficial and undocumented** — Yahoo retired its public finance API in 2017.
> These endpoints are not licensed for this use, are accessed contrary to
> [Yahoo's Terms of Service](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html),
> and may change, rate-limit, or break without notice. Use this for **personal
> research only**; do not build a commercial product or a hosted service on the
> Yahoo-backed tools.
>
> **Consensus is opinion.** Analyst estimates, price targets, ratings and the
> earnings calendar are third-party opinion, not filed fact, and are labelled as
> such in every report. `/story` and `/moat` read only SEC data and do not touch
> Yahoo consensus at all; `/numbers`, `/earnings` and `/decide` each use it, always
> labelled and with the analyst count.
>
> Provided "as is", without warranty of any kind — see [LICENSE](LICENSE).

## Requirements

- **Node.js 22.19+** — required by the Pi agent framework. On older Node, `npm`
  silently resolves Pi to its `legacy-node20` tag (an old release) instead of
  failing, so check with `node --version` before installing.
- An API key for the agent model — Anthropic, OpenAI, Google, xAI, DeepSeek, or
  OpenRouter.
  - No key is needed for the *data* — EDGAR and Yahoo Finance are used without auth.
- A **contact address for SEC EDGAR**, which its fair-access policy requires on
  every request. The CLI asks once on first run; as a Pi package, set
  `SEC_USER_AGENT="Your Name you@example.com"`.

## Install

There are two ways to run this: as a standalone CLI, or as a package inside
[pi](https://pi.dev). Both expose the same reports and the same data tools.

### As a Pi package

If you already use pi, this is the shortest path — pi supplies the model,
key management, and session loop, so there is nothing to configure:

```bash
pi install npm:stock-analyzer-cli     # or: pi install git:github.com/vsambaraju/stock-analyzer-cli
```

To try it once without installing anything:

```bash
pi -e git:github.com/vsambaraju/stock-analyzer-cli
```

Every report is then a slash command in your pi session — `/moat NVDA`,
`/decide AAPL`, and so on, aliases included.

### As a standalone CLI

```bash
git clone git@github.com:vsambaraju/stock-analyzer-cli.git
cd stock-analyzer-cli
npm install        # also builds, via the prepare script
```

> `dist/` is git-ignored (build output). `npm install` builds it for you; run
> `npm run build` by hand after editing sources. The `bin` entry
> (`stock-analyze`) points at `dist/cli.js`.

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
| `/moat [TICKER] [PEER…]` | Durability report, peer-checked against companies you name |
| `/new [TICKER]` | Switch to a different stock |
| `/model [query]` | List/switch the AI model across configured providers |
| `/help` | List all reports and controls |
| `/exit` | Quit |
| *(anything else)* | A free-form follow-up question, answered with the tools + prior reports |

After every report or follow-up, a dim footer shows what that prompt cost, e.g.:

```
  ⛁ /story NOW: 23,000 new (17,786 in · 5,214 out) + 53,376 cached · 6 tool calls · $0.0810   ·   session 76,376 total · $0.0810
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

Five reports, ordered as a research pass. Each runs end to end; every name you may
have used before survives as an alias pointing at the report that now owns it.

| Command | Aliases | What it does |
|---|---|---|
| `/story` | `business`, `biz`, `longterm`, `lt`, `growth`, `tam` | What the business is, where growth comes from, and whether its markets are expanding |
| `/moat` | `durability`, `risk`, `saas`, `ai`, `compete`, `peers` | Moat size **and** direction as a pair, the four threats to it, and an optional peer check |
| `/numbers` | `phase`, `metrics`, `scorecard` | Lifecycle phase (1–5) plus the Red/Yellow/Green scorecard for *that* phase |
| `/earnings` | `quarter`, `results`, `print`, `catalysts`, `events` | The latest print, what management guided, and the near-term calendar |
| `/decide` | `qst`, `valuation`, `value`, `sentiment`, `price`, `timing` | **Quality · Size · Timing** — the verdict, carrying the full valuation and the stage read |

The intended order is `/story` → `/moat` → `/numbers` → `/earnings` → `/decide`:
establish what it is, whether it lasts, whether it's executing, what just happened,
then compose the verdict. `/decide` is the only one that answers whether to own it.

`/earnings` is the one built for repeat use — it's what you run each quarter on a
name you've already researched, and it needs none of the others.

### Comparing against peers

`/moat` is the one report that takes more than a ticker — the companies to
compare against come after it, and the peer check is a section of the durability
report rather than a report of its own, because relative segment growth is the best
available evidence for moat *direction*:

```
/moat NVDA AMD AVGO      # durability report on NVDA, peer-checked against AMD and AVGO
/moat NVDA               # durability report with the peer section omitted
```

Up to four peers; each one costs a full data fetch, so this is the most expensive
report here. **Peer discovery is deliberately absent.** There is no free source
that survives contact with reality — SIC codes lump unrelated businesses together,
and "customers also watch" lists return whatever else the same retail investors
hold (for NVIDIA: Tesla, Amazon, Apple, Meta). Rather than dress a bad list up as
analysis, the report compares exactly who you name and says so.

Segment names are each filer's own and are **not** a shared taxonomy — Microsoft's
"Intelligent Cloud" and Amazon's "AWS" are different disclosure boundaries, and
fiscal years differ between companies. The report compares growth *rates* and
flags mismatches rather than pretending the segments line up.

### TAM, honestly

`/story` answers "is the market growing?" without a market-research source, so
it reports a **direction**, never a size. It will not print a "$400B TAM" figure
unless that number is literally quoted from a filing. Each piece of evidence is
tagged:

- `[REVEALED]` — per-segment revenue growth. Filed fact, weighted heaviest.
- `[CLAIMED]` — the company's own market language from Item 1 / MD&A.
- `[EXPECTED]` — forward consensus. Analyst opinion, subject to revision.

When those three disagree — a company claiming an expanding market while its
segments decelerate — the report leads with the disagreement instead of smoothing
it over.

### The three questions

`/decide` is the only report that composes the others, and it enforces an ordering
rather than producing a score:

| Question | Asks | Answered by | The answer's shape |
|---|---|---|---|
| **Quality** | Does it belong in the universe at all? | Moat **size and direction**, scored as a pair, plus the fragile/robust/antifragile character | Widen-watch, or Pass |
| **Size** | How much of the portfolio does it earn? | Valuation — trailing multiples, consensus, and `get_reverse_dcf` | A **position type**: Watch / Starter / Anchor |
| **Timing** | Is now the moment? | `get_technical_stage` — the four-stage cycle | Hold / observe / buy the breakout / trim |

**Size means position size, not price.** The middle question is not "is it cheap
enough to buy" but "given what the price already assumes, how much of this do I
own." The answer is a position type; the theme-level cap is left as a number you
write down, since this CLI cannot see your portfolio and an unspecified cap is not
a constraint.

Three properties make it different from running the reports separately:

- **The questions are a conjunction, never an average.** A Pass on Quality ends
  the report — no position type, no stage. A Stage 2 chart on a business that
  failed the moat test is not a buy signal.
- **Moat size and direction are never summed.** A Wide/Narrowing name and a
  Narrow/Stable name both total the same and are nothing alike.
- **The moat read feeds the valuation.** The Quality verdict sets the terminal
  growth rate passed to `get_reverse_dcf` — 3% for a wide or widening moat, 2% for
  narrow and stable — which is the reason for answering the questions in order.

### Technical stage — the Timing question

`get_technical_stage` reads a **weekly** chart with a **40-week SMA**, which is a
different question from the daily 50/200-day averages `get_price_history` returns:

1. **The direction of the SMA** narrows a stock to two stages — rising → 2
   (advancing), falling → 4 (declining), flat → 1 or 3.
2. **What came before** separates the two flat cases: flat after a decline is
   Stage 1 (basing), flat after an advance is Stage 3 (topping).
3. **Support and resistance** are built from weekly swing pivots, clustered into
   bands and graded by touch count (1 weak · 3 average · 5+ strong).

The tool returns the decision rule for each stage verbatim, so the model renders
it rather than inventing one. Three deliberate refusals: it reports `stage: null`
when the SMA is flat *and* was flat before — nothing separates Stage 1 from Stage 3
in that case — it declines entirely for companies with under 40 weeks of trading
history, and it drops price bands far below the current price, which are history
rather than support. The NASDAQ Composite gets the same read as market context,
explicitly for conviction and sizing rather than as an override.

Stages are only cleanly identifiable in hindsight; in real time a flattening SMA
may be Stage 3 or a pause inside Stage 2. Every decision rule is hold, add, or
trim, and none demands a full exit on the chart alone.

### Business-lifecycle phases

`/numbers` and `/decide` share one **deterministic classifier**
(`get_business_phase`), computed once per ticker per session so the two reports
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
  - `market.ts` — Yahoo Finance price data/history, the weekly four-stage
    `get_technical_stage` read, SEC XBRL financials & history, and the
    `get_business_phase` classifier
  - `filings.ts` / `edgar.ts` — SEC EDGAR filing lookup, section extraction
    (10-K/10-Q Item 1, 1A, 7, 7A), and the decoded 8-K event log
  - `estimates.ts` — Yahoo consensus estimates, the earnings calendar, and
    90-day estimate revisions (opinion, labelled as such everywhere)
  - `segments.ts` — per-segment revenue and operating income, plus peer comparison
  - `guidance.ts` — company-issued forward guidance **and** quarterly segment
    highlights, read out of the earnings press release (the EX-99 exhibits of an
    8-K carrying item 2.02)
- **`src/skills/*.md`** — the report protocols. Each file has a small frontmatter
  block (`name`, `order`, `aliases`, `description`, optional `kickoffHint`, and
  optional `args` for reports taking extra tickers) and a prompt body. **Drop a new
  `.md` file here and it becomes a `/command` automatically** — no code changes
  required.
- **`src/skills-shared/*.md`** — partials included by more than one report, via a
  `{{include: moat-rubric.md}}` line. `moat-rubric.md` holds the moat-size,
  moat-direction and threat criteria that **both** `/moat` and `/decide` score
  against: one copy, included verbatim, so the two reports cannot rate the same
  filings differently. Edit the rubric here and nowhere else. These files live
  outside `src/skills/` on purpose — Pi turns every `.md` under that directory into
  a command of its own, and a partial is not a command.
- **`src/extension.ts`** — registers the tools with the Pi agent.
- **`src/cli.ts`** — the interactive session, argument parsing, and system prompt.

### Data & limitations

- Financials come from SEC EDGAR **XBRL companyfacts**; filing text from EDGAR
  document archives; prices from the Yahoo Finance v8 chart API.
- **Segment data does not come from companyfacts** — it can't. Segment figures are
  *dimensional* XBRL facts (revenue tagged to a "Data Center" member axis), and the
  companyfacts API publishes only undimensioned totals, so asking it for segment
  revenue silently returns the consolidated number. `get_segment_revenue` instead
  reads the rendered financial-report exhibits (`FilingSummary.xml` → `R*.htm`) that
  SEC generates from the same filed XBRL. Report titles and row structure are
  filer-chosen, so tables are selected by score and parsed by shape; single-segment
  filers degrade to an explicit "unavailable" rather than a guess.
- **Guidance is read from the earnings press release, not from XBRL.** An 8-K carrying
  item 2.02 is the earnings release, and its EX-99.1 exhibit holds the outlook — often
  with exact ranges ("Revenue is expected to be $91.0 billion, plus or minus 2%"). That
  exhibit is *furnished* rather than filed and is exempt from inline XBRL, so there are no
  tagged facts in it; `get_earnings_guidance` therefore reads only the outlook prose and
  leaves the financial tables to companyfacts, which carries the same figures properly
  tagged a few days later. Outlook headings are filer-chosen and the word "outlook" appears
  in nearly every release's boilerplate, so candidate sections are selected by score and by
  heading position rather than matched by name. **Not every company guides in writing** —
  Apple, Microsoft and Costco guide only on the earnings call, and Roku states it provides
  no outlook at all — so the tool reports "no guidance given" explicitly rather than
  inferring that guidance was withdrawn. The same exhibit's **highlights** block is parsed
  separately and grouped under the company's own sub-headings, which is the only place a
  **quarterly** segment split is available ("Data Center segment revenue was $6.7 billion,
  up 107% year-over-year"). The two are kept strictly apart — a highlight is a reported
  result, a guidance item is a forecast — and highlights are flagged as the company's own
  promotional selection of untagged, possibly non-GAAP figures.
- News and social sentiment require a paid market-data key and are **not** available.
  Peer lists are not fetched *by choice* — `/moat` compares only companies you
  name. Analyst estimates, targets and the earnings calendar come from Yahoo's
  quoteSummary endpoint and are labelled **opinion**, never presented as filed fact.
- **SEC requires you to identify yourself.** EDGAR's fair-access policy asks every
  caller to declare a reachable contact address, and caps traffic at ~10 requests/
  second. The CLI prompts for the address once on first run and saves it to
  `~/.stock-analyzer/config.json`; set `SEC_USER_AGENT="Your Name you@example.com"`
  to supply it instead — **required when running as a Pi package**, which has no
  first-run prompt. There is no placeholder default: EDGAR requests refuse to send
  rather than going out unidentified. All EDGAR traffic is paced through one
  process-wide gate at ~8 req/s, so a fan-out like `/moat NVDA AMD AVGO` cannot
  burst past the ceiling.
- **The Yahoo endpoints are unofficial.** Yahoo retired its public finance API in
  2017; `v8/finance/chart` (prices) and `v10/finance/quoteSummary` (consensus) are
  internal endpoints. quoteSummary is additionally defended — it returns
  `401 Invalid Crumb` without a cookie-and-crumb handshake, which `estimates.ts`
  performs. Consensus is also third-party licensed data that Yahoo does not own,
  which is why that endpoint is gated and the price endpoint is not. Expect
  breakage when Yahoo changes the handshake; every failure degrades to
  `available: false` and the report omits the row rather than guessing. See the
  [disclaimer](#disclaimer) — personal research use only.
- Nothing here is investment advice; reports are research framing, not buy/sell calls.

## Development

```bash
npm run dev      # run from source with tsx
npm run build    # tsc, then expand skill includes and chmod the CLI
npm start        # run the built CLI (node dist/cli.js)
```

The two entry points share everything that matters. `src/extension.ts` registers
the data tools and `src/skills/*.md` holds the report protocols; the standalone
CLI (`src/cli.ts`) and the Pi package both load them, and `buildReportMessage()`
in `src/commands.ts` composes the report prompt for both, so a report reads the
same either way.

`src/pi-aliases.ts` is the one file that is **not** shared: it registers the
`aliases:` from each skill's frontmatter as slash commands, because pi ignores
unknown frontmatter fields. It is referenced only by the `pi` manifest in
`package.json` — never from `cli.ts`, which resolves aliases through its own
lookup table in `commands.ts`. Loading it in both places would register two
competing handlers for every alias.

> Skill frontmatter must be **valid YAML**. Pi parses it with a real YAML parser
> and silently skips any skill whose frontmatter fails to parse, so values with
> special characters need quoting — e.g. `args: "[TICKER] [PEER ...]"`.

## License

[MIT](LICENSE) © Venkat Sambaraju

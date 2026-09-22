# The reports, in depth

Five reports, ordered as a research pass. This file covers what each one does and
why it draws the lines it draws. For the short version, see the
[README](../README.md#reports).

The intended order is `/story` → `/moat` → `/numbers` → `/earnings` → `/decide`:
establish what it is, whether it lasts, whether it's executing, what just happened,
then compose the verdict. `/decide` is the only one that answers whether to own it.

`/earnings` is the one built for repeat use — it's what you run each quarter on a
name you've already researched, and it needs none of the others.

## Comparing against peers

`/moat` is the one report that takes more than a ticker. The peer check is a section
of the durability report rather than a report of its own, because relative segment
growth is the best available evidence for moat *direction*:

```bash
/moat NVDA AMD AVGO      # durability report on NVDA, peer-checked against AMD and AVGO
/moat NVDA               # peer section omitted
```

Up to four peers; each costs a full data fetch, so this is the most expensive report
here.

**Peer discovery is deliberately absent.** No free source survives contact with
reality — SIC codes lump unrelated businesses together, and "customers also watch"
lists return whatever else the same retail investors hold (for NVIDIA: Tesla, Amazon,
Apple, Meta). Rather than dress a bad list up as analysis, the report compares exactly
who you name and says so.

Segment names are each filer's own and are **not** a shared taxonomy — Microsoft's
"Intelligent Cloud" and Amazon's "AWS" are different disclosure boundaries, and fiscal
years differ. The report compares growth *rates* and flags mismatches rather than
pretending the segments line up.

## One rubric behind `/moat` and `/decide`

Both reports score moat size, moat direction and threat level, so both read the same
criteria from a single shared file (`src/skills-shared/moat-rubric.md`), included
verbatim into each. That is not tidiness: when each report carried its own copy they
drifted, `/decide` kept the arithmetic but lost the thresholds, and the two reports
scored the same company differently.

Two rules the rubric enforces everywhere:

- **Moat size and direction are never summed.** A Wide/Narrowing name and a
  Narrow/Stable name total the same and are nothing alike. Direction outranks size,
  because a wide moat is *observable* and usually priced already while a widening one
  needs a forecast the market may not have made.
- **Only structural threats can disqualify a business.** AI displacement and
  competition are universe questions. Customer concentration and outside forces
  (regulation, commodities, government budgets) are *sizing* questions — a single
  large customer is a reason to own less, not a reason to own none.

## TAM, honestly

`/story` answers "is the market growing?" without a market-research source, so it
reports a **direction**, never a size. It will not print a "$400B TAM" figure unless
that number is literally quoted from a filing. Each piece of evidence is tagged:

- `[FILED]` — per-segment revenue growth. Tagged SEC fact, weighted heaviest.
- `[SAID]` — the company's own market language from Item 1 / MD&A. Weakest:
  companies describe their markets favourably.
- `[EXPECTED]` — forward consensus. Analyst opinion, subject to revision.

When those disagree — a company claiming an expanding market while its segments
decelerate — the report leads with the disagreement instead of smoothing it over.
`/earnings` uses the same three tags.

## The three questions

`/decide` composes the others, and enforces an ordering rather than producing a score.

| Question | Asks | Answered by | The answer's shape |
|---|---|---|---|
| **Quality** | Does it belong in the universe at all? | Moat **size and direction** as a pair, plus the four threats | Widen-watch, or Pass |
| **Size** | How much of the portfolio does it earn? | Valuation — trailing multiples, consensus, and `get_reverse_dcf` | A **position type**: Watch / Starter / Anchor |
| **Timing** | Is now the moment? | `get_technical_stage` — the weekly four-stage cycle | Hold / observe / buy the breakout / trim |

**Size means position size, not price.** The middle question is not "is it cheap
enough to buy" but "given what the price already assumes, how much of this do I own."
The theme-level cap is left as a number you write down, since this CLI cannot see your
portfolio and an unspecified cap is not a constraint.

Three properties make it different from running the reports separately:

- **The questions are a conjunction, never an average.** A Pass on Quality forces the
  position type to **Watch (0%)** whatever the price and the chart say, and voids the
  stage's decision line. The report still renders Size and Timing — as *measurements,
  not recommendations* — because the discipline is that timing must not rescue a bad
  business, not that the price should be hidden.
- **Moat size and direction are never summed** (see the rubric above).
- **The moat read feeds the valuation.** The Quality verdict sets the terminal growth
  rate passed to `get_reverse_dcf` — 3% for a wide or widening moat, 2% for narrow and
  stable — which is the reason for answering the questions in order.

## Technical stage — the Timing question

`get_technical_stage` reads a **weekly** chart with a **40-week SMA**, a different
question from the daily 50/200-day averages `get_price_history` returns:

1. **The direction of the SMA** narrows a stock to two stages — rising → 2
   (advancing), falling → 4 (declining), flat → 1 or 3.
2. **What came before** separates the flat cases: flat after a decline is Stage 1
   (basing), flat after an advance is Stage 3 (topping).
3. **Support and resistance** are built from weekly swing pivots, clustered into bands
   and graded by touch count (1 weak · 3 average · 5+ strong).

The tool returns the decision rule for each stage verbatim, so the model renders it
rather than inventing one. Three deliberate refusals: it reports `stage: null` when
the SMA is flat *and* was flat before — nothing separates Stage 1 from Stage 3 in that
case; it declines entirely for companies with under 40 weeks of trading history; and
it drops price bands far below the current price, which are history rather than
support. The NASDAQ Composite gets the same read as market context, explicitly for
conviction and sizing rather than as an override.

Stages are only cleanly identifiable in hindsight — in real time a flattening SMA may
be Stage 3 or a pause inside Stage 2. Every decision rule is hold, add, or trim, and
none demands a full exit on the chart alone.

## Business-lifecycle phases

`/numbers` and `/decide` share one **deterministic classifier**
(`get_business_phase`), computed once per ticker per session so the two reports can
never disagree:

1. 🌱 **Startup** — operating losses widening
2. 🚀 **Hypergrowth** — operating losses narrowing
3. ⚖️ **Self-Funding / Operating Leverage** — breakeven-to-profitable, growing, reinvesting
4. 🎁 **Capital Return** — profitable, growing, returning capital (dividends/buybacks)
5. 📉 **Decline** — breakeven-or-profitable with shrinking revenue

Capital returns are the last tiebreak, so a still-growing dividend-payer stays in its
growth phase rather than being misread as mature. `/numbers` then scores a
Red/Yellow/Green scorecard built for *that* phase — a metric that matters in Phase 2
is noise in Phase 4, which is the whole point of scoring by phase.

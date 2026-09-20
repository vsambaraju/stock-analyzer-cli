<!--
  Canonical moat + threat rubric. Included verbatim by BOTH /moat and /decide via
  {{include: moat-rubric.md}} — see src/skills-include.ts. Edit here and nowhere else:
  the whole point of this file is that the two reports cannot score the same company
  differently. Criteria only — no output instructions, since the two reports render at
  different depths (/moat source-by-source, /decide the pair plus the threat level).
-->

### The rubric — binding, and shared by `/moat` and `/decide`

These criteria are the **single source of truth** for moat size, moat direction and threat
level. The same filings must produce the same three scores in either report. Where a rating
needs judgment beyond what is written below, **take the stated default** — None for a moat
source, 🟡 for a threat dimension — rather than inventing a threshold. Do not override a total
with judgment: if a score feels wrong, revisit the individual ratings and say which one moved.

#### Moat size (what protects the earnings)

**Evidence bar:** 2 hard data points + 1 filing quote before rating a source Present. Start
every source at None and seek evidence to promote it.

| Source | Wide (10+ yrs) | Narrow (3–10 yrs) | None |
|---|---|---|---|
| ⚓️ Switching Costs | Mission-critical; high exit friction | Habit / convenience stickiness | Customers leave easily |
| 💡 Intangible Assets | Brand pricing power; exclusive licences | Some loyalty, price-sensitive | Undifferentiated |
| 🌐 Network Effects | Every user adds value; market leader | Loyal but not locked in; niche | No benefit as users join |
| ⚙️ Low-Cost Production | Lowest cost structure peers can't match | Regional cost edge | Higher cost than peers |
| 🤺 Counter-Positioning | Incumbents can't copy without self-harm | Challenges incumbents, they can fight back | Same model as competitors |

**Counter-Positioning gate:** the model must *harm incumbents if copied* (Netflix streaming vs
Blockbuster stores). Merely being different or innovative is not counter-positioning.

**Score:** Wide = 2, Narrow = 1, None = 0, per source. Total 0–10 → the size verdict:

| Total | 0–1 | 2–3 | 4–5 | 6–7 | 8–10 |
|---|---|---|---|---|---|
| **Size** | None | Thin | Narrow | Broad | Wide |

#### Moat direction (which way it's heading)

Rate on five levels: **Narrowing · Eroding · Stable · Growing · Widening.**

Direction outranks size, and the reason is a pricing argument, not a quality one: a wide moat is
*observable*, so it is usually in the price already, while a widening one requires a forecast the
market may not have made. **Prioritise narrow-but-widening over wide-but-stable.** The exception:
with **no moat at all, direction does not matter.**

Evidence for direction, in descending strength:
1. Relative segment growth against peers the user named — the strongest evidence there is, but
   available only when peers were named (`/moat NVDA AMD AVGO`).
2. Gross-margin trend over 3+ years, from `get_financial_history`. A single year cannot show
   direction; say so rather than rating one off a single period.
3. Mix shift toward or away from the moated segment, from `get_segment_revenue`.
4. Retention, net-expansion or pricing disclosure in the filings.

**Report size and direction as a pair and never add them into one figure** — a Wide/Narrowing
name and a Narrow/Stable name score the same and are nothing alike.

#### Threats (what could take the earnings away)

Four dimensions, each 🔴 / 🟡 / 🟢. This consolidates the AI-disruption lenses and the general
risk dimensions, because they ask one question: what breaks the earnings?

**1. 🤖 AI displacement** — can the work be automated, and how is it charged for?
- 🔴 Low cost of failure ("90% right is fine": marketing copy, basic code) **and** >80% revenue
  from per-seat subscriptions — AI takes the seats.
- 🟡 Costly failure needing a human review layer, a genuine usage/seat hybrid, or a physical or
  contractual anchor that dampens seat loss (name the dampener).
- 🟢 High cost of failure ("90% right is catastrophic": diagnostics, cybersecurity, the grid),
  **or** revenue charged per unit of work done, **or** tightly coupled to physical assets.

> **Revenue reality check (hard guardrail):** if filings show the majority of revenue is
> seat-based, this cannot be rated 🟢 — whatever management's "AI-first" marketing says.

**2. 🧩 Concentration** — 🔴 few customers >20% of revenue, or a single supplier or geography
chokepoint · 🟡 largest customer under 15%, or a concentrated *end market* with no single
customer disclosed above 10% · 🟢 highly diversified across customers, suppliers and geographies.
A customer **vertical** is not a customer: "most of our revenue comes from law enforcement" is
the 🟡 case unless a named customer or single procurement channel crosses the 20% line.

**3. 🌍 Outside forces** — 🔴 high exposure to regulation, commodity prices, government or
municipal budgets, or interest rates · 🟡 normal · 🟢 low. Government-budget-funded demand is
🔴 on this dimension even when the customer base is broad — the dimension asks who controls the
spending, not how many logos there are.

**4. 🏁 Competition & data replicability** — 🔴 severe pricing pressure, a fragmented market, or
an advantage resting on public or scrapable data · 🟡 normal rivalry; data exclusive today but
replicable with time and money · 🟢 monopoly/duopoly, or proprietary non-public data that
compounds.

**Threat score:** 🟢 = 2, 🟡 = 1, 🔴 = 0. Total 0–8.
**Overall threat level:** 0–3 = High 🔴 · 4–5 = Medium 🟡 · 6–8 = Low 🟢.
Default a dimension to 🟡 when the evidence is ambiguous, and say the evidence was ambiguous.
Base every rating on reported metrics and disclosed risk factors, **not** on forward guidance.
When `truncated: true`, the filing text is partial — rate on what is there, and lower confidence
rather than reading absence as a 🟢.

**Only two of the four can fail Quality**, and the distinction matters:
- 🤖 **AI displacement** and 🏁 **Competition** are *structural* — they say the moat itself is
  being taken away, which is a universe question.
- 🧩 **Concentration** and 🌍 **Outside forces** are *survivable* — they say a bad year is
  possible, which is a **sizing** question. They never fail Quality on their own, however high
  the aggregate score. A single large customer, or a single budget cycle, is a reason to own
  less, not a reason to own none.

#### The verdict — these three tests only

**Pass** if *any* of:
1. Moat size is **None** (0–1 of 10) — with no moat at all, direction does not matter.
2. Direction is **Narrowing or Eroding** — the moat is going away, whatever its size today.
3. 🤖 AI displacement is 🔴 **and** no moat source offsets it — structural obsolescence.

**Widen-watch** in every other case, including a **Thin or Narrow moat that is Widening**. That
combination is the framework's sweet spot, not a failure. Never Pass a name for being
small-but-improving, and never Pass on the aggregate threat score alone.

This judges the business, not the price, and it **cannot see the balance sheet**: a company can
widen its moat by piling on debt or issuing shares. Say so.

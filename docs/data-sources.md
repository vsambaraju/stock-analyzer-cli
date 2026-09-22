# Where the data comes from, and what it can't do

Financials come from SEC EDGAR **XBRL companyfacts**; filing text from the EDGAR
document archives; prices from the Yahoo Finance v8 chart API. The awkward cases are
below, because each one shapes what a report is allowed to claim.

## SEC requires you to identify yourself

EDGAR's fair-access policy asks every caller to declare a reachable contact address,
and caps traffic at roughly 10 requests/second.

The CLI prompts for the address once on first run and saves it to
`~/.stock-analyzer/config.json`. Set `SEC_USER_AGENT="Your Name you@example.com"` to
supply it instead — **required when running as a Pi package**, which has no first-run
prompt. There is no placeholder default: requests refuse to send rather than go out
unidentified, since shipping one would put every user's traffic on SEC under the same
non-compliant string. All EDGAR traffic is paced through one process-wide gate at
~8 req/s, so a fan-out like `/moat NVDA AMD AVGO` cannot burst past the ceiling.

## Segment data does not come from companyfacts — it can't

Segment figures are *dimensional* XBRL facts (revenue tagged to a "Data Center" member
axis), and the companyfacts API publishes only undimensioned totals, so asking it for
segment revenue silently returns the consolidated number.

`get_segment_revenue` instead reads the rendered financial-report exhibits
(`FilingSummary.xml` → `R*.htm`) that SEC generates from the same filed XBRL. Report
titles and row structure are filer-chosen, so tables are selected by score and parsed
by shape; single-segment filers degrade to an explicit "unavailable" rather than a
guess. This source is **annual** — the only quarterly segment split available is the
one in the earnings release, below.

## Guidance is read from the earnings press release, not from XBRL

An 8-K carrying item 2.02 is the earnings release, and its EX-99.1 exhibit holds the
outlook — often with exact ranges ("Revenue is expected to be $91.0 billion, plus or
minus 2%"). That exhibit is *furnished* rather than filed and is exempt from inline
XBRL, so there are no tagged facts in it. `get_earnings_guidance` therefore reads only
the outlook prose and leaves the financial tables to companyfacts, which carries the
same figures properly tagged a few days later.

Outlook headings are filer-chosen, and the word "outlook" appears in nearly every
release's boilerplate, so candidate sections are selected by score and heading position
rather than matched by name.

**Not every company guides in writing.** Apple, Microsoft and Costco guide only on the
earnings call; Roku states it provides no outlook at all. The tool reports "no guidance
given" explicitly rather than inferring that guidance was withdrawn — a materially
different and far more alarming claim.

The same exhibit's **highlights** block is parsed separately and grouped under the
company's own sub-headings, which is the only place a **quarterly** segment split is
available ("Data Center segment revenue was $6.7 billion, up 107% year-over-year"). The
two are kept strictly apart — a highlight is a reported result, a guidance item is a
forecast — and highlights are flagged as the company's own promotional selection of
untagged, possibly non-GAAP figures.

## Trailing figures are filed figures

The multiples in `get_price_data` are computed from tagged XBRL, so a quarter that has
been *announced* but has not yet reached a 10-Q is not in them. Every report states
`ttm_period_end` for that reason: a quote site's P/E will differ when a company has
reported since its last periodic filing, and neither number is wrong.

TTM is assembled from four contiguous quarters where they exist, and otherwise from
`annual + year-to-date − prior-year year-to-date`. Both paths verify that the window
actually spans ~12 months and ends recently, because a filer changing tags mid-history
(`NetIncomeLoss` → `ProfitLoss`) or skipping a fiscal Q4 frame will otherwise produce a
window that silently reaches back years.

## The Yahoo endpoints are unofficial

Yahoo retired its public finance API in 2017. `v8/finance/chart` (prices) and
`v10/finance/quoteSummary` (consensus) are internal endpoints.

quoteSummary is additionally defended — it returns `401 Invalid Crumb` without a
cookie-and-crumb handshake, which `estimates.ts` performs. Consensus is third-party
licensed data that Yahoo does not own, which is why that endpoint is gated and the
price endpoint is not. Expect breakage when Yahoo changes the handshake; every failure
degrades to `available: false` and the report omits the row rather than guessing.

See the [disclaimer](../README.md#disclaimer) — personal research use only.

## What is deliberately unavailable

- **News and social sentiment.** These require a paid market-data key. No tool carries
  them, so no report may cite a headline or a sentiment score.
- **Peer lists.** Not fetched by choice — `/moat` compares only companies you name.
- **Market share.** Segment disclosure cannot establish it; reports say "not
  determinable" rather than estimating.
- **Revenue surprise.** `eps_surprise_history` is EPS-only, and no tool carries the
  revenue consensus that stood *before* a print, so reports never claim a revenue
  beat.

Analyst estimates, price targets, ratings and the earnings calendar come from Yahoo's
quoteSummary endpoint and are labelled **opinion** wherever they appear, never
presented as filed fact.

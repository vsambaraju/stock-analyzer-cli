/**
 * Pi extension — registers all stock analysis tools with the agent.
 * Loaded via DefaultResourceLoader.extensionFactories in cli.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  getFinancials,
  getFinancialHistory,
  getPriceData,
  getPriceHistory,
  getAnalystSentiment,
  getCompetitors,
  getBusinessPhase,
  getReverseDcf,
} from "./tools/market.js";
import { getBusinessDescription, getFilingSection, getRecentFilings } from "./tools/filings.js";
import { getForwardEstimates } from "./tools/estimates.js";

const tickerParam = Type.Object({
  ticker: Type.String({ description: "Stock ticker symbol, e.g. AAPL" }),
});

const financialsTool = defineTool({
  name: "get_financials",
  label: "Get Financials",
  description:
    "Fetch TTM revenue, revenue growth, gross margin, operating margin, FCF margin, and Rule of 40 for a stock ticker via Yahoo Finance.",
  promptSnippet: "get_financials(ticker) — revenue, margins, growth, Rule of 40",
  parameters: tickerParam,
  async execute(_id, params) {
    const result = await getFinancials(params.ticker);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

const priceDataTool = defineTool({
  name: "get_price_data",
  label: "Get Price Data",
  description:
    "Fetch current price, market cap, 52-week range, valuation ratios (P/E, P/S, EV/Revenue), and analyst target price for a ticker.",
  promptSnippet: "get_price_data(ticker) — price, market cap, P/E, P/S, analyst targets",
  parameters: tickerParam,
  async execute(_id, params) {
    const result = await getPriceData(params.ticker);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

const financialHistoryTool = defineTool({
  name: "get_financial_history",
  label: "Get Financial History",
  description:
    "Fetch multi-period financial history from SEC EDGAR XBRL: up to 12 quarters and 5 fiscal years of revenue, gross profit, operating income, net income, operating cash flow, capex, FCF, R&D and S&M spend, with per-period margins and year-over-year growth, plus a quarterly balance sheet series (cash, investments, assets, liabilities, equity, debt, share count). Use this for any trend, phase classification, or multi-year comparison.",
  promptSnippet:
    "get_financial_history(ticker) — 12 quarters + 5 years of income, cash flow, balance sheet with margins and YoY growth",
  parameters: Type.Object({
    ticker: Type.String({ description: "Stock ticker symbol, e.g. AAPL" }),
    quarters: Type.Optional(
      Type.Number({ description: "Quarters of history to return (1-20, default 12)" })
    ),
    years: Type.Optional(
      Type.Number({ description: "Fiscal years of history to return (1-10, default 5)" })
    ),
  }),
  async execute(_id, params) {
    const result = await getFinancialHistory(params.ticker, params.quarters, params.years);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

const priceHistoryTool = defineTool({
  name: "get_price_history",
  label: "Get Price History",
  description:
    "Fetch price history and trend statistics: total return over the range, 50-day and 200-day moving averages with the current price's distance from each, golden/death cross state, distance from the 52-week high and low, max drawdown, annualized volatility, monthly closes, and performance relative to the S&P 500. Use this for any question about price action, momentum, entry timing, or market sentiment.",
  promptSnippet:
    "get_price_history(ticker, range) — 1y return, 50/200-day MAs, drawdown, volatility, vs S&P 500",
  parameters: Type.Object({
    ticker: Type.String({ description: "Stock ticker symbol, e.g. AAPL" }),
    range: Type.Optional(
      Type.String({
        description: 'Yahoo range: "1mo", "6mo", "ytd", "1y" (default), "2y", "5y", "max"',
      })
    ),
  }),
  async execute(_id, params) {
    const result = await getPriceHistory(params.ticker, params.range);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

const filingSectionTool = defineTool({
  name: "get_filing_section",
  label: "Get Filing Section",
  description:
    'Extract a named section from the most recent 10-K or 10-Q on SEC EDGAR. Sections: "1" (Business), "1A" (Risk Factors), "7" (Management\'s Discussion and Analysis), "7A" (Market Risk). Use "1A" for the company\'s own enumeration of its risks and "7" for management\'s explanation of the financial results.',
  promptSnippet:
    "get_filing_section(ticker, section) — Item 1 / 1A Risk Factors / 7 MD&A / 7A from the latest 10-K or 10-Q",
  parameters: Type.Object({
    ticker: Type.String({ description: "Stock ticker symbol, e.g. AAPL" }),
    section: Type.Optional(
      Type.String({ description: 'Item number: "1", "1A" (default), "7", or "7A"' })
    ),
    form: Type.Optional(
      Type.String({ description: '"10-K" (default) or "10-Q"' })
    ),
  }),
  async execute(_id, params) {
    const result = await getFilingSection(params.ticker, params.section, params.form);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

const reverseDcfTool = defineTool({
  name: "get_reverse_dcf",
  label: "Reverse DCF",
  description:
    "Solve for the free-cash-flow growth rate the current share price implies, and compare it against the growth the company has actually delivered. Returns the implied rate both on standard FCF and with share-based compensation deducted. Declines to answer for Phase 1/2 companies and when base FCF is negative, where an implied growth rate would be meaningless. Discount rate, terminal growth and horizon are assumptions, not measurements — vary them to test sensitivity.",
  promptSnippet:
    "get_reverse_dcf(ticker) — FCF growth the current price implies, vs. actual delivered growth",
  parameters: Type.Object({
    ticker: Type.String({ description: "Stock ticker symbol, e.g. AAPL" }),
    discount_rate: Type.Optional(
      Type.Number({ description: "Required return as a decimal, e.g. 0.10 (default)" })
    ),
    terminal_growth: Type.Optional(
      Type.Number({ description: "Perpetual growth past the horizon, e.g. 0.025 (default)" })
    ),
    years: Type.Optional(
      Type.Number({ description: "Explicit forecast horizon in years (default 10)" })
    ),
  }),
  async execute(_id, params) {
    const result = await getReverseDcf(params.ticker, {
      discountRate: params.discount_rate,
      terminalGrowth: params.terminal_growth,
      years: params.years,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

const forwardEstimatesTool = defineTool({
  name: "get_forward_estimates",
  label: "Forward Estimates",
  description:
    "Analyst consensus estimates from Yahoo Finance: forward EPS and P/E, PEG, current- and next-fiscal-year EPS and revenue estimates with analyst counts, the analyst price target and rating, and the last four quarters of actual-vs-estimate EPS. This is OPINION, not SEC-filed fact — label it as such wherever it appears. Returns { available: false, reason } when estimates cannot be had (no analyst coverage, unknown symbol, endpoint unreachable); render that reason and fall back to trailing figures rather than showing a blank or a guess.",
  promptSnippet:
    "get_forward_estimates(ticker) — analyst consensus: forward EPS/PE, FY estimates, target price, EPS beats",
  parameters: Type.Object({
    ticker: Type.String({ description: "Stock ticker symbol, e.g. AAPL" }),
  }),
  async execute(_id, params) {
    const result = await getForwardEstimates(params.ticker);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

const analystSentimentTool = defineTool({
  name: "get_analyst_sentiment",
  label: "Get Analyst Sentiment",
  description:
    "Fetch recent analyst rating upgrades/downgrades and recommendation trend data for a ticker.",
  promptSnippet: "get_analyst_sentiment(ticker) — rating actions, recommendation trend",
  parameters: tickerParam,
  async execute(_id, params) {
    const result = await getAnalystSentiment(params.ticker);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

const competitorsTool = defineTool({
  name: "get_competitors",
  label: "Get Competitors",
  description: "Identify sector and industry peers for a ticker.",
  promptSnippet: "get_competitors(ticker) — sector, industry, peer tickers",
  parameters: tickerParam,
  async execute(_id, params) {
    const result = await getCompetitors(params.ticker);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

const businessDescriptionTool = defineTool({
  name: "get_business_description",
  label: "Get Business Description",
  description:
    "Fetch the business description from the company's most recent 10-K filing on SEC EDGAR. Returns Item 1 (Business) text.",
  promptSnippet: "get_business_description(ticker) — 10-K Item 1 business description from SEC EDGAR",
  parameters: tickerParam,
  async execute(_id, params) {
    const result = await getBusinessDescription(params.ticker);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

const recentFilingsTool = defineTool({
  name: "get_recent_filings",
  label: "Get Recent Filings",
  description:
    "List the 10 most recent SEC filings (10-K, 10-Q, 8-K, DEF 14A) for a ticker, with dates.",
  promptSnippet: "get_recent_filings(ticker) — recent 10-K, 10-Q, 8-K filings list",
  parameters: tickerParam,
  async execute(_id, params) {
    const result = await getRecentFilings(params.ticker);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

const businessPhaseTool = defineTool({
  name: "get_business_phase",
  label: "Get Business Phase",
  description:
    "Classify a company into one of five business-lifecycle phases (1 Startup, 2 Hypergrowth, 3 Self-Funding/Operating Leverage, 4 Capital Return, 5 Decline) using a deterministic decision tree over SEC XBRL fundamentals: operating margin, revenue growth, prior-year operating income, and capital returns (capital returns are the last tiebreak, never an override). Returns the phase, the inputs it used, a reasoning line, a confidence level, and the phase-appropriate valuation methods. This is the single source of truth for the phase — /phase, /valuation, and /metrics all call it, and it is computed once per ticker per session.",
  promptSnippet:
    "get_business_phase(ticker) — deterministic lifecycle phase (1-5) + phase-appropriate valuation methods",
  parameters: tickerParam,
  async execute(_id, params) {
    const result = await getBusinessPhase(params.ticker);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
  },
});

export default function stockAnalyzerExtension(pi: ExtensionAPI) {
  pi.registerTool(financialsTool);
  pi.registerTool(businessPhaseTool);
  pi.registerTool(financialHistoryTool);
  pi.registerTool(priceDataTool);
  pi.registerTool(priceHistoryTool);
  pi.registerTool(reverseDcfTool);
  pi.registerTool(forwardEstimatesTool);
  pi.registerTool(analystSentimentTool);
  pi.registerTool(competitorsTool);
  pi.registerTool(businessDescriptionTool);
  pi.registerTool(filingSectionTool);
  pi.registerTool(recentFilingsTool);
}

import { performance } from "node:perf_hooks";
import { calculateCost, type AnyModel, type Usage } from "@earendil-works/pi-ai";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseColor, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const DARK_COLOR = {
	text: parseColor("#DCEBFF"),
	model: parseColor("#B9D6FF"),
	separator: parseColor("#C3B6EC"),
	thinking: parseColor("#C5A3FF"),
	context: parseColor("#72DED3"),
	window: parseColor("#A8C9EF"),
	cache: parseColor("#8AE0B6"),
	cost: parseColor("#F4CF88"),
	latency: parseColor("#FFA990"),
	speed: parseColor("#83C3FF"),
	warning: parseColor("#F4CF88"),
	danger: parseColor("#ff8fa4"),
};

const LIGHT_COLOR: typeof DARK_COLOR = {
	text: parseColor("#243447"),
	model: parseColor("#245A86"),
	separator: parseColor("#685A82"),
	thinking: parseColor("#714598"),
	context: parseColor("#126A61"),
	window: parseColor("#3D5973"),
	cache: parseColor("#24703F"),
	cost: parseColor("#805A18"),
	latency: parseColor("#91482E"),
	speed: parseColor("#2B6091"),
	warning: parseColor("#805A18"),
	danger: parseColor("#A82D42"),
};

function hasKnownRates(model: AnyModel | undefined): model is AnyModel {
	if (!model?.cost) return false;
	const rates = [model.cost, ...(model.cost.tiers ?? [])].flatMap(({ input, output, cacheRead, cacheWrite }) => [
		input, output, cacheRead, cacheWrite,
	]);
	return rates.every((rate) => Number.isFinite(rate) && rate >= 0) && rates.some((rate) => rate > 0);
}

function fmtTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}

function fmtLatency(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtUsd(usd: number): string {
	if (usd === 0) return "0";
	const digits = usd < 0.01 ? 4 : 2;
	const scale = 10 ** digits;
	return (Math.round(usd * scale) / scale).toFixed(digits);
}

function fits(left: string, right: string, width: number): boolean {
	return visibleWidth(left) + visibleWidth(right) + (left && right ? 2 : 0) <= width;
}

function alignRow(left: string, right: string, width: number, ellipsis: string): string {
	if (width <= 0) return "";
	if (!right) return truncateToWidth(left, width, ellipsis);
	const rightWidth = visibleWidth(right);
	if (!left || rightWidth + 2 >= width) {
		return " ".repeat(Math.max(0, width - rightWidth)) + truncateToWidth(right, width, ellipsis);
	}
	return truncateToWidth(left, width - rightWidth - 2, ellipsis, true) + "  " + right;
}

function sanitizeStatus(value: string): string {
	return String(value).replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export default function (pi: ExtensionAPI): void {
	let ctx: ExtensionContext;
	let tui: TUI | undefined;
	let contextMemoKey = "";
	let contextUsage: ContextUsage | undefined;
	let cacheReadPercent: number | undefined;
	let standardCostTotal = 0;
	let hasKnownCost = false;
	let hasUnknownCost = false;
	let totalsSessionId: string | undefined;
	let countedEntries = 0;
	let inputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	const priceDependencies = new Map<string, { provider: string; modelId: string; ratesJson: string | undefined }>();

	let pendingRequestStartAt: number | undefined;
	let requestStartAt: number | undefined;
	let firstTokenAt: number | undefined;
	let runGenerationMs = 0;
	let runDecodedTokens = 0;
	let lastPerf: { ttftMs: number; tokensPerSec: number } | null = null;

	function standardCost(provider: string, modelId: string, usage: Usage): number | undefined {
		if (!provider || !modelId) return undefined;
		const model = ctx.modelRegistry.find(provider, modelId);
		priceDependencies.set(JSON.stringify([provider, modelId]), {
			provider,
			modelId,
			ratesJson: JSON.stringify(model?.cost),
		});
		if (!hasKnownRates(model)) return undefined;
		const computed = calculateCost(model, {
			...usage,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		return Number.isFinite(computed.total) && computed.total >= 0 ? computed.total : undefined;
	}

	function resetRequestTiming(): void {
		pendingRequestStartAt = requestStartAt = firstTokenAt = undefined;
	}

	function resetRunTiming(): void {
		resetRequestTiming();
		runGenerationMs = runDecodedTokens = 0;
		lastPerf = null;
	}

	function resetTotals(sessionId: string): void {
		totalsSessionId = sessionId;
		countedEntries = inputTokens = cacheReadTokens = cacheWriteTokens = standardCostTotal = 0;
		hasKnownCost = hasUnknownCost = false;
		cacheReadPercent = undefined;
		priceDependencies.clear();
	}

	function syncSessionStats(): void {
		const sm = ctx.sessionManager;
		const sessionId = sm.getSessionId();
		const count =
			"getEntryCount" in sm && typeof sm.getEntryCount === "function"
				? sm.getEntryCount()
				: sm.getEntries().length;
		if (sessionId !== totalsSessionId || count < countedEntries) resetTotals(sessionId);
		for (const { provider, modelId, ratesJson } of priceDependencies.values()) {
			if (JSON.stringify(ctx.modelRegistry.find(provider, modelId)?.cost) !== ratesJson) {
				resetTotals(sessionId);
				break;
			}
		}

		if (count > countedEntries) {
			const entries = sm.getEntries();
			for (let i = countedEntries; i < entries.length; i++) {
				const e = entries[i];
				const message = e.type === "message" ? e.message : undefined;
				const usage =
					message?.role === "assistant" || message?.role === "toolResult"
						? message.usage
						: e.type === "usage" || e.type === "branch_summary" || e.type === "compaction"
							? e.usage
							: undefined;
				if (!usage) continue;

				const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
				if (prompt + (usage.output ?? 0) === 0 && !(usage.cost?.total > 0)) continue;

				inputTokens += usage.input ?? 0;
				cacheReadTokens += usage.cacheRead ?? 0;
				cacheWriteTokens += usage.cacheWrite ?? 0;

				const source = e.type === "usage" ? e : message?.role === "assistant" ? message : undefined;
				let cost = source ? standardCost(source.provider, source.model, usage) : undefined;
				// Catalog rates win. A stored total covers entries with no model, or a model the catalog cannot price.
				if (!(typeof cost === "number" && cost > 0)) {
					const recorded = usage.cost?.total;
					if (typeof recorded === "number" && Number.isFinite(recorded) && recorded > 0) cost = recorded;
				}
				if (cost === undefined) hasUnknownCost = true;
				else {
					standardCostTotal += cost;
					hasKnownCost = true;
				}
			}
			countedEntries = entries.length;
			const totalPrompt = inputTokens + cacheReadTokens + cacheWriteTokens;
			cacheReadPercent =
				(cacheReadTokens > 0 || cacheWriteTokens > 0) && totalPrompt > 0
					? (cacheReadTokens / totalPrompt) * 100
					: undefined;
		}

		const model = ctx.model;
		const key = `${sessionId}|${count}|${sm.getLeafId()}|${model?.provider ?? ""}|${model?.id ?? ""}|${model?.contextWindow ?? ""}`;
		if (key !== contextMemoKey) {
			contextUsage = ctx.getContextUsage();
			contextMemoKey = key;
		}
	}

	function installFooter(): void {
		ctx.ui.setFooter((t, theme, footerData) => {
			tui = t;
			const style = (color: (typeof DARK_COLOR)[keyof typeof DARK_COLOR], text: string) =>
				theme.style(text, { fg: color });
			return {
				dispose() {
					if (tui === t) tui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					syncSessionStats();
					const model = ctx.model;
					const thinking = model?.reasoning ? (ctx.thinkingLevel ?? "off") : "";
					const statuses = Array.from(footerData.getExtensionStatuses().entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, value]) => sanitizeStatus(value))
						.filter(Boolean)
						.join(" ");

					const COLOR = theme.appearance === "light" ? LIGHT_COLOR : DARK_COLOR;
					const ellipsis = style(COLOR.text, "…");
					const dot = style(COLOR.separator, " · ");

					let identity = style(COLOR.model, model?.id ?? "no-model");
					if (thinking) {
						identity += style(COLOR.separator, " • ") + style(COLOR.thinking, thinking);
					}

					let contextFull = "";
					let contextCompact = "";
					if (contextUsage) {
						const { percent, tokens, contextWindow } = contextUsage;
						const win = fmtTokens(contextWindow);
						if (percent === null || tokens === null) {
							contextFull = style(COLOR.window, `?/${win}`);
							contextCompact = style(COLOR.window, "?");
						} else {
							const pctColor = percent > 90 ? COLOR.danger : percent > 70 ? COLOR.warning : COLOR.context;
							contextCompact = style(pctColor, `${Math.round(percent)}%`);
							contextFull =
								contextCompact +
								" " +
								style(COLOR.context, fmtTokens(tokens)) +
								style(COLOR.separator, "/") +
								style(COLOR.window, win);
						}
					}

					const cacheText =
						cacheReadPercent === undefined ? "" : style(COLOR.cache, `CH${cacheReadPercent.toFixed(1)}%`);
					const costText = hasKnownCost
						? style(COLOR.cost, `$${fmtUsd(standardCostTotal)}${hasUnknownCost ? "+" : ""}`)
						: "";
					const cumulative = [cacheText, costText].filter(Boolean).join(dot);
					const speedText = lastPerf ? style(COLOR.speed, `${lastPerf.tokensPerSec.toFixed(1)}t/s`) : "";
					const timingText = lastPerf ? style(COLOR.latency, fmtLatency(lastPerf.ttftMs)) + dot + speedText : "";

					const line2Candidates: [string, string][] = [
						[cumulative, timingText],
						[costText, timingText],
						["", timingText],
						["", speedText],
						["", ""],
					];
					const [left2, right2] = line2Candidates.find(([l, r]) => fits(l, r, width))!;
					const right1 = fits(identity, contextFull, width) ? contextFull : contextCompact;
					const lines = [
						alignRow(identity, right1, width, ellipsis),
						alignRow(left2, right2, width, ellipsis),
					];
					if (statuses) lines.push(truncateToWidth(statuses, Math.max(0, width), ellipsis));

					return lines;
				},
			};
		});
	}

	pi.on("session_start", (_event, c) => {
		ctx = c;
		contextMemoKey = "";
		resetTotals(c.sessionManager.getSessionId());
		resetRunTiming();
		if (c.mode === "tui") installFooter();
	});
	pi.on("agent_start", () => {
		resetRunTiming();
		tui?.requestRender();
	});
	pi.on("before_provider_request", () => {
		pendingRequestStartAt = performance.now();
	});
	pi.on("message_start", ({ message }) => {
		if (pendingRequestStartAt === undefined || message.role !== "assistant") return;
		requestStartAt = pendingRequestStartAt;
		firstTokenAt = pendingRequestStartAt = undefined;
	});
	pi.on("message_update", ({ assistantMessageEvent: ev }) => {
		if (requestStartAt === undefined || firstTokenAt !== undefined) return;
		const hasToken =
			((ev.type === "text_delta" || ev.type === "thinking_delta") && ev.delta.length > 0) ||
			ev.type === "toolcall_start" ||
			ev.type === "toolcall_delta";
		if (hasToken) firstTokenAt = performance.now();
	});
	pi.on("message_end", ({ message: m }) => {
		if (requestStartAt === undefined || m.role !== "assistant") return;
		if (m.stopReason === "error" || m.stopReason === "aborted") {
			resetRequestTiming();
			return;
		}
		const endAt = performance.now();
		const firstAt = firstTokenAt ?? endAt;
		const genMs = Math.max(0, endAt - firstAt);
		const outputTokens = m.usage?.output ?? 0;
		runGenerationMs += genMs;
		if (outputTokens > 1 && genMs > 0) runDecodedTokens += outputTokens - 1;
		lastPerf = {
			ttftMs: Math.max(0, firstAt - requestStartAt),
			tokensPerSec: runGenerationMs > 0 ? (runDecodedTokens / runGenerationMs) * 1000 : 0,
		};
		resetRequestTiming();
		tui?.requestRender();
	});
}

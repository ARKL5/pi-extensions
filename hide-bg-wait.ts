import type { ExtensionAPI, ExtensionContext, ToolLoadout } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HIDER = "bg_wait_hider";
const SUBAGENT = "subagent";
const LOADER = "subagents_enable";
const SUPERVISOR = "subagent_supervisor";
const HIDDEN = ["bg_wait", LOADER, HIDER] as const;

const DESCRIPTIONS = {
	subagent: [
		"Delegate when requested by the user or authorized by applicable AGENTS.md or skill instructions. Use agent+task for one child, tasks for parallel work, or chain for ordered steps; choose exactly one.",
		"Before launching, select an available agent with {action:\"list\",capabilities:true}. list and status on this tool describe agents and runs.",
		"Use async:true by default. After launch, continue independent work or return control. Completion wakes this session; consume the result before a step that depends on it. Use async:false when explicitly requested or required by the applicable workflow.",
		"A child blocked on a decision or interview also wakes this session with the question. Answer that turn with subagent_supervisor.",
		"Before external CLI execution or run recovery, read {action:\"guide\",topic:\"tool-reference\"}.",
	].join("\n\n"),
	subagent_supervisor: [
		"Answer a child blocked on a decision or interview. The question arrives as its own turn and includes the reply call. Send that call: {action:\"reply\", replyTo:\"<request id>\", message:\"...\"}.",
		"pending and list print questions that still need an answer, including one whose turn was missed. status only reports that this channel is active and how many answers are waiting. Run progress stays on subagent.",
	].join("\n\n"),
	web_search: "Search the web with the configured Exa provider. Use queries with 2-4 different angles for research, or query for one lookup. Results include sources and a responseId; get_search_content reads the stored page.",
};

/**
 * pi-subagents and pi-web-access ship large tool declarations. Subagents are rare, so their
 * schemas stay out of ordinary requests until /subagent-on. That command adds subagent and
 * subagent_supervisor together; the next request pays for both once.
 * subagents_enable and bg_wait stay registered but omitted. The model must not turn delegation
 * on itself, and must not see a wait tool. The first registration of those names wins.
 * Decide from this loadout. getActiveTools() is still the previous set while prepareLoadout runs.
 * The package description repeats the parameter text. These replacements are the manual cut of that
 * redundancy; do not restore the package wording. Parameter schemas stay with the packages.
 */
export default function (pi: ExtensionAPI) {
	function enableSubagent(ctx: ExtensionContext) {
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		if (!registered.has(SUBAGENT)) {
			ctx.ui.notify("subagent 没有注册。", "error");
			return;
		}
		const active = pi.getActiveTools();
		const added = [SUBAGENT, SUPERVISOR].filter((name) => registered.has(name) && !active.includes(name));
		if (added.length === 0) {
			ctx.ui.notify("subagent 已经开着。", "info");
			return;
		}
		pi.setActiveTools([...active, ...added]);
		ctx.ui.notify(`已打开 ${added.join(" 和 ")}。下一次模型请求会带上，提示缓存会失效。`, "warning");
	}

	pi.registerCommand("subagent-on", {
		description: "一次打开 subagent 和 subagent_supervisor。下一次请求带上两份声明，提示缓存会失效。",
		handler: async (_args, ctx) => enableSubagent(ctx),
	});

	pi.registerTool({
		name: HIDER,
		label: "Hide bg_wait",
		description: "Internal. Keeps bg_wait out of model-facing tool declarations.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "bg_wait stays hidden. This tool is not for the model." }],
				details: {},
			};
		},
		prepareLoadout(loadout: ToolLoadout) {
			const declared = new Set(loadout.declared.map((tool) => tool.name));
			const hidden: string[] = [...HIDDEN];
			if (!declared.has(SUBAGENT)) hidden.push(SUPERVISOR);
			return { hiddenDeclarations: hidden, descriptions: DESCRIPTIONS };
		},
	});

	function ensureActive(): boolean {
		const active = pi.getActiveTools();
		if (!active.includes(HIDER)) {
			pi.setActiveTools([...active, HIDER]);
		}
		return pi.getActiveTools().includes(HIDER);
	}

	pi.on("session_start", () => { ensureActive(); });
	pi.on("session_tree", () => { ensureActive(); });
	pi.on("before_agent_start", (event) => {
		// Explicit exclusions may prevent activation; do not bypass them in the prompt.
		if (!ensureActive()) return;
		const selected = event.systemPromptOptions.selectedTools;
		if (selected && !selected.includes(HIDER)) selected.push(HIDER);
	});
}

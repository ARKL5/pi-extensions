import type { ExtensionAPI, ExtensionContext, ToolLoadout } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HIDER = "bg_wait_hider";
const SUBAGENT = "subagent";
const LOADER = "subagents_enable";
const SUPERVISOR = "subagent_supervisor";
const WAIT = "bg_wait";
const HIDDEN = [LOADER, HIDER] as const;

// pi-subagents' wait tool declares exactly these two parameters; another extension's bg_wait does not.
// It is matched by shape as well as by name, because config.waitTool.name can rename it, and a
// literal name alone would then leave a blocking wait tool in the request without a warning.
function isWaitTool(parameters: unknown): boolean {
	const properties = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
	return properties !== undefined && "nonBlocking" in properties && "stopOnAttention" in properties;
}

/** Drop a per-call model override; returns the value that was removed, if any. */
function stripModel(holder: unknown): string | undefined {
	if (typeof holder !== "object" || holder === null) return undefined;
	const record = holder as Record<string, unknown>;
	if (!("model" in record)) return undefined;
	const value = record.model;
	delete record.model;
	return typeof value === "string" && value.length > 0 ? value : "model";
}

/**
 * A per-call model beats the model fixed in the agent definition, and pi-subagents aborts the whole
 * launch when that id is not in the registry. Arguments are not re-validated after a tool_call
 * handler, so dropping the field here is the one place the model cannot talk its way past.
 */
function stripModelOverrides(input: Record<string, unknown>): string[] {
	const stripped: string[] = [];
	const strip = (holder: unknown) => {
		const value = stripModel(holder);
		if (value !== undefined) stripped.push(value);
	};
	strip(input);
	strip(input.options);
	for (const key of ["tasks", "chain"]) {
		const list = input[key];
		if (!Array.isArray(list)) continue;
		for (const step of list) {
			strip(step);
			if (typeof step !== "object" || step === null) continue;
			const parallel = (step as Record<string, unknown>).parallel;
			if (Array.isArray(parallel)) for (const group of parallel) strip(group);
		}
	}
	return stripped;
}

// `subagent` names the single installed agent; keep that line in step with ~/.pi/agent/agents.
const DESCRIPTIONS = {
	subagent: [
		"Delegate when requested by the user or authorized by applicable AGENTS.md or skill instructions. One agent exists: general. Use agent+task for one child, tasks for parallel work, or chain for ordered steps; choose exactly one. Never pass model: the agent's model and thinking level are fixed in configuration, and an unknown id aborts the launch.",
		"Use async:true by default. After launch, continue independent work or return control. Completion wakes this session; consume the result before a step that depends on it. Use async:false when explicitly requested or required by the applicable workflow.",
		"A child blocked on a decision or interview also wakes this session with the question. Answer that turn with subagent_supervisor.",
	].join("\n\n"),
	subagent_supervisor: [
		"Answer a child blocked on a decision or interview. The question arrives as its own turn and includes the reply call. Send that call: {action:\"reply\", replyTo:\"<request id>\", message:\"...\"}.",
		"pending and list print questions that still need an answer, including one whose turn was missed. status only reports that this channel is active and how many answers are waiting. Run progress stays on subagent.",
	].join("\n\n"),
	web_search: "Search the web with the configured Exa provider. Use queries with 2-4 different angles for research, or query for one lookup. Results include sources and a responseId; get_search_content reads the stored page.",
};

/**
 * pi-subagents ships a large `subagent` declaration and pi-web-access ships longer text for
 * web_search. Subagents are rare, so `subagent` and `subagent_supervisor` stay out of ordinary
 * requests until /subagent-on; that command adds both and the next request pays for them once.
 * `subagents_enable` and the wait tool stay registered but omitted: the model must not turn
 * delegation on itself, and must not park on a wait tool when completion already wakes this
 * session. The first registration of those names wins.
 * Decide from this loadout. getActiveTools() is still the previous set while prepareLoadout runs.
 * Parameter schemas stay with the packages; these replacements are the manual cut of the
 * descriptions they carry, so do not restore the package wording.
 */
export default function (pi: ExtensionAPI) {
	let notedModelOverride = false;

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
			const hidden = [
				...HIDDEN,
				...loadout.registered
					.filter((tool) => tool.name === WAIT || isWaitTool(tool.parameters))
					.map((tool) => tool.name),
			];
			if (!declared.has(SUBAGENT)) hidden.push(SUPERVISOR);
			return { hiddenDeclarations: hidden, descriptions: DESCRIPTIONS };
		},
	});

	function ensureActive(): boolean {
		const active = pi.getActiveTools();
		if (active.includes(HIDER)) return true;
		pi.setActiveTools([...active, HIDER]);
		return pi.getActiveTools().includes(HIDER);
	}

	pi.on("session_start", () => { ensureActive(); });
	pi.on("session_tree", () => { ensureActive(); });
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== SUBAGENT) return;
		const stripped = stripModelOverrides(event.input as Record<string, unknown>);
		if (stripped.length === 0 || notedModelOverride) return;
		notedModelOverride = true;
		ctx.ui.notify(`已忽略子代理的模型覆盖：${stripped.join("、")}。模型由 agent 定义固定。`, "info");
	});
	pi.on("before_agent_start", (event) => {
		// Explicit exclusions may prevent activation; do not bypass them in the prompt.
		if (!ensureActive()) return;
		const selected = event.systemPromptOptions.selectedTools;
		if (selected && !selected.includes(HIDER)) selected.push(HIDER);
	});
}

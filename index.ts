import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BASE_PORT = 9400;
const MAX_RESULT_CHARS = 5000;

function truncateSnapshot(text: string, allowWhole: boolean): string {
	if (allowWhole || text.length <= MAX_RESULT_CHARS) return text;
	return text.substring(0, MAX_RESULT_CHARS) + "\n\n[TRUNCATED] Snapshot exceeds " + MAX_RESULT_CHARS + " chars. Use container/filter to scope the result, or pass allowWhole: true.";
}

function truncateEval(text: string, allowWhole: boolean): string {
	if (allowWhole || text.length <= MAX_RESULT_CHARS) return text;
	return text.substring(0, MAX_RESULT_CHARS) + "\n\n[TRUNCATED] Eval result exceeds " + MAX_RESULT_CHARS + " chars. Scope your JS expression to return less data, or pass allowWhole: true.";
}

function isSelector(s: string) {
	if (!s) return false;
	if (".#[:(".includes(s[0])) return true;
	if (/[>+~*]/.test(s)) return true;
	return false;
}

const MIME_MAP: Record<string, string> = {
	".pdf": "application/pdf",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// ── One LightPanda instance = one "tab" ──────────────────────────────

interface TabInfo {
	id: string;
	port: number;
	url: string;
	title: string;
	ws: WebSocket | null;
	proc: any;
	targetId: string;
	sessionId: string;
	msgId: number;
	pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>;
}

function fetchJSON(url: string): Promise<any> {
	return new Promise((resolve, reject) => {
		http.get(url, { timeout: 5000 }, res => {
			let data = "";
			res.on("data", chunk => data += chunk);
			res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
		}).on("error", reject)
			.on("timeout", function () { this.destroy(); reject(new Error("Connection timeout")); });
	});
}

async function isPortRunning(port: number): Promise<boolean> {
	try {
		await fetchJSON(`http://127.0.0.1:${port}/json/version`);
		return true;
	} catch { return false; }
}

class PandaTabManager {
	private tabs = new Map<string, TabInfo>();
	private activeTabId: string | null = null;
	private nextPort = BASE_PORT;
	private tabCounter = 0;
	private lpPath: string;

	constructor() {
		this.lpPath = process.env.PANDA97_BINARY || "lightpanda";
	}

	get activeTab(): TabInfo | null {
		if (!this.activeTabId) return null;
		return this.tabs.get(this.activeTabId) || null;
	}

	private async findFreePort(): Promise<number> {
		// Start from BASE_PORT and find one that's not in use
		let port = this.nextPort;
		for (let i = 0; i < 100; i++) {
			const inUse = await isPortRunning(port);
			const taken = Array.from(this.tabs.values()).some(t => t.port === port);
			if (!inUse && !taken) {
				this.nextPort = port + 1;
				return port;
			}
			port++;
		}
		throw new Error("Could not find a free port for LightPanda");
	}

	private async launchInstance(port: number): Promise<any> {
		const { spawn } = await import("node:child_process");
		const args = [
			"serve",
			"--host", "127.0.0.1",
			"--port", String(port),
			"--log-level", "warn",
		];
		let lastError = "";
		const proc = spawn(this.lpPath, args, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stderr?.on("data", (d: Buffer) => { lastError = d.toString().substring(0, 200); });
		proc.on("error", (err: Error) => { lastError = err.message; });
		proc.unref();

		for (let i = 0; i < 30; i++) {
			await new Promise(r => setTimeout(r, 500));
			if (await isPortRunning(port)) return proc;
			if (proc.exitCode !== null) {
				throw new Error(`LightPanda exited with code ${proc.exitCode}. ${lastError}`);
			}
		}
		throw new Error(`LightPanda did not start within 15s. ${lastError}`);
	}

	private connectWs(tab: TabInfo): Promise<void> {
		const wsUrl = `ws://127.0.0.1:${tab.port}/`;
		tab.ws = new WebSocket(wsUrl);
		tab.ws.onmessage = (event) => {
			const msg = JSON.parse(event.data as string);
			if (msg.id && tab.pending.has(msg.id)) {
				const { resolve, reject } = tab.pending.get(msg.id)!;
				tab.pending.delete(msg.id);
				if (msg.error) reject(new Error(msg.error.message));
				else resolve(msg.result);
			}
		};
		return new Promise<void>((resolve, reject) => {
			const ws = tab.ws!;
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error("WebSocket connection failed"));
			setTimeout(() => reject(new Error("WS connect timeout")), 5000);
		});
	}

	private send(tab: TabInfo, method: string, params: Record<string, any> = {}, useSession = true): Promise<any> {
		if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket not connected for tab " + tab.id);
		}
		const myId = ++tab.msgId;
		return new Promise((resolve, reject) => {
			tab.pending.set(myId, { resolve, reject });
			const payload: any = { id: myId, method, params };
			if (useSession && tab.sessionId) {
				payload.sessionId = tab.sessionId;
			}
			tab.ws!.send(JSON.stringify(payload));
			setTimeout(() => {
				if (tab.pending.has(myId)) {
					tab.pending.delete(myId);
					reject(new Error(`Timeout: ${method}`));
				}
			}, 30000);
		});
	}

	private async evaluate(tab: TabInfo, expression: string): Promise<any> {
		if (!tab.sessionId) throw new Error("Tab not initialized: " + tab.id);
		const { result } = await this.send(tab, "Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (!result) throw new Error("No result from evaluate");
		if (result.type === "object" && result.subtype === "error") {
			throw new Error(result.description);
		}
		return result.value;
	}

	async evaluateActive(expression: string): Promise<any> {
		const tab = this.activeTab;
		if (!tab) throw new Error("No browser tab. Call panda97_start first.");
		return this.evaluate(tab, expression);
	}

	async sendActive(method: string, params: Record<string, any> = {}): Promise<any> {
		const tab = this.activeTab;
		if (!tab) throw new Error("No browser tab. Call panda97_start first.");
		return this.send(tab, method, params);
	}

	async start(url: string): Promise<{ url: string; title: string; id: string }> {
		const port = await this.findFreePort();
		const proc = await this.launchInstance(port);

		const tabId = (++this.tabCounter).toString(16).toUpperCase().padStart(8, "0");
		const tab: TabInfo = {
			id: tabId,
			port,
			url: "",
			title: "",
			ws: null,
			proc,
			targetId: "",
			sessionId: "",
			msgId: 0,
			pending: new Map(),
		};

		this.tabs.set(tabId, tab);
		this.activeTabId = tabId;

		// Connect WebSocket
		await this.connectWs(tab);

		// Create target + attach
		const target = await this.send(tab, "Target.createTarget", { url }, false);
		tab.targetId = target.targetId;

		const session = await this.send(tab, "Target.attachToTarget", { targetId: tab.targetId, flatten: true }, false);
		tab.sessionId = session.sessionId;

		// Wait for page load
		await new Promise(r => setTimeout(r, 2000));

		try {
			tab.url = await this.evaluate(tab, "document.location.href") || url;
			tab.title = await this.evaluate(tab, "document.title") || "";
		} catch {
			tab.url = url;
			tab.title = "";
		}

		return { url: tab.url, title: tab.title, id: tab.id };
	}

	async navigate(url: string): Promise<string> {
		const tab = this.activeTab;
		if (!tab) throw new Error("No browser tab. Call panda97_start first.");
		await this.send(tab, "Page.navigate", { url });
		await new Promise(r => setTimeout(r, 2000));
		try {
			tab.url = await this.evaluate(tab, "document.location.href") || url;
			tab.title = await this.evaluate(tab, "document.title") || "";
		} catch {
			tab.url = url;
			tab.title = "";
		}
		return tab.url;
	}

	listTabs(): { id: string; url: string; title: string }[] {
		return Array.from(this.tabs.values()).map(t => ({
			id: t.id,
			url: t.url,
			title: t.title,
		}));
	}

	async switchTab(targetId: string): Promise<{ url: string; title: string; id: string }> {
		const tab = this.tabs.get(targetId);
		if (!tab) throw new Error("Tab not found: " + targetId);
		this.activeTabId = targetId;

		// Refresh URL/title
		try {
			tab.url = await this.evaluate(tab, "document.location.href") || tab.url;
			tab.title = await this.evaluate(tab, "document.title") || tab.title;
		} catch { /* keep existing values */ }

		return { url: tab.url, title: tab.title, id: tab.id };
	}

	async closeTab(tabId: string): Promise<void> {
		const tab = this.tabs.get(tabId);
		if (!tab) return;

		// Close the target
		if (tab.ws && tab.ws.readyState === WebSocket.OPEN && tab.targetId) {
			try { await this.send(tab, "Target.closeTarget", { targetId: tab.targetId }, false); } catch { /* ignore */ }
		}

		// Close WebSocket
		if (tab.ws) {
			tab.ws.close();
			tab.ws = null;
		}

		// Kill the process
		if (tab.proc) {
			try { process.kill(-tab.proc.pid, "SIGTERM"); } catch {
				try { tab.proc.kill("SIGTERM"); } catch { /* ignore */ }
			}
		}

		this.tabs.delete(tabId);
		if (this.activeTabId === tabId) {
			// Switch to another tab if available
			const remaining = Array.from(this.tabs.keys());
			this.activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
		}
	}

	async disconnectAll(): Promise<void> {
		const tabIds = Array.from(this.tabs.keys());
		for (const id of tabIds) {
			await this.closeTab(id);
		}
	}
}

// ── Extension entry point ────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const manager = new PandaTabManager();

	pi.on("session_shutdown", () => {
		manager.disconnectAll();
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("panda97: LightPanda browser automation ready (auto-launches on panda97_start)", "info");
	});

	pi.registerTool({
		name: "panda97_start",
		label: "Panda Start",
		description: "Open a new browser tab in LightPanda and connect to it via CDP. Each tab runs its own LightPanda instance. Call this before any other panda97 tool.",
		promptSnippet: "Open a new LightPanda browser tab",
		promptGuidelines: [
			"Always call panda97_start first to open a browser tab before using other panda97 tools",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to navigate to" }),
		}),
		async execute(_id, params, _signal) {
			try {
				const info = await manager.start(params.url);
				return { content: [{ type: "text", text: `Tab opened: ${info.url} (${info.id})` }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "panda97_alltabs",
		label: "Panda List Tabs",
		description: "List all open LightPanda browser tabs. Returns id, url, and title for each. Use panda97_switchtab to connect to one.",
		promptSnippet: "List open LightPanda browser tabs",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal) {
			try {
				const tabs = manager.listTabs();
				if (tabs.length === 0) return { content: [{ type: "text", text: "No tabs open." }] };
				const lines = tabs.map(t => `${t.id}  ${t.url}  ${t.title}`).join("\n");
				return { content: [{ type: "text", text: lines }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "panda97_switchtab",
		label: "Panda Switch Tab",
		description: "Switch to an existing open LightPanda tab by its id. After switching, all panda97 tools operate on that tab. Get tab ids from panda97_alltabs.",
		promptSnippet: "Switch to a LightPanda browser tab by id",
		promptGuidelines: [
			"Use panda97_alltabs first to list tabs, then panda97_switchtab to connect to one",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Tab id from panda97_alltabs" }),
		}),
		async execute(_id, params, _signal) {
			try {
				const info = await manager.switchTab(params.id);
				return { content: [{ type: "text", text: `Switched to: ${info.url} (${info.id})` }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "panda97_closetab",
		label: "Panda Close Tab",
		description: "Close a LightPanda tab by its id and shut down its instance. If this is the active tab, switches to the most recent remaining tab.",
		promptSnippet: "Close a LightPanda browser tab",
		parameters: Type.Object({
			id: Type.String({ description: "Tab id to close" }),
		}),
		async execute(_id, params, _signal) {
			try {
				await manager.closeTab(params.id);
				return { content: [{ type: "text", text: `Closed tab: ${params.id}` }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "panda97_navigate",
		label: "Panda Navigate",
		description: "Navigate the active LightPanda tab to a URL",
		promptSnippet: "Navigate LightPanda to URL",
		parameters: Type.Object({
			url: Type.String({ description: "URL to navigate to" }),
		}),
		async execute(_id, params, _signal) {
			try {
				const currentUrl = await manager.navigate(params.url);
				return { content: [{ type: "text", text: `Navigated to: ${currentUrl}` }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "panda97_snapshot",
		label: "Panda Snapshot",
		description: "List interactive elements on the active LightPanda tab. Scope to container and/or filter to specific element types.",
		promptSnippet: "Take a compact snapshot of interactive page elements",
		promptGuidelines: [
			"Use panda97_snapshot to understand the page before interacting with it",
			"Pass container to scope to a section, filter to see only specific element types",
		],
		parameters: Type.Object({
			container: Type.Optional(Type.String({ description: "CSS selector to scope snapshot (e.g. '.main', '#form', 'nav')" })),
			filter: Type.Optional(Type.String({ description: "CSS selector to filter elements (e.g. 'a,button', 'input[type=email]', 'select')" })),
			allowWhole: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_id, params, _signal) {
			try {
				const container = params.container || "";
				const filter = params.filter || "";
				const containerJS = container
					? `document.querySelector(${JSON.stringify(container)})`
					: "document.body";
				const result = await manager.evaluateActive(`
					(function() {
						const root = ${containerJS};
						if (!root) return "Container not found";
						function fmt(el) {
							const tag = el.tagName.toLowerCase();
							const parts = ["<" + tag];
							const name = el.getAttribute("name");
							if (name) parts.push('name="' + name + '"');
							const id = el.id;
							if (id) parts.push('id="' + id + '"');
							const type = el.getAttribute("type");
							if (type) parts.push('type="' + type + '"');
							const placeholder = el.getAttribute("placeholder");
							if (placeholder) parts.push('placeholder="' + placeholder + '"');
							const role = el.getAttribute("role");
							if (role) parts.push('role="' + role + '"');
							let info = parts.join(" ");
							if (tag === "input" || tag === "textarea") {
								const val = el.value || "";
								if (val) info += ' value="' + val.substring(0, 60) + '"';
								const etype = el.getAttribute("type") || "";
								if (etype === "checkbox" || etype === "radio") info += " checked=" + el.checked;
								if (el.required) info += " required";
							}
							if (tag === "select") {
								const opts = Array.from(el.options).map(o => o.textContent.trim()).filter(Boolean);
								info += " options:[" + opts.join("|").substring(0, 200) + "]";
								if (el.value) info += ' selected="' + el.value + '"';
							}
							if (tag === "button" || tag === "a" || role === "button") {
								const text = el.textContent.trim().substring(0, 50);
								if (text) info += ' "' + text + '"';
							}
							if (tag === "label") {
								const text = el.textContent.trim().substring(0, 50);
								if (text) info += ' "' + text + '"';
								const forAttr = el.getAttribute("for");
								if (forAttr) info += ' for="' + forAttr + '"';
							}
							return info + ">";
						}
						const defaultSel = 'input,textarea,select,button,a,label,[role="button"],[role="link"],[onclick]';
						const querySel = ${JSON.stringify(filter)} || defaultSel;
						const els = root.querySelectorAll(querySel);
						if (els.length === 0) return "No elements matching " + querySel + (root === document.body ? "" : ". Text: " + root.textContent.trim().substring(0, 300));
						return Array.from(els).map(fmt).join("\\n");
					})()
				`);
				return { content: [{ type: "text", text: truncateSnapshot(result, !!params.allowWhole) }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "panda97_click",
		label: "Panda Click",
		description: 'Click an element by CSS selector (starts with .#[: or contains >+~*) or by visible text content (matches buttons, links, submit inputs).',
		promptSnippet: "Click element by CSS selector or text",
		parameters: Type.Object({
			target: Type.String({ description: "CSS selector or visible text to click" }),
		}),
		async execute(_id, params, _signal) {
			try {
				const sel = isSelector(params.target);
				const result = sel
					? await manager.evaluateActive(`
						(function() {
							const el = document.querySelector(${JSON.stringify(params.target)});
							if (!el) return "Not found: ${params.target.replace(/"/g, "")}";
							el.scrollIntoView({block:"center"});
							el.click();
							return "Clicked: ${params.target.replace(/"/g, "")}";
						})()
					`)
					: await manager.evaluateActive(`
						(function() {
							const targets = document.querySelectorAll('button,a,[role="button"],input[type="submit"],input[type="button"]');
							for (const el of targets) {
								if (el.textContent.trim().includes(${JSON.stringify(params.target)})) {
									el.scrollIntoView({block:"center"});
									el.click();
									return "Clicked: \\"" + el.textContent.trim().substring(0, 50) + "\\"";
								}
							}
							const all = document.querySelectorAll("*");
							for (const el of all) {
								if (el.childNodes.length <= 3 && el.textContent.trim() === ${JSON.stringify(params.target)}) {
									el.scrollIntoView({block:"center"});
									el.click();
									return "Clicked text: ${params.target.replace(/"/g, "")}";
								}
							}
							return "Not found: ${params.target.replace(/"/g, "")}";
						})()
					`);
				return { content: [{ type: "text", text: result }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "panda97_fill",
		label: "Panda Fill Form",
		description: "Fill multiple form fields at once. Matches fields by name, id, placeholder, or associated label text. Handles text inputs, textareas, selects, checkboxes, and radio buttons.",
		promptSnippet: "Fill form fields matching name/placeholder/label",
		promptGuidelines: [
			"panda97_fill fuzzy-matches field keys against name, id, placeholder, and label text",
			"For select fields, pass the visible option text as value",
			"For checkboxes, pass true or the string to match",
		],
		parameters: Type.Object({
			fields: Type.Record(Type.String(), Type.String({ description: "Value to fill" })),
		}),
		async execute(_id, params, _signal) {
			try {
				const result = await manager.evaluateActive(`
					(function() {
						const fields = ${JSON.stringify(params.fields)};
						const results = [];
						function labelOf(el) {
							if (el.id) { const lbl = document.querySelector('label[for="' + el.id + '"]'); if (lbl) return lbl.textContent.trim().toLowerCase(); }
							const parent = el.closest("label");
							if (parent) return parent.textContent.trim().toLowerCase().substring(0, 60);
							const prev = el.previousElementSibling;
							if (prev && prev.tagName === "LABEL") return prev.textContent.trim().toLowerCase();
							return "";
						}
						function match(el, key) {
							const k = key.toLowerCase();
							const name = (el.getAttribute("name") || "").toLowerCase();
							const id = (el.id || "").toLowerCase();
							const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
							const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
							return [name, id, placeholder, ariaLabel, labelOf(el)].some(c => c && (c === k || c.includes(k)));
						}
						for (const [key, value] of Object.entries(fields)) {
							const inputs = document.querySelectorAll("input,textarea,select");
							let filled = false;
							for (const el of inputs) {
								if (!match(el, key)) continue;
								const tag = el.tagName.toLowerCase();
								const type = (el.getAttribute("type") || "").toLowerCase();
								if (tag === "select") {
									const opt = Array.from(el.options).find(o => o.textContent.trim().toLowerCase().includes(value.toLowerCase()) || o.value.toLowerCase().includes(value.toLowerCase()));
									if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", {bubbles:true})); results.push(key + ": select \\"" + opt.textContent.trim().substring(0, 30) + "\\""); filled = true; break; }
								} else if (type === "checkbox" || type === "radio") {
									const val = (el.getAttribute("value") || "").toLowerCase();
									const want = String(value).toLowerCase();
									// the key usually matches the whole name group, so keep scanning until the wanted value/label matches
									if (value !== true && want !== "true" && !(val + " " + labelOf(el)).includes(want)) continue;
									el.checked = true; el.dispatchEvent(new Event("change", {bubbles:true})); results.push(key + " checked \"" + (val || labelOf(el)) + "\""); filled = true; break;
								} else {
									const setter = Object.getOwnPropertyDescriptor(tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
									if (setter) setter.call(el, value); else el.value = value;
									el.dispatchEvent(new Event("input", {bubbles:true}));
									el.dispatchEvent(new Event("change", {bubbles:true}));
									results.push(key + ': \\"' + String(value).substring(0, 40) + '\\"');
									filled = true; break;
								}
							}
							if (!filled) results.push(key + ": NOT FOUND");
						}
						return results.join("\\n");
					})()
				`);
				return { content: [{ type: "text", text: result }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "panda97_upload",
		label: "Panda Upload",
		description: "Upload a file to a file input element. Reads local file, injects as blob into the browser. Note: for form submission with files, use panda97_eval with FormData+fetch approach.",
		promptSnippet: "Upload file to browser file input",
		parameters: Type.Object({
			selector: Type.String({ description: "CSS selector for the file input" }),
			file: Type.String({ description: "Path to file (absolute or relative to cwd)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const resolved = path.resolve(ctx.cwd, params.file);
				if (!fs.existsSync(resolved)) {
					return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
				}
				const fileBuf = fs.readFileSync(resolved);
				const b64 = fileBuf.toString("base64");
				const fileName = path.basename(resolved);
				const ext = path.extname(resolved).toLowerCase();
				const mimeType = MIME_MAP[ext] || "application/octet-stream";
				const result = await manager.evaluateActive(`
					(async function() {
						const b64 = ${JSON.stringify(b64)};
						const binary = atob(b64);
						const bytes = new Uint8Array(binary.length);
						for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
						const blob = new Blob([bytes], {type: ${JSON.stringify(mimeType)}});
						const file = new File([blob], ${JSON.stringify(fileName)}, {type: ${JSON.stringify(mimeType)}});
						const dt = new DataTransfer();
						dt.items.add(file);
						const el = document.querySelector(${JSON.stringify(params.selector)});
						if (!el) return "Element not found: ${params.selector.replace(/"/g, "")}";
						el.files = dt.files;
						el.dispatchEvent(new Event("change", {bubbles: true}));
						return "Uploaded: ${fileName.replace(/"/g, "")} (" + el.files.length + " files)";
					})()
				`);
				return { content: [{ type: "text", text: result }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "panda97_eval",
		label: "Panda Evaluate",
		description: "Evaluate a JavaScript expression in the LightPanda page context. Returns the result value. Use for custom logic, extracting data, or complex form submissions.",
		promptSnippet: "Run JavaScript in LightPanda browser context",
		parameters: Type.Object({
			expression: Type.String({ description: "JavaScript expression to evaluate" }),
			allowWhole: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_id, params, _signal) {
			try {
				const result = await manager.evaluateActive(params.expression);
				const text = result !== undefined
					? (typeof result === "string" ? result : JSON.stringify(result, null, 2))
					: "undefined";
				return { content: [{ type: "text", text: truncateEval(text, !!params.allowWhole) }] };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "panda97_wait",
		label: "Panda Wait",
		description: "Wait for an element (CSS selector) or text to appear on the page. Polls every 500ms up to timeout.",
		promptSnippet: "Wait for element or text to appear",
		parameters: Type.Object({
			target: Type.String({ description: "CSS selector or text content to wait for" }),
			timeout: Type.Optional(Type.Number({ description: "Max wait time in ms (default 10000)", default: 10000 })),
		}),
		async execute(_id, params, signal) {
			try {
				const sel = isSelector(params.target);
				const timeout = params.timeout || 10000;
				const start = Date.now();
				while (Date.now() - start < timeout) {
					if (signal?.aborted) return { content: [{ type: "text", text: "Aborted" }], isError: true };
					const found = await manager.evaluateActive(
						sel
							? `!!document.querySelector(${JSON.stringify(params.target)})`
							: `document.body.textContent.includes(${JSON.stringify(params.target)})`
					);
					if (found) {
						return { content: [{ type: "text", text: `Found: ${params.target} (${Date.now() - start}ms)` }] };
					}
					await new Promise(r => setTimeout(r, 500));
				}
				return { content: [{ type: "text", text: `Timeout: ${params.target} (${timeout}ms)` }], isError: true };
			} catch (e: any) {
				return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
			}
		},
	});
}

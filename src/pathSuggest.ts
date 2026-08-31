import { App } from "obsidian";

/**
 * A minimal, self-contained autocomplete dropdown attached to a plain text
 * input. This deliberately does not use Obsidian's own AbstractInputSuggest
 * (or plain `document`/`window`) because those can bind to the wrong
 * Electron window when the Settings modal has been popped out into its own
 * window - `activeDocument`/`activeWindow` always resolve to whichever
 * window the input actually lives in, so this renders into those instead.
 * (Timer scheduling still goes through the global `window`, per Obsidian's
 * guidance that timer functions specifically should use `window`.)
 */
export class SimplePathSuggest {
	private containerEl: HTMLElement | null = null;
	private items: string[] = [];
	private activeIndex = -1;
	private onResize = () => this.reposition();

	constructor(
		private app: App,
		private inputEl: HTMLInputElement,
		private getCandidates: () => string[],
		private onChoose: (value: string) => void
	) {
		this.inputEl.addEventListener("input", () => this.onInput());
		this.inputEl.addEventListener("focus", () => this.onInput());
		this.inputEl.addEventListener("blur", () => {
			// Let a mousedown on a dropdown item register before we tear it down.
			window.setTimeout(() => this.close(), 150);
		});
		this.inputEl.addEventListener("keydown", (evt) => this.onKeyDown(evt));
		activeWindow.addEventListener("resize", this.onResize);
	}

	private onInput() {
		const query = this.inputEl.value.trim().toLowerCase();
		const candidates = this.getCandidates();
		this.items = (query ? candidates.filter((c) => c.toLowerCase().includes(query)) : candidates).slice(0, 20);
		this.activeIndex = -1;
		if (this.items.length === 0) {
			this.close();
			return;
		}
		this.render();
	}

	private render() {
		this.close();
		const container = activeDocument.body.createDiv({ cls: "not-submodules-suggest-container" });
		container.setCssStyles({
			position: "absolute",
			zIndex: "99999",
			background: "var(--background-primary)",
			border: "1px solid var(--background-modifier-border)",
			borderRadius: "4px",
			boxShadow: "0 2px 8px rgba(0, 0, 0, 0.2)",
			maxHeight: "220px",
			overflowY: "auto",
		});

		this.items.forEach((item, i) => {
			const itemEl = container.createDiv({ cls: "not-submodules-suggest-item", text: item });
			itemEl.setCssStyles({
				padding: "6px 10px",
				cursor: "pointer",
				background: i === this.activeIndex ? "var(--background-modifier-hover)" : "",
			});
			itemEl.addEventListener("mouseenter", () => {
				this.activeIndex = i;
				this.highlight();
			});
			// mousedown (not click) fires before the input's blur handler tears the dropdown down.
			itemEl.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				this.choose(item);
			});
		});

		this.containerEl = container;
		this.reposition();
	}

	private highlight() {
		if (!this.containerEl) return;
		Array.from(this.containerEl.children).forEach((el, i) => {
			(el as HTMLElement).setCssStyles({
				background: i === this.activeIndex ? "var(--background-modifier-hover)" : "",
			});
		});
	}

	private reposition() {
		if (!this.containerEl) return;
		const rect = this.inputEl.getBoundingClientRect();
		this.containerEl.setCssStyles({
			left: `${rect.left + activeWindow.scrollX}px`,
			top: `${rect.bottom + activeWindow.scrollY + 2}px`,
			width: `${rect.width}px`,
		});
	}

	private onKeyDown(evt: KeyboardEvent) {
		if (!this.containerEl || this.items.length === 0) return;
		if (evt.key === "ArrowDown") {
			evt.preventDefault();
			this.activeIndex = Math.min(this.activeIndex + 1, this.items.length - 1);
			this.highlight();
		} else if (evt.key === "ArrowUp") {
			evt.preventDefault();
			this.activeIndex = Math.max(this.activeIndex - 1, 0);
			this.highlight();
		} else if (evt.key === "Enter") {
			if (this.activeIndex >= 0) {
				evt.preventDefault();
				this.choose(this.items[this.activeIndex]);
			}
		} else if (evt.key === "Escape") {
			this.close();
		}
	}

	private choose(value: string) {
		this.inputEl.value = value;
		this.close();
		this.onChoose(value);
	}

	close() {
		this.containerEl?.remove();
		this.containerEl = null;
		this.activeIndex = -1;
	}
}

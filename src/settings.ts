// The settings tab. It mutates plugin.settings, then asks the plugin to persist
// and to refresh whatever is currently on screen.

import {
  ButtonComponent,
  Notice,
  PluginSettingTab,
  Setting,
  type App,
} from "obsidian";
import { DEFAULT_PALETTE, defaultSettings } from "./constants";
import { genId } from "./engine";
import { ConfirmModal } from "./ui";
import type { FileHighlights, PaletteColor, ToolbarCorner } from "./types";
import type ReadingHighlighterPlugin from "./main";

export class ReadingHighlighterSettingTab extends PluginSettingTab {
  private readonly plugin: ReadingHighlighterPlugin;

  constructor(app: App, plugin: ReadingHighlighterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("rhl-settings");

    this.renderHowTo(containerEl);
    this.renderBehaviour(containerEl);
    this.renderAppearance(containerEl);
    this.renderToolbar(containerEl);
    this.renderPalette(containerEl);
    this.renderData(containerEl);
  }

  private renderHowTo(root: HTMLElement): void {
    const intro = root.createDiv({ cls: "rhl-settings-intro" });
    intro.createEl("p", {
      text:
        "Open any note in Reading view and a compact toolbar appears in the " +
        "corner. Choose the highlighter or the underline, then drag across text " +
        "to annotate it — no edits to the note, no hotkeys to remember.",
    });
    intro.createEl("p", {
      text:
        "On a computer, click a tool to open its colours and options; right-click " +
        "to simply select it. On a phone or iPad, tap a tool to select it and " +
        "long-press to open its colours and options.",
    });
    intro.createEl("p", {
      text:
        "Tap or click any existing annotation to recolour, convert, copy, or " +
        "remove it. Annotations live with the plugin rather than inside your " +
        "notes, so the underlying Markdown is never rewritten.",
    });
  }

  private renderBehaviour(root: HTMLElement): void {
    new Setting(root).setName("Behaviour").setHeading();

    new Setting(root)
      .setName("Default tool")
      .setDesc("Which tool is selected first when the toolbar appears.")
      .addDropdown((d) =>
        d
          .addOption("highlight", "Highlighter")
          .addOption("underline", "Underline")
          .setValue(this.plugin.settings.defaultTool)
          .onChange(async (v) => {
            this.plugin.settings.defaultTool = v === "underline" ? "underline" : "highlight";
            await this.plugin.persistSettings();
          }),
      );

    new Setting(root)
      .setName("Keep tool active (sticky)")
      .setDesc("Stay armed after each annotation. Turn off to annotate one selection at a time.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.stickyTool).onChange(async (v) => {
          this.plugin.settings.stickyTool = v;
          await this.plugin.persistSettings();
        }),
      );

    new Setting(root)
      .setName("Clear selection after annotating")
      .setDesc("Deselect the text once an annotation is applied.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.clearSelectionAfter).onChange(async (v) => {
          this.plugin.settings.clearSelectionAfter = v;
          await this.plugin.persistSettings();
        }),
      );

    new Setting(root)
      .setName("Confirm before deleting")
      .setDesc("Ask for confirmation when removing an annotation.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.confirmDelete).onChange(async (v) => {
          this.plugin.settings.confirmDelete = v;
          await this.plugin.persistSettings();
        }),
      );

    new Setting(root)
      .setName("Skip code")
      .setDesc("Never annotate text inside code blocks or inline code.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.skipCodeBlocks).onChange(async (v) => {
          this.plugin.settings.skipCodeBlocks = v;
          await this.plugin.persistSettings();
          this.plugin.refreshReadingViews();
        }),
      );

    new Setting(root)
      .setName("Show annotations in Live Preview")
      .setDesc("Also paint existing annotations in the editor's Live Preview mode (read-only there).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.applyInLivePreview).onChange(async (v) => {
          this.plugin.settings.applyInLivePreview = v;
          await this.plugin.persistSettings();
          this.plugin.refreshReadingViews();
        }),
      );

    new Setting(root)
      .setName("Context length")
      .setDesc("How many characters of surrounding text to store for re-locating an annotation. Higher is more robust but uses more space.")
      .addSlider((s) =>
        s
          .setLimits(8, 80, 4)
          .setValue(this.plugin.settings.contextLength)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.contextLength = v;
            await this.plugin.persistSettings();
          }),
      );

    new Setting(root)
      .setName("Follow renames")
      .setDesc("Move a note's annotations with it when the note is renamed or moved.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.followRenames).onChange(async (v) => {
          this.plugin.settings.followRenames = v;
          await this.plugin.persistSettings();
        }),
      );

    new Setting(root)
      .setName("Delete annotations with note")
      .setDesc("Remove a note's annotations when the note itself is deleted. Off keeps them in case the note returns.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pruneOnDelete).onChange(async (v) => {
          this.plugin.settings.pruneOnDelete = v;
          await this.plugin.persistSettings();
        }),
      );
  }

  private renderAppearance(root: HTMLElement): void {
    new Setting(root).setName("Appearance").setHeading();

    new Setting(root)
      .setName("Default highlight opacity")
      .setDesc("Starting background strength for new highlights.")
      .addSlider((s) =>
        s
          .setLimits(10, 100, 5)
          .setValue(Math.round(this.plugin.settings.highlightOpacity * 100))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.highlightOpacity = v / 100;
            await this.plugin.persistSettings();
          }),
      );

    new Setting(root)
      .setName("Neon glow on highlights")
      .setDesc(
        "Wrap new highlights in a luminous halo of their own colour. The default " +
          "palette is tuned for it. Existing highlights keep the look they were " +
          "created with; you can also toggle this from the highlighter's popover.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.neonEffect).onChange(async (v) => {
          this.plugin.settings.neonEffect = v;
          await this.plugin.persistSettings();
        }),
      );

    new Setting(root)
      .setName("Brighter underlines")
      .setDesc(
        "Draw new underlines in a more vivid version of their colour. The line " +
          "alone changes — nothing is ever painted behind the text. Existing " +
          "underlines are unaffected; you can also toggle this from the underline's popover.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.brightUnderline).onChange(async (v) => {
          this.plugin.settings.brightUnderline = v;
          await this.plugin.persistSettings();
        }),
      );

    new Setting(root)
      .setName("Default underline thickness")
      .setDesc("Line thickness for new underlines, in pixels.")
      .addSlider((s) =>
        s
          .setLimits(1, 5, 1)
          .setValue(this.plugin.settings.underline.thickness)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.underline.thickness = v;
            await this.plugin.persistSettings();
          }),
      );

    new Setting(root)
      .setName("Default underline style")
      .setDesc("Line style for new underlines.")
      .addDropdown((d) =>
        d
          .addOption("solid", "Solid")
          .addOption("dashed", "Dashed")
          .addOption("dotted", "Dotted")
          .addOption("wavy", "Wavy")
          .setValue(this.plugin.settings.underline.style)
          .onChange(async (v) => {
            this.plugin.settings.underline.style =
              v as typeof this.plugin.settings.underline.style;
            await this.plugin.persistSettings();
          }),
      );

    new Setting(root)
      .setName("Default underline offset")
      .setDesc("Gap between the text baseline and the underline, in pixels.")
      .addSlider((s) =>
        s
          .setLimits(0, 8, 1)
          .setValue(this.plugin.settings.underline.offset)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.underline.offset = v;
            await this.plugin.persistSettings();
          }),
      );

    new Setting(root)
      .setName("High-contrast outline")
      .setDesc("Add a subtle border to highlights so they stay legible on low-contrast or dark themes.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.highContrast).onChange(async (v) => {
          this.plugin.settings.highContrast = v;
          await this.plugin.persistSettings();
          this.plugin.refreshReadingViews();
        }),
      );
  }

  private renderToolbar(root: HTMLElement): void {
    new Setting(root).setName("Toolbar").setHeading();

    new Setting(root)
      .setName("Swap left/right click on tool buttons")
      .setDesc(
        "When off, left-click the highlighter or underline button to pick a colour and " +
          "set options, and right-click to only select the tool. Turn this on to swap them.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.swapClickRoles).onChange(async (v) => {
          this.plugin.settings.swapClickRoles = v;
          await this.plugin.persistSettings();
          this.plugin.rebuildToolbar();
        }),
      );

    new Setting(root)
      .setName("Show toolbar in Reading view")
      .setDesc("Turn off to hide the floating toolbar. You can still use the command palette to switch tools.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showToolbar).onChange(async (v) => {
          this.plugin.settings.showToolbar = v;
          await this.plugin.persistSettings();
          this.plugin.rebuildToolbar();
        }),
      );

    new Setting(root)
      .setName("Toolbar corner")
      .setDesc("Where the toolbar docks before you drag it. This is remembered per device, so it never syncs to your other devices.")
      .addDropdown((d) =>
        d
          .addOption("tl", "Top left")
          .addOption("tr", "Top right")
          .addOption("bl", "Bottom left")
          .addOption("br", "Bottom right")
          .setValue(this.plugin.getToolbarPlacement().corner)
          .onChange((v) => {
            const p = this.plugin.getToolbarPlacement();
            p.corner = v as ToolbarCorner;
            p.x = null;
            p.y = null;
            this.plugin.saveToolbarPlacement();
            this.plugin.rebuildToolbar();
          }),
      );

    new Setting(root)
      .setName("Reset toolbar position")
      .setDesc("Clear any manual drag offset and snap the toolbar back to its corner on this device.")
      .addButton((b) =>
        b.setButtonText("Reset position").onClick(() => {
          const p = this.plugin.getToolbarPlacement();
          p.x = null;
          p.y = null;
          this.plugin.saveToolbarPlacement();
          this.plugin.rebuildToolbar();
          new Notice("Toolbar position reset.");
        }),
      );

    new Setting(root)
      .setName("Show eraser button")
      .setDesc("Show a dedicated eraser in the toolbar. Click it, then click an annotation to remove it.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showEraser).onChange(async (v) => {
          this.plugin.settings.showEraser = v;
          await this.plugin.persistSettings();
          this.plugin.rebuildToolbar();
        }),
      );

    new Setting(root)
      .setName("Show undo/redo buttons")
      .setDesc(
        "Add undo and redo buttons to the toolbar. Either way, in Reading view " +
          "you can undo with Ctrl/Cmd+Z and redo with Ctrl/Cmd+Shift+Z. History " +
          "covers the last 50 changes per note and starts fresh each time a note is opened.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showUndoRedo).onChange(async (v) => {
          this.plugin.settings.showUndoRedo = v;
          await this.plugin.persistSettings();
          this.plugin.rebuildToolbar();
        }),
      );

    new Setting(root)
      .setName("Show settings button")
      .setDesc("Show a gear in the toolbar that opens this settings page.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showSettingsButton).onChange(async (v) => {
          this.plugin.settings.showSettingsButton = v;
          await this.plugin.persistSettings();
          this.plugin.rebuildToolbar();
        }),
      );
  }

  private renderPalette(root: HTMLElement): void {
    new Setting(root).setName("Colour palette").setHeading();

    const desc = root.createEl("p", { cls: "rhl-settings-note" });
    desc.setText(
      "These colours fill every palette. The five defaults are tuned to read " +
        "well both as a glowing neon highlight and as a crisp underline. Edit a " +
        "colour here to change future annotations; existing annotations keep the " +
        "colour they were created with. You can also add a colour on the fly from " +
        "the “+” tile inside any palette.",
    );

    const list = root.createDiv({ cls: "rhl-palette-editor" });
    const repaint = () => {
      list.empty();
      this.plugin.settings.palette.forEach((color, index) =>
        this.renderPaletteRow(list, color, index, repaint),
      );
    };
    repaint();

    new Setting(root)
      .addButton((b) =>
        b
          .setButtonText("Add colour")
          .setCta()
          .onClick(async () => {
            const fresh: PaletteColor = {
              id: "c-" + genId(),
              name: "New colour",
              color: "#9e9e9e",
            };
            this.plugin.settings.palette.push(fresh);
            await this.plugin.persistSettings();
            repaint();
          }),
      )
      .addButton((b) =>
        b.setButtonText("Reset palette").onClick(async () => {
          this.plugin.settings.palette = DEFAULT_PALETTE.map((c) => ({ ...c }));
          this.ensureValidToolColours();
          await this.plugin.persistSettings();
          this.plugin.rebuildToolbar();
          repaint();
          new Notice("Palette reset to defaults.");
        }),
      );
  }

  private renderPaletteRow(
    list: HTMLElement,
    color: PaletteColor,
    index: number,
    repaint: () => void,
  ): void {
    const setting = new Setting(list).setClass("rhl-palette-row");

    setting.addColorPicker((p) =>
      p.setValue(normaliseHex(color.color)).onChange(async (v) => {
        color.color = v;
        await this.plugin.persistSettings();
        this.plugin.rebuildToolbar();
      }),
    );

    setting.addText((t) =>
      t
        .setPlaceholder("Name")
        .setValue(color.name)
        .onChange(async (v) => {
          color.name = v || "Colour";
          await this.plugin.persistSettings();
        }),
    );

    setting.addExtraButton((b) =>
      b
        .setIcon("arrow-up")
        .setTooltip("Move up")
        .setDisabled(index === 0)
        .onClick(async () => {
          if (index === 0) return;
          const arr = this.plugin.settings.palette;
          [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
          await this.plugin.persistSettings();
          this.plugin.rebuildToolbar();
          repaint();
        }),
    );

    setting.addExtraButton((b) =>
      b
        .setIcon("arrow-down")
        .setTooltip("Move down")
        .setDisabled(index === this.plugin.settings.palette.length - 1)
        .onClick(async () => {
          const arr = this.plugin.settings.palette;
          if (index >= arr.length - 1) return;
          [arr[index + 1], arr[index]] = [arr[index], arr[index + 1]];
          await this.plugin.persistSettings();
          this.plugin.rebuildToolbar();
          repaint();
        }),
    );

    setting.addExtraButton((b) =>
      b
        .setIcon("trash-2")
        .setTooltip("Delete colour")
        .setDisabled(this.plugin.settings.palette.length <= 1)
        .onClick(async () => {
          if (this.plugin.settings.palette.length <= 1) {
            new Notice("Keep at least one colour.");
            return;
          }
          this.plugin.settings.palette.splice(index, 1);
          this.ensureValidToolColours();
          await this.plugin.persistSettings();
          this.plugin.rebuildToolbar();
          repaint();
        }),
    );
  }

  // Make sure the per-tool selected colours still exist after edits.
  private ensureValidToolColours(): void {
    const ids = new Set(this.plugin.settings.palette.map((c) => c.id));
    const fallback = this.plugin.settings.palette[0]?.id ?? "c-yellow";
    if (!ids.has(this.plugin.settings.lastHighlightColorId)) {
      this.plugin.settings.lastHighlightColorId = fallback;
    }
    if (!ids.has(this.plugin.settings.lastUnderlineColorId)) {
      this.plugin.settings.lastUnderlineColorId = fallback;
    }
  }

  private renderData(root: HTMLElement): void {
    new Setting(root).setName("Data").setHeading();

    const total = this.plugin.store.totalCount();
    const files = this.plugin.store.fileCount();
    new Setting(root)
      .setName("Stored annotations")
      .setDesc(`${total} annotation${total === 1 ? "" : "s"} across ${files} note${files === 1 ? "" : "s"}.`);

    new Setting(root)
      .setName("Export all annotations")
      .setDesc("Download every annotation as a JSON backup.")
      .addButton((b) =>
        b.setButtonText("Export JSON").onClick(async () => {
          const blob = await this.plugin.store.exportAll();
          downloadJson("inkless-highlighter-backup.json", blob);
          new Notice("Exported annotations.");
        }),
      );

    new Setting(root)
      .setName("Import annotations")
      .setDesc("Merge annotations from a previously exported JSON file. Existing annotations are kept.")
      .addButton((b) =>
        b.setButtonText("Import JSON").onClick(() => {
          pickJsonFile(async (parsed) => {
            const highlights = extractHighlights(parsed);
            if (!highlights) {
              new Notice("That file does not look like a highlighter backup.");
              return;
            }
            const added = await this.plugin.store.importHighlights(highlights, false);
            await this.plugin.store.persistNow();
            this.plugin.refreshReadingViews();
            this.display();
            new Notice(`Imported ${added} annotation${added === 1 ? "" : "s"}.`);
          });
        }),
      );

    new Setting(root)
      .setName("Reset everything")
      .setDesc("Delete all annotations and restore default settings. This cannot be undone.")
      .addButton((b: ButtonComponent) =>
        b
          .setButtonText("Reset all")
          .setWarning()
          .onClick(() => {
            new ConfirmModal(this.plugin.app, {
              title: "Reset everything",
              message: "Delete all annotations and reset settings? This cannot be undone.",
              confirmText: "Reset all",
              warning: true,
              onConfirm: async () => {
                await this.plugin.resetAll(defaultSettings());
                this.display();
                new Notice("All annotations cleared and settings reset.");
              },
            }).open();
          }),
      );
  }
}

// Coerce arbitrary colour strings to a 6-digit hex the colour picker accepts.
function normaliseHex(input: string): string {
  let h = input.trim();
  if (!h.startsWith("#")) h = "#" + h;
  if (/^#[0-9a-fA-F]{3}$/.test(h)) {
    h = "#" + h.slice(1).split("").map((c) => c + c).join("");
  }
  return /^#[0-9a-fA-F]{6}$/.test(h) ? h : "#9e9e9e";
}

// Trigger a client-side download of a JSON-serialisable value.
function downloadJson(filename: string, data: unknown): void {
  const text = JSON.stringify(data, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Open a file picker for a single JSON file and parse it.
function pickJsonFile(onParsed: (data: unknown) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        onParsed(JSON.parse(String(reader.result)));
      } catch {
        new Notice("Could not read that file as JSON.");
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

// Accept either a full export blob or a bare file-highlights map.
function extractHighlights(parsed: unknown): FileHighlights | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const candidate =
    "highlights" in obj && obj.highlights && typeof obj.highlights === "object"
      ? obj.highlights
      : obj;
  if (!candidate || typeof candidate !== "object") return null;
  // Shallow shape check: values should be arrays.
  const values = Object.values(candidate as Record<string, unknown>);
  if (values.length > 0 && !values.every((v) => Array.isArray(v))) return null;
  return candidate as FileHighlights;
}

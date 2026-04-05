import { App, PluginSettingTab, Setting } from 'obsidian';
import type MementoMoriPlugin from './main';

export interface MementoSettings {
  /** Vault-relative path to the folder containing memento mori MD entry files. */
  entriesDir: string;
  /** Birth date in YYYY-MM-DD format. Day 0 of the visualization. */
  birthDate: string;
}

export const DEFAULT_SETTINGS: MementoSettings = {
  entriesDir: 'Memento Mori',
  birthDate: '1994-12-29',
};

export class MementoSettingTab extends PluginSettingTab {
  plugin: MementoMoriPlugin;

  constructor(app: App, plugin: MementoMoriPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Birth date')
      .setDesc('Your birth date in YYYY-MM-DD format. This is day 0 of the visualization.')
      .addText(text =>
        text
          .setPlaceholder('YYYY-MM-DD')
          .setValue(this.plugin.settings.birthDate)
          .onChange(async (value) => {
            this.plugin.settings.birthDate = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Entries folder')
      .setDesc(
        'Vault-relative path to the folder containing your memento mori Markdown files. ' +
        'Each file should have mm: range or mm: event in its frontmatter.'
      )
      .addText(text =>
        text
          .setPlaceholder('Memento Mori')
          .setValue(this.plugin.settings.entriesDir)
          .onChange(async (value) => {
            this.plugin.settings.entriesDir = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}

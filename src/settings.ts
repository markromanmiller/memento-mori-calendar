import { App, PluginSettingTab, Setting } from 'obsidian';
import type MementoMoriPlugin from './main';
import { SCHEDULE_DEFAULTS } from './data';

export interface MementoSettings {
  /** Vault-relative path to the folder containing memento mori MD entry files. */
  entriesDir: string;
  /** Birth date in YYYY-MM-DD format. Day 0 of the visualization. */
  birthDate: string;
  /**
   * Degrees subtracted from 90° to get the Hilbert curve turn angle.
   * At 0 the curve has perfect right angles; higher values introduce a
   * diagonal drift that gives the visualization a more organic look.
   * Default: 1 (turnAngle = 89°).
   */
  curveSkew: number;
  /** Daily sleep window, "HH:MM-HH:MM" (may wrap past midnight). */
  sleepHours: string;
  /** Work window on work days, "HH:MM-HH:MM". */
  workHours: string;
  /** Work days, e.g. "Mon-Fri" or "Mon,Tue,Thu". */
  workDays: string;
}

export const DEFAULT_SETTINGS: MementoSettings = {
  entriesDir: 'Memento Mori',
  birthDate: '2000-01-01',
  curveSkew: 1,
  ...SCHEDULE_DEFAULTS,
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
      .setName('Curve skew')
      .setDesc(
        'Degrees subtracted from a perfect 90° turn. ' +
        'Higher values give the curve a more diagonal, organic appearance. ' +
        'Default: 1. Changing this rebuilds the entire geometry.'
      )
      .addText(text =>
        text
          .setPlaceholder('1')
          .setValue(String(this.plugin.settings.curveSkew))
          .onChange(async (value) => {
            const n = parseFloat(value);
            if (!isNaN(n) && n >= 0 && n < 90) {
              this.plugin.settings.curveSkew = n;
              await this.plugin.saveSettings();
            }
          })
      );

    const textSetting = (name: string, desc: string, key: 'sleepHours' | 'workHours' | 'workDays', placeholder: string) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText(text =>
          text
            .setPlaceholder(placeholder)
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
              this.plugin.settings[key] = value.trim();
              await this.plugin.saveSettings();
            })
        );
    textSetting('Sleep hours', 'Shown in the Default colors. HH:MM-HH:MM; may run past midnight.', 'sleepHours', '21:30-05:30');
    textSetting('Work hours', 'On work days. HH:MM-HH:MM.', 'workHours', '08:00-16:00');
    textSetting('Work days', 'Mon-Thu, or a list like Mon,Tue,Thu.', 'workDays', 'Mon-Thu');

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

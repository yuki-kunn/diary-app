import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';

interface DiaryNote {
	id: string; // = date (YYYY-MM-DD)
	date: string;
	title: string;
	text: string;
	mood: string | null;
	moodEmoji: string | null;
	photoIds: string[];
	updatedAt: number;
}

interface DiaryExportResponse {
	exportedAt: string;
	count: number;
	ids: string[];
	notes: DiaryNote[];
}

interface HidamariSyncSettings {
	backendUrl: string;
	apiToken: string;
	syncFolder: string;
	attachmentFolder: string;
	syncIntervalMinutes: number;
	syncOnStart: boolean;
	deleteMissingNotes: boolean;
}

const DEFAULT_SETTINGS: HidamariSyncSettings = {
	backendUrl: '',
	apiToken: '',
	syncFolder: 'ひだまり日記',
	attachmentFolder: 'ひだまり日記/attachments',
	syncIntervalMinutes: 15,
	syncOnStart: true,
	deleteMissingNotes: true,
};

export default class HidamariSyncPlugin extends Plugin {
	settings!: HidamariSyncSettings;
	private syncTimer: number | null = null;
	private statusBarItem!: HTMLElement;
	private syncing = false;

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar('待機中');

		this.addRibbonIcon('refresh-cw', 'ひだまり日記と同期', () => {
			this.runSync();
		});

		this.addCommand({
			id: 'hidamari-sync-now',
			name: '今すぐ同期',
			callback: () => this.runSync(),
		});

		this.addSettingTab(new HidamariSyncSettingTab(this.app, this));

		this.scheduleSync();

		if (this.settings.syncOnStart) {
			// Vaultの初期化が終わってから最初の同期を走らせる。
			this.app.workspace.onLayoutReady(() => {
				if (this.isConfigured()) this.runSync();
			});
		}
	}

	onunload() {
		this.clearSyncTimer();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.scheduleSync();
	}

	isConfigured(): boolean {
		return !!this.settings.backendUrl && !!this.settings.apiToken;
	}

	private clearSyncTimer() {
		if (this.syncTimer !== null) {
			window.clearInterval(this.syncTimer);
			this.syncTimer = null;
		}
	}

	scheduleSync() {
		this.clearSyncTimer();
		if (!this.isConfigured() || this.settings.syncIntervalMinutes <= 0) return;
		const ms = this.settings.syncIntervalMinutes * 60 * 1000;
		this.syncTimer = window.setInterval(() => this.runSync(), ms);
		this.registerInterval(this.syncTimer);
	}

	private updateStatusBar(text: string) {
		this.statusBarItem.setText(`ひだまり日記: ${text}`);
	}

	async runSync() {
		if (this.syncing) return;
		if (!this.isConfigured()) {
			new Notice('ひだまり日記 Sync: バックエンドURLとAPIトークンを設定してください');
			return;
		}

		this.syncing = true;
		this.updateStatusBar('同期中...');
		try {
			const data = await this.fetchExport();
			const { created, updated, deleted, photos } = await this.applyExport(data);
			this.updateStatusBar(`同期完了 (${new Date().toLocaleTimeString('ja-JP')})`);
			if (created + updated + deleted + photos > 0) {
				new Notice(`ひだまり日記 Sync: 新規${created} / 更新${updated} / 削除${deleted} / 写真${photos}`);
			}
		} catch (err) {
			console.error('Hidamari Sync failed:', err);
			this.updateStatusBar('同期失敗');
			new Notice(`ひだまり日記 Sync 失敗: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.syncing = false;
		}
	}

	private authHeaders(): Record<string, string> {
		return { Authorization: `Bearer ${this.settings.apiToken}` };
	}

	private backendBase(): string {
		return this.settings.backendUrl.replace(/\/+$/, '');
	}

	private async fetchExport(): Promise<DiaryExportResponse> {
		const res = await requestUrl({
			url: `${this.backendBase()}/api/obsidian/export`,
			method: 'GET',
			headers: this.authHeaders(),
			throw: false,
		});

		if (res.status === 401 || res.status === 403) {
			throw new Error('認証エラー。APIトークンを確認してください');
		}
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`APIエラー (HTTP ${res.status})`);
		}
		return res.json as DiaryExportResponse;
	}

	private async ensureFolder(path: string) {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) return;
		if (existing) throw new Error(`同期先 "${path}" は既にファイルとして存在します`);
		await this.app.vault.createFolder(path).catch((err) => {
			if (!String(err?.message ?? err).includes('already exists')) throw err;
		});
	}

	private buildFrontmatter(note: DiaryNote, photoFilenames: string[]): string {
		const lines: string[] = ['---', `hidamari_id: ${note.id}`, `date: ${note.date}`];
		if (note.title) lines.push(`title: "${escapeYaml(note.title)}"`);
		if (note.mood) lines.push(`mood: ${note.mood}`);
		if (note.moodEmoji) lines.push(`mood_emoji: "${note.moodEmoji}"`);
		lines.push('tags: [diary]');
		if (photoFilenames.length) {
			lines.push(`photos: [${photoFilenames.map((fn) => `"${fn}"`).join(', ')}]`);
		}
		lines.push(`hidamari_synced_at: ${new Date().toISOString()}`);
		lines.push('---');
		return lines.join('\n');
	}

	private buildBody(note: DiaryNote, photoFilenames: string[]): string {
		const parts: string[] = [];
		parts.push(`# ${note.title || note.date}`);
		parts.push('');
		if (note.text) {
			parts.push(note.text);
			parts.push('');
		}
		if (photoFilenames.length) {
			parts.push('## 写真');
			photoFilenames.forEach((fn) => parts.push(`![[${fn}]]`));
			parts.push('');
		}
		return parts.join('\n');
	}

	private noteFileName(note: DiaryNote): string {
		return `${note.date}.md`;
	}

	private photoFileName(note: DiaryNote, index: number): string {
		return `${note.date}-${index + 1}.jpg`;
	}

	// 写真は容量が大きいため、Vault内に同名ファイルが既に存在すれば再ダウンロードしない。
	private async ensurePhoto(photoId: string, path: string): Promise<boolean> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return false;

		const res = await requestUrl({
			url: `${this.backendBase()}/api/obsidian/photo/${photoId}`,
			method: 'GET',
			headers: this.authHeaders(),
			throw: false,
		});
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`写真の取得に失敗しました (${photoId}, HTTP ${res.status})`);
		}
		await this.app.vault.createBinary(path, res.arrayBuffer);
		return true;
	}

	private async applyExport(
		data: DiaryExportResponse
	): Promise<{ created: number; updated: number; deleted: number; photos: number }> {
		const folder = normalizePath(this.settings.syncFolder || 'ひだまり日記');
		const attachmentFolder = normalizePath(this.settings.attachmentFolder || `${folder}/attachments`);
		await this.ensureFolder(folder);
		await this.ensureFolder(attachmentFolder);

		let created = 0;
		let updated = 0;
		let deleted = 0;
		let photos = 0;

		// hidamari_id frontmatterで既存ノートを突き合わせる(ファイル名変更に強くするため)。
		const existingByHidamariId = new Map<string, TFile>();
		const folderFile = this.app.vault.getAbstractFileByPath(folder);
		if (folderFile instanceof TFolder) {
			for (const file of folderFile.children) {
				if (!(file instanceof TFile) || file.extension !== 'md') continue;
				const cache = this.app.metadataCache.getFileCache(file);
				const id = cache?.frontmatter?.hidamari_id;
				if (typeof id === 'string') existingByHidamariId.set(id, file);
			}
		}

		for (const note of data.notes) {
			const photoFilenames: string[] = [];
			for (let i = 0; i < note.photoIds.length; i++) {
				const filename = this.photoFileName(note, i);
				const path = normalizePath(`${attachmentFolder}/${filename}`);
				if (await this.ensurePhoto(note.photoIds[i], path)) photos++;
				photoFilenames.push(filename);
			}

			const content = `${this.buildFrontmatter(note, photoFilenames)}\n\n${this.buildBody(note, photoFilenames)}\n`;
			const existing = existingByHidamariId.get(note.id);
			if (existing) {
				const prev = await this.app.vault.read(existing);
				if (prev !== content) {
					await this.app.vault.modify(existing, content);
					updated++;
				}
				existingByHidamariId.delete(note.id);
			} else {
				const path = normalizePath(`${folder}/${this.noteFileName(note)}`);
				await this.app.vault.create(path, content);
				created++;
			}
		}

		// exportに含まれなかった日付 = サーバー側で削除された日記。
		if (this.settings.deleteMissingNotes) {
			for (const file of existingByHidamariId.values()) {
				await this.app.vault.trash(file, true);
				deleted++;
			}
		}

		return { created, updated, deleted, photos };
	}
}

function escapeYaml(s: string): string {
	return s.replace(/"/g, '\\"');
}

class HidamariSyncSettingTab extends PluginSettingTab {
	plugin: HidamariSyncPlugin;

	constructor(app: App, plugin: HidamariSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'ひだまり日記 Sync 設定' });
		containerEl.createEl('p', {
			text: 'APIトークンは、ひだまり日記アプリの設定画面「Obsidian連携」から発行できます。',
		});

		new Setting(containerEl)
			.setName('バックエンドURL')
			.setDesc('例: https://your-app.up.railway.app （末尾のスラッシュ不要）')
			.addText((text) =>
				text
					.setPlaceholder('https://your-app.up.railway.app')
					.setValue(this.plugin.settings.backendUrl)
					.onChange(async (value) => {
						this.plugin.settings.backendUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('APIトークン')
			.setDesc('アプリの設定画面で発行した hdmr_ から始まるトークン')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('hdmr_xxxxxxxxxxxxxxxx')
					.setValue(this.plugin.settings.apiToken)
					.onChange(async (value) => {
						this.plugin.settings.apiToken = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('同期先フォルダ')
			.setDesc('Vault内の相対パス')
			.addText((text) =>
				text
					.setPlaceholder('ひだまり日記')
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncFolder = value.trim() || 'ひだまり日記';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('写真の保存先フォルダ')
			.setDesc('Vault内の相対パス')
			.addText((text) =>
				text
					.setPlaceholder('ひだまり日記/attachments')
					.setValue(this.plugin.settings.attachmentFolder)
					.onChange(async (value) => {
						this.plugin.settings.attachmentFolder = value.trim() || 'ひだまり日記/attachments';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('自動同期間隔(分)')
			.setDesc('0を指定すると自動同期を無効化(コマンド/リボンからの手動同期のみ)')
			.addText((text) =>
				text
					.setPlaceholder('15')
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.syncIntervalMinutes = Number.isFinite(n) && n >= 0 ? n : 15;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('起動時に同期')
			.setDesc('Obsidian起動直後に一度同期を実行する')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnStart).onChange(async (value) => {
					this.plugin.settings.syncOnStart = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('削除同期を有効化')
			.setDesc('アプリ側で削除された日記に対応するノートを自動的にゴミ箱へ移動する')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.deleteMissingNotes).onChange(async (value) => {
					this.plugin.settings.deleteMissingNotes = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('今すぐ同期')
			.setDesc('設定を確認したら、一度手動で同期して動作確認してください')
			.addButton((button) =>
				button.setButtonText('同期実行').setCta().onClick(() => this.plugin.runSync())
			);
	}
}

import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Menu } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';
import { SplitSegmentRequest, TagUpdatePayload } from '../shared/models';
import { DatabaseService } from './services/DatabaseService';
import { LibraryService } from './services/LibraryService';
import { SearchService } from './services/SearchService';
import { SettingsService } from './services/SettingsService';
import { TagService } from './services/TagService';

/**
 * Central application coordinator responsible for bootstrapping Electron and wiring IPC handlers.
 */
export class MainApp {
  private mainWindow: BrowserWindow | null = null;
  private database: DatabaseService | null = null;
  private settingsService: SettingsService | null = null;
  private libraryService: LibraryService | null = null;
  private searchService: SearchService | null = null;

  /**
   * Entry point called once Electron is ready.
   */
  public async initialize(): Promise<void> {
    nativeTheme.themeSource = 'dark';
    const userData = app.getPath('userData');
    const dbPath = path.join(userData, 'audiosort', 'audiosort.db');

    this.database = new DatabaseService(dbPath);
    this.database.initialize();

    this.settingsService = new SettingsService(this.database);
    const tagService = new TagService(this.database);
    this.searchService = new SearchService(this.database, tagService);
    this.libraryService = new LibraryService(
      this.database,
      this.settingsService,
      tagService,
      this.searchService
    );

  const catalogPath = this.resolveResourcePath(path.join('data', 'UCS.csv'));
    await this.libraryService.ensureCategoriesLoaded(catalogPath);
    await this.libraryService.scanLibrary();

    this.searchService.rebuildIndex();
    this.registerIpcHandlers();
    await this.createMenu();
    this.createWindow();
  }

  /**
   * Creates the application menu.
   */
  private async createMenu(): Promise<void> {
    const isMac = process.platform === 'darwin';
    const drives = await this.listAvailableDrives();
    
    const driveSubmenu: Electron.MenuItemConstructorOptions[] = drives.map((drive) => ({
      label: drive.label,
      click: () => this.mainWindow?.webContents.send('import-from-drive', drive.path)
    }));

    const template: Electron.MenuItemConstructorOptions[] = [
      ...(isMac ? [{
        label: app.name,
        submenu: [
          { role: 'about' as const },
          { type: 'separator' as const },
          { 
            label: 'Settings',
            accelerator: 'Cmd+,',
            click: () => this.mainWindow?.webContents.send('open-settings')
          },
          { type: 'separator' as const },
          { role: 'hide' as const },
          { role: 'hideOthers' as const },
          { role: 'unhide' as const },
          { type: 'separator' as const },
          { role: 'quit' as const }
        ]
      }] : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'Import From Folder...',
            accelerator: isMac ? 'Cmd+Shift+I' : 'Ctrl+Shift+I',
            click: () => this.mainWindow?.webContents.send('import-from-folder')
          },
          {
            label: 'Import From Drive',
            submenu: driveSubmenu.length > 0 ? driveSubmenu : [{ label: 'No drives available', enabled: false }]
          },
          { type: 'separator' as const },
          {
            label: 'Rescan Library',
            accelerator: isMac ? 'Cmd+R' : 'Ctrl+R',
            click: () => this.mainWindow?.webContents.send('rescan-library')
          },
          { type: 'separator' as const },
          ...(!isMac ? [
            { 
              label: 'Settings',
              accelerator: 'Ctrl+,',
              click: () => this.mainWindow?.webContents.send('open-settings')
            },
            { type: 'separator' as const }
          ] : []),
          ...(isMac ? [{ role: 'close' as const }] : [{ role: 'quit' as const }])
        ]
      },
      {
        label: 'Tools',
        submenu: [
          {
            label: 'Find Duplicates',
            click: () => this.mainWindow?.webContents.send('find-duplicates')
          }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' as const },
          { role: 'forceReload' as const },
          { role: 'toggleDevTools' as const },
          { type: 'separator' as const },
          { role: 'resetZoom' as const },
          { role: 'zoomIn' as const },
          { role: 'zoomOut' as const },
          { type: 'separator' as const },
          { role: 'togglefullscreen' as const }
        ]
      }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  }

  /**
   * Gracefully releases resources during application shutdown.
   */
  public dispose(): void {
    ipcMain.removeHandler(IPC_CHANNELS.settingsGet);
    ipcMain.removeHandler(IPC_CHANNELS.settingsSetLibrary);
    ipcMain.removeHandler(IPC_CHANNELS.dialogSelectLibrary);
    ipcMain.removeHandler(IPC_CHANNELS.dialogSelectImportFolder);
    ipcMain.removeHandler(IPC_CHANNELS.systemListDrives);
    ipcMain.removeHandler(IPC_CHANNELS.libraryScan);
    ipcMain.removeHandler(IPC_CHANNELS.libraryList);
    ipcMain.removeHandler(IPC_CHANNELS.libraryRename);
    ipcMain.removeHandler(IPC_CHANNELS.libraryMove);
    ipcMain.removeHandler(IPC_CHANNELS.libraryOrganize);
    ipcMain.removeHandler(IPC_CHANNELS.libraryBuffer);
  ipcMain.removeHandler(IPC_CHANNELS.libraryMetadata);
  ipcMain.removeHandler(IPC_CHANNELS.libraryMetadataSuggestions);
  ipcMain.removeHandler(IPC_CHANNELS.libraryUpdateMetadata);
   ipcMain.removeHandler(IPC_CHANNELS.librarySplit);
    ipcMain.removeHandler(IPC_CHANNELS.libraryWaveformPreview);
    ipcMain.removeHandler(IPC_CHANNELS.libraryWaveformRange);
    ipcMain.removeHandler(IPC_CHANNELS.libraryImport);
    ipcMain.removeHandler(IPC_CHANNELS.tagsUpdate);
    ipcMain.removeHandler(IPC_CHANNELS.categoriesList);
    ipcMain.removeHandler(IPC_CHANNELS.searchQuery);
    this.database?.close();
  }

  /**
   * Reopens the renderer window when requested (for macOS style activate behaviour).
   */
  public ensureWindow(): void {
    if (this.mainWindow) {
      this.mainWindow.focus();
      return;
    }
    this.createWindow();
  }

  /**
   * Creates the renderer window and loads the UI.
   */
  private createWindow(): void {
  const preloadPath = this.resolvePreloadPath();
    this.mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      backgroundColor: '#111518',
      show: false,
      title: 'AudioSort',
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false
      }
    });

    this.mainWindow.on('ready-to-show', () => {
      this.mainWindow?.show();
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    const devServerUrl = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
      this.mainWindow.loadURL(devServerUrl).catch((error: unknown) => {
        // eslint-disable-next-line no-console -- Logging is useful during development to diagnose boot issues.
        console.error('Failed to load renderer URL', error);
      });
    } else {
      const rendererIndex = this.resolveRendererIndex();
      this.mainWindow
        .loadFile(rendererIndex)
        .catch((error: unknown) => console.error('Failed to load renderer bundle', error));
    }
  }

  /**
   * Wires IPC handlers that power the renderer bridge API.
   */
  private registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.settingsGet, async () => this.requireSettings().getSettings());

    ipcMain.handle(IPC_CHANNELS.settingsSetLibrary, async (_event: IpcMainInvokeEvent, targetPath: string) => {
      const settings = this.requireSettings().updateLibraryPath(targetPath);
      await this.requireLibrary().scanLibrary();
      return settings;
    });

    ipcMain.handle(IPC_CHANNELS.dialogSelectLibrary, async () => {
      const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
      const targetWindow = this.mainWindow;
      const result = targetWindow
        ? await dialog.showOpenDialog(targetWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    });

    ipcMain.handle(IPC_CHANNELS.dialogSelectImportFolder, async () => {
      const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
      const targetWindow = this.mainWindow;
      const result = targetWindow
        ? await dialog.showOpenDialog(targetWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    });

    ipcMain.handle(IPC_CHANNELS.systemListDrives, async () => this.listAvailableDrives());

    ipcMain.handle(IPC_CHANNELS.libraryScan, async () => this.requireLibrary().scanLibrary());
    ipcMain.handle(IPC_CHANNELS.libraryList, async () => this.requireLibrary().listFiles());
    ipcMain.handle(IPC_CHANNELS.libraryGetById, async (_event: IpcMainInvokeEvent, fileId: number) =>
      this.requireLibrary().getFileById(fileId)
    );
    ipcMain.handle(IPC_CHANNELS.libraryDuplicates, async () => this.requireLibrary().listDuplicates());
    ipcMain.handle(IPC_CHANNELS.searchQuery, async (_event: IpcMainInvokeEvent, query: string) =>
      this.requireSearch().search(query)
    );

    ipcMain.handle(IPC_CHANNELS.libraryRename, async (_event: IpcMainInvokeEvent, fileId: number, newName: string) =>
      this.requireLibrary().renameFile(fileId, newName)
    );

    ipcMain.handle(
      IPC_CHANNELS.libraryMove,
      async (_event: IpcMainInvokeEvent, fileId: number, targetRelativeDirectory: string) =>
      this.requireLibrary().moveFile(fileId, targetRelativeDirectory)
    );

    ipcMain.handle(
      IPC_CHANNELS.libraryOrganize,
      async (
        _event: IpcMainInvokeEvent,
        fileId: number,
        metadata: { customName?: string | null; author?: string | null; copyright?: string | null; rating?: number }
      ) =>
      this.requireLibrary().organizeFile(fileId, metadata)
    );

    ipcMain.handle(
      IPC_CHANNELS.libraryCustomName,
      async (_event: IpcMainInvokeEvent, fileId: number, customName: string | null) =>
      this.requireLibrary().updateCustomName(fileId, customName)
    );

    ipcMain.handle(IPC_CHANNELS.libraryOpenFolder, async (_event: IpcMainInvokeEvent, fileId: number) =>
      this.requireLibrary().openFileFolder(fileId)
    );

    ipcMain.handle(IPC_CHANNELS.libraryDelete, async (_event: IpcMainInvokeEvent, fileIds: number[]) =>
      this.requireLibrary().deleteFiles(fileIds)
    );

    ipcMain.handle(
      IPC_CHANNELS.librarySplit,
      async (_event: IpcMainInvokeEvent, fileId: number, segments: SplitSegmentRequest[]) =>
        this.requireLibrary().splitFile(fileId, segments)
    );

    ipcMain.handle(IPC_CHANNELS.libraryBuffer, async (_event: IpcMainInvokeEvent, fileId: number) =>
      this.requireLibrary().getAudioBuffer(fileId)
    );

    ipcMain.handle(
      IPC_CHANNELS.libraryWaveformPreview,
      async (_event: IpcMainInvokeEvent, fileId: number, pointCount: number | undefined) =>
        this.requireLibrary().getWaveformPreview(fileId, pointCount)
    );

    ipcMain.handle(
      IPC_CHANNELS.libraryWaveformRange,
      async (_event: IpcMainInvokeEvent, fileId: number, startMs: number, endMs: number) =>
        this.requireLibrary().getWaveformRange(fileId, startMs, endMs)
    );

    ipcMain.handle(IPC_CHANNELS.tagsUpdate, async (_event: IpcMainInvokeEvent, payload: TagUpdatePayload) =>
      this.requireLibrary().updateTagging(payload)
    );

    ipcMain.handle(IPC_CHANNELS.categoriesList, async () => this.requireLibrary().listCategories());

    ipcMain.handle(IPC_CHANNELS.libraryMetadata, async (_event: IpcMainInvokeEvent, fileId: number) =>
      this.requireLibrary().readFileMetadata(fileId)
    );

    ipcMain.handle(IPC_CHANNELS.libraryMetadataSuggestions, async () =>
      this.requireLibrary().listMetadataSuggestions()
    );

    ipcMain.handle(
      IPC_CHANNELS.libraryUpdateMetadata,
      async (
        _event: IpcMainInvokeEvent,
        fileId: number,
        metadata: { author?: string | null; copyright?: string | null; rating?: number }
      ) =>
        this.requireLibrary().updateFileMetadata(fileId, metadata)
    );

    ipcMain.handle(IPC_CHANNELS.libraryImport, async (_event: IpcMainInvokeEvent, payload: unknown) => {
      if (!Array.isArray(payload)) {
        throw new Error('Import request must provide an array of source paths.');
      }
      const sources = payload
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0);
      if (sources.length === 0) {
        return { imported: [], skipped: [], failed: [] };
      }
      return this.requireLibrary().importExternalSources(sources);
    });
  }

  /**
   * Resolves resources that may live either beside the compiled output or in the project root in development.
   */
  private resolveResourcePath(relativePath: string): string {
    for (const base of this.buildSearchBases()) {
      const candidate = path.resolve(base, relativePath);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw new Error(`Resource ${relativePath} could not be located.`);
  }

  private resolvePreloadPath(): string {
    const relativeCandidates = [
      'dist/main/preload/index.js',
      'main/preload/index.js',
      'preload/index.js',
      'src/preload/index.js'
    ];
    for (const base of this.buildSearchBases()) {
      for (const relative of relativeCandidates) {
        const candidate = path.resolve(base, relative);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
    throw new Error('Unable to resolve preload script.');
  }

  private resolveRendererIndex(): string {
    const relativeCandidates = ['dist/renderer/index.html', 'renderer/index.html', 'src/renderer/index.html'];
    for (const base of this.buildSearchBases()) {
      for (const relative of relativeCandidates) {
        const candidate = path.resolve(base, relative);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
    throw new Error('Renderer bundle not found.');
  }

  private resolveCwdFallback(): string {
    const processRef = (globalThis as { process?: { cwd?: () => string } }).process;
    if (processRef?.cwd) {
      return processRef.cwd();
    }
    return app.getAppPath();
  }

  private async listAvailableDrives(): Promise<Array<{ path: string; label: string }>> {
    if (process.platform === 'win32') {
      try {
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);
        
        // Query Windows Management Instrumentation for drive info
        const { stdout } = await execAsync('wmic logicaldisk get deviceid,drivetype', { 
          timeout: 5000,
          windowsHide: true 
        });
        
        const lines = stdout.trim().split('\n').slice(1); // Skip header
        const drives: Array<{ path: string; type: string }> = [];
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          
          // Parse "C:            3" format (DeviceID and DriveType)
          const match = trimmed.match(/^([A-Z]:)\s+(\d+)$/);
          if (!match) continue;
          
          const [, deviceId, driveType] = match;
          const drivePath = `${deviceId}\\`;
          
          // Verify drive is actually accessible before including it
          try {
            await fs.promises.access(drivePath);
          } catch {
            continue; // Skip if not accessible (unplugged/ejected)
          }
          
          // DriveType: 2=Removable, 3=Local Fixed, 4=Network, 5=CD-ROM, 6=RAM Disk
          let label = drivePath;
          if (driveType === '2') {
            label = `${drivePath} (Removable)`;
          }
          
          drives.push({ path: drivePath, type: label });
        }
        
        return drives.sort((a, b) => a.path.localeCompare(b.path)).map((d) => ({ path: d.path, label: d.type }));
      } catch (error) {
        console.warn('Failed to query drive types via wmic, falling back to simple enumeration', error);
        // Fallback to basic enumeration
        const drives: { path: string; label: string }[] = [];
        const probes: Promise<void>[] = [];
        for (let code = 65; code <= 90; code += 1) {
          const letter = String.fromCharCode(code);
          const drivePath = `${letter}:\\`;
          const probe = fs.promises
            .access(drivePath)
            .then(() => {
              drives.push({ path: drivePath, label: drivePath });
            })
            .catch(() => undefined);
          probes.push(probe);
        }
        await Promise.all(probes);
        return drives.sort((a, b) => a.path.localeCompare(b.path));
      }
    }

    if (process.platform === 'darwin') {
      try {
        const entries = await fs.promises.readdir('/Volumes', { withFileTypes: true });
        const volumes = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ path: path.join('/Volumes', entry.name), label: path.join('/Volumes', entry.name) }));
        return volumes.length > 0 ? volumes : [{ path: '/', label: '/' }];
      } catch {
        return [{ path: '/', label: '/' }];
      }
    }

    return [{ path: '/', label: '/' }];
  }

  private buildSearchBases(): string[] {
    const bases = new Set<string>();
    const appPath = app.getAppPath();
    bases.add(appPath);
    bases.add(path.resolve(appPath, '..'));
    bases.add(this.resolveCwdFallback());
    return Array.from(bases);
  }

  private requireSettings(): SettingsService {
    if (!this.settingsService) {
      throw new Error('SettingsService has not been initialised.');
    }
    return this.settingsService;
  }

  private requireLibrary(): LibraryService {
    if (!this.libraryService) {
      throw new Error('LibraryService has not been initialised.');
    }
    return this.libraryService;
  }

  private requireSearch(): SearchService {
    if (!this.searchService) {
      throw new Error('SearchService has not been initialised.');
    }
    return this.searchService;
  }
}

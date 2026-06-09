import { ExtensionContext, Memento, workspace } from 'vscode';
import { Strings } from './strings';

/**
 * The extension's runtime settings (showNames/showSelections) and workspace-state
 * store, injected into Param/JsonFile rather than reached for as globals.
 */
export class ExtensionConfig {
    private static readonly DEFAULT_SHOW_NAMES = false;
    private static readonly DEFAULT_SHOW_SELECTIONS = true;

    showNames = ExtensionConfig.DEFAULT_SHOW_NAMES;
    showSelections = ExtensionConfig.DEFAULT_SHOW_SELECTIONS;

    constructor(private readonly context: ExtensionContext) {
        this.loadSettings();
    }

    /** Persistent, workspace-scoped storage for the selected values. */
    get workspaceState(): Memento {
        return this.context.workspaceState;
    }

    /**
     * Reloads showNames/showSelections from the configuration.
     * @returns true if either value changed.
     */
    loadSettings(): boolean {
        const config = workspace.getConfiguration(Strings.EXTENSION_ID);
        const showNames = config.get<boolean>('showNames', ExtensionConfig.DEFAULT_SHOW_NAMES);
        const showSelections = config.get<boolean>('showSelections', ExtensionConfig.DEFAULT_SHOW_SELECTIONS);
        const changed = showNames !== this.showNames || showSelections !== this.showSelections;
        this.showNames = showNames;
        this.showSelections = showSelections;
        return changed;
    }
}

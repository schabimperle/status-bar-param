import { Event, EventEmitter, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
import { JsonFile } from './jsonFile';
import { Param } from './param';
import { Strings } from './strings';

/** What the tree-data change emitter carries (a changed node, or undefined to refresh the root). */
export type TreeChangeEmitter = EventEmitter<JsonFile | Param | undefined | null | void>;

/**
 * Tree view data: files with params as top-level nodes, their Params as children.
 * The change emitter is injected (owned by the extension) so Param and JsonFile
 * can fire refreshes without reaching for global state.
 */
export class ParameterProvider implements TreeDataProvider<JsonFile | Param> {
    readonly onDidChangeTreeData: Event<JsonFile | Param | undefined | null | void>;

    constructor(
        private jsonFiles: JsonFile[],
        emitter: TreeChangeEmitter,
    ) {
        this.onDidChangeTreeData = emitter.event;
    }

    getTreeItem(element: JsonFile | Param): TreeItem {
        if (element instanceof JsonFile) {
            return {
                resourceUri: element.uri,
                iconPath: ThemeIcon.File,
                description: element.getDescription(),
                collapsibleState: TreeItemCollapsibleState.Expanded,
                contextValue: 'JsonFile',
                command: {
                    title: 'Open',
                    command: 'vscode.open',
                    arguments: [element.uri],
                },
            };
        } else {
            return {
                label: element.id,
                description: element.getSelectionText(),
                iconPath: element.getIcon(),
                contextValue: 'Param',
                command: {
                    title: 'Select',
                    command: Strings.COMMAND_SELECT,
                    arguments: [element],
                },
            };
        }
    }

    getChildren(element?: JsonFile) {
        if (!element) {
            // only show files that have params, ordered like the wizard picker: local
            // config files first, then the .code-workspace, then the user tasks.json last
            // (stable within a tier). filter() returns a fresh array, so the sort is safe.
            return this.jsonFiles.filter((jsonFile) => jsonFile.hasParams()).sort((a, b) => a.displayRank - b.displayRank);
        }
        return element.params;
    }
}

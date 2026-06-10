import { exec } from 'child_process';
import * as path from 'path';
import { ThemeIcon, Uri, window, workspace } from 'vscode';
import { ArrayOptions, CommandOptions, DisplayableValue, MapValueObject } from './schemas';

// kill a hanging command instead of leaking a child process; cap output explicitly
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER = 1024 * 1024; // 1 MiB

/**
 * A delegate interface for handling parameter values.
 */
export interface ValuesDelegate {
    /**
     * Returns an icon representing the value type.
     */
    getIcon(): ThemeIcon;

    /**
     * Returns the values to select from. `force` re-resolves even if a cached
     * result exists (the user opening the picker); silent refreshes pass `false`.
     */
    getValues(force?: boolean): Promise<DisplayableValue[] | undefined>;

    /**
     * The union of named-output keys across all values (first-seen order), for which
     * the owning Param registers a `…get.<id>.<key>` command. Empty unless a value
     * defines a map of named outputs (always empty for command params).
     */
    getSecondaryKeys(): string[];
}

/** ValuesDelegate for a statically-defined array of values. */
export class ArrayValuesDelegate implements ValuesDelegate {
    static readonly ICON = new ThemeIcon('array');
    private values: DisplayableValue[];
    private secondaryKeys: string[];

    constructor(arrayOptions: ArrayOptions) {
        // normalize to { value, displayValue, secondaryValues? }: a plain string
        // duplicates value into displayValue; a string-value object falls back to
        // value when displayValue is absent; a map-value object keeps its required
        // displayValue, stores the map as secondaryValues, and uses a canonical
        // (key-sorted) JSON of the map as its persisted identity, so the stored
        // selection survives re-ordering or relabeling.
        this.values = arrayOptions.values.map((value) => {
            if (typeof value === 'string') {
                return { value, displayValue: value };
            }
            if (typeof value.value === 'object') {
                // map-value object (its displayValue is required by the schema)
                const map = (value as MapValueObject).value;
                return { value: canonicalKey(map), displayValue: (value as MapValueObject).displayValue, secondaryValues: map };
            }
            return { value: value.value, displayValue: value.displayValue ?? value.value };
        });
        // union of secondary keys in first-seen order, deduped
        const seen = new Set<string>();
        this.secondaryKeys = [];
        for (const value of this.values) {
            for (const key of Object.keys(value.secondaryValues ?? {})) {
                if (!seen.has(key)) {
                    seen.add(key);
                    this.secondaryKeys.push(key);
                }
            }
        }
    }

    getIcon() {
        return ArrayValuesDelegate.ICON;
    }

    getSecondaryKeys() {
        return [...this.secondaryKeys];
    }

    getValues() {
        // hand out a copy: callers reorder the result in place (onSelect moves the
        // current selection to the front), which must not mutate our source order
        return Promise.resolve([...this.values]);
    }
}

// a stable identity for a named-value map: JSON with keys sorted, so two equal maps
// (regardless of key order) produce the same persisted selection key. Exported so the
// add-param wizard can derive the same identity when offering a named value as an
// initial selection.
export function canonicalKey(map: { [key: string]: string }): string {
    // Object.create(null), not {}: a key like `__proto__` assigned onto a plain object
    // sets the prototype instead of an own property, so it would vanish from the
    // stringified identity (two maps differing only in `__proto__` would collide). A
    // null-prototype object stores every key as a normal own, enumerable property.
    const sorted: { [key: string]: string } = Object.create(null);
    for (const key of Object.keys(map).sort()) {
        sorted[key] = map[key];
    }
    return JSON.stringify(sorted);
}

/** A cached command result, tagged with the command definition that produced it. */
interface CachedCommandValues {
    signature: string;
    // resolved values, or undefined if the run failed (cached so a failing command
    // is not re-run on every silent refresh)
    values?: DisplayableValue[];
    // the error already shown for this entry, to dedupe toasts across param rebuilds
    notifiedError?: string;
}
/** Command output cache keyed by retrieval command id (owned by JsonFile). */
export type CommandValuesCache = Map<string, CachedCommandValues>;

/** ValuesDelegate that derives values from the stdout of a shell command. */
export class CommandValuesDelegate implements ValuesDelegate {
    static readonly ICON = new ThemeIcon('terminal');
    private cwd: string;
    // fingerprint of the command definition; a cache entry is reused only while it
    // matches, so editing the command re-runs instead of serving stale output
    private readonly signature: string;

    constructor(
        private opts: CommandOptions,
        defaultCwd: string,
        private cache: CommandValuesCache,
        private cacheKey: string,
    ) {
        if (this.opts.cwd) {
            this.cwd = path.resolve(defaultCwd, this.opts.cwd);
        } else {
            this.cwd = defaultCwd;
        }
        this.signature = JSON.stringify({ shellCmd: this.opts.shellCmd, cwd: this.cwd, separator: this.opts.separator });
    }

    getIcon() {
        return CommandValuesDelegate.ICON;
    }

    // a command param's values are bare stdout lines, never named maps
    getSecondaryKeys() {
        return [];
    }

    async getValues(force = false): Promise<DisplayableValue[] | undefined> {
        const cached = this.cache.get(this.cacheKey);
        // on a silent refresh, reuse the cache while the command is unchanged (both
        // success and a prior failure, so neither re-runs on save); a forced refresh
        // or an absent/stale entry (first load, edited command) executes
        if (!force && cached && cached.signature === this.signature) {
            return cached.values ? [...cached.values] : undefined;
        }
        // never run shell commands in an untrusted workspace; undefined keeps the
        // stored selection rather than clearing it, and resolves once trusted
        if (!workspace.isTrusted) {
            return undefined;
        }
        try {
            await workspace.fs.stat(Uri.file(this.cwd));
            const stdout = await this.execCmd();
            // default to splitting on LF or CRLF (not os.EOL): tools emit either on
            // any platform. An explicit separator is still honored exactly.
            const lines = this.opts.separator ? stdout.split(this.opts.separator) : stdout.split(/\r?\n/);
            if (lines[lines.length - 1] === '') {
                lines.pop();
            }
            const values = lines.map((line) => ({ value: line, displayValue: line }));
            this.cache.set(this.cacheKey, { signature: this.signature, values });
            return [...values];
        } catch (e) {
            const error = `Failed to launch command ${this.opts.shellCmd}: ${e instanceof Error ? e.message : String(e)}`;
            console.error(error);
            // dedupe via the cache (a per-delegate flag would reset on every rebuild)
            if (cached?.notifiedError !== error) {
                window.showErrorMessage(error);
            }
            this.cache.set(this.cacheKey, { signature: this.signature, notifiedError: error });
            // command failed: unavailable, keep the previously stored selection
            return undefined;
        }
    }

    private async execCmd(): Promise<string> {
        return new Promise((resolve, reject) => {
            exec(
                this.opts.shellCmd,
                { cwd: this.cwd, timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: EXEC_MAX_BUFFER },
                (error, stdout, stderr) => {
                    if (error) {
                        console.error(error + ':', stderr);
                        // report the shell exec actually uses (/bin/sh on POSIX,
                        // ComSpec/cmd.exe on Windows), not the login shell it ignores
                        const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
                        reject(new Error(`Executing "${this.opts.shellCmd}" at path ${this.cwd} with shell ${shell} failed: ${stderr || error.message}`));
                        return;
                    }
                    resolve(stdout);
                },
            );
        });
    }
}

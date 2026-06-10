/** Turn the common backslash escapes a user types (\n \t \r \\) into real characters. */
export function interpretEscapes(value: string): string {
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\' };
    return value.replace(/\\([ntr\\])/g, (_match, ch: string) => map[ch]);
}

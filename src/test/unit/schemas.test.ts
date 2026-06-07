import { validateArrayOptionsInput, validateCommandOptionsInput, validateStatusBarParamInput } from '../../schemas';

// Pure validator tests (no vscode dependency). These cover the input-shape
// discrimination that drives Param value mapping in jsonFile.ts, including the
// displayValue support added in 443bccc.
describe('schema validation', () => {
    describe('validateArrayOptionsInput', () => {
        it('accepts the plain string-array form', () => {
            expect(validateArrayOptionsInput(['a', 'b'])).toBe(true);
        });
        it('accepts an empty array', () => {
            expect(validateArrayOptionsInput([])).toBe(true);
        });
        it('rejects an array with a non-string, non-object element', () => {
            expect(validateArrayOptionsInput(['a', 1])).toBe(false);
        });
        it('accepts displayValue objects mixed with plain strings', () => {
            expect(validateArrayOptionsInput({ values: ['a', { value: 'v', displayValue: 'Label' }] })).toBe(true);
        });
        it('accepts a value object without a displayValue (displayValue is optional)', () => {
            expect(validateArrayOptionsInput({ values: [{ value: 'v' }] })).toBe(true);
        });
        it('accepts the options flags alongside values', () => {
            expect(validateArrayOptionsInput({ values: ['a'], canPickMany: true, showName: true })).toBe(true);
        });
        it('rejects a value object missing the required value', () => {
            expect(validateArrayOptionsInput({ values: [{ displayValue: 'Label' }] })).toBe(false);
        });
        it('rejects the object form without values', () => {
            expect(validateArrayOptionsInput({ canPickMany: true })).toBe(false);
        });
    });

    describe('validateCommandOptionsInput', () => {
        it('accepts a shellCmd with optional cwd and separator', () => {
            expect(validateCommandOptionsInput({ shellCmd: 'ls', cwd: '/tmp', separator: ',' })).toBe(true);
        });
        it('accepts a bare shellCmd', () => {
            expect(validateCommandOptionsInput({ shellCmd: 'ls' })).toBe(true);
        });
        it('requires shellCmd', () => {
            expect(validateCommandOptionsInput({ cwd: '/tmp' })).toBe(false);
        });
    });

    describe('validateStatusBarParamInput gate', () => {
        it('accepts a matching command input whose args is an array', () => {
            expect(validateStatusBarParamInput({ id: 'p', type: 'command', command: 'statusBarParam.get.p', args: ['a'] })).toBe(true);
        });
        it('accepts a matching command input whose args is an object', () => {
            expect(validateStatusBarParamInput({ id: 'p', type: 'command', command: 'statusBarParam.get.p', args: { values: ['a'] } })).toBe(true);
        });
        it('rejects a matching command input whose args is neither array nor object', () => {
            expect(validateStatusBarParamInput({ id: 'p', type: 'command', command: 'statusBarParam.get.p', args: 'nope' })).toBe(false);
        });
        it('rejects inputs that are not ours (wrong command, type, missing id, missing args, or empty suffix)', () => {
            expect(validateStatusBarParamInput({ id: 'p', type: 'command', command: 'someOther.command', args: ['a'] })).toBe(false);
            expect(validateStatusBarParamInput({ id: 'p', type: 'promptString', command: 'statusBarParam.get.p', args: ['a'] })).toBe(false);
            expect(validateStatusBarParamInput({ id: 'p', type: 'command', command: 'statusBarParam.get.p' })).toBe(false);
            // missing id -> would create a Param with undefined id
            expect(validateStatusBarParamInput({ type: 'command', command: 'statusBarParam.get.p', args: ['a'] })).toBe(false);
            // empty suffix after the get. prefix
            expect(validateStatusBarParamInput({ id: 'p', type: 'command', command: 'statusBarParam.get.', args: ['a'] })).toBe(false);
        });
    });
});

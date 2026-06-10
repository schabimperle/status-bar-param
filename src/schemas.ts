import Ajv, { ValidateFunction } from 'ajv';
import optionsSchema from './schemas/options_schema.json';
import arrayOptionsSchema from './schemas/array_options_schema.json';
import commandOptionsSchema from './schemas/command_options_schema.json';

export interface Options {
    canPickMany?: boolean;
    showName?: boolean;
    showSelection?: boolean;
    initialSelection?: string | string[];
    joinSeparator?: string;
}

// Internal, normalized selectable value. `value` is the returned/persisted string;
// for a map entry it's a canonical key (see ArrayValuesDelegate) and `secondaryValues`
// holds the named outputs reachable via `…get.<id>.<key>`.
export interface DisplayableValue {
    displayValue: string;
    value: string;
    secondaryValues?: { [key: string]: string };
}

// JSON array value object whose value is a single returned string.
export interface StringValueObject {
    value: string;
    displayValue?: string;
}

// JSON array value object whose value is a map of named outputs; `displayValue` is
// required, since a map has no single string to show in the status bar.
export interface MapValueObject {
    value: { [key: string]: string };
    displayValue: string;
}

export type ArrayValue = string | StringValueObject | MapValueObject;

export interface ArrayOptions extends Options {
    values: ArrayValue[];
}

export interface CommandOptions extends Options {
    shellCmd: string;
    cwd?: string;
    separator?: string;
}

export interface Input {
    id: string;
    command: string;
    args: string[] | ArrayOptions | CommandOptions;
}

// compile schema validators for ArrayInput/CommandInput
const ajv = new Ajv();
ajv.addSchema(optionsSchema).addSchema(arrayOptionsSchema).addSchema(commandOptionsSchema);

// validators to identify the option shapes. getSchema returns a union TS won't
// treat as a type predicate, so assert ValidateFunction<T> to keep `input.args`
// narrowing intact. validateArrayOptionsInput accepts both the bare array and the
// { values, ... } form, so a dedicated string-array validator is redundant.
export const validateArrayOptionsInput = ajv.getSchema('array_options_schema.json') as ValidateFunction<ArrayOptions>;
export const validateCommandOptionsInput = ajv.getSchema('command_options_schema.json') as ValidateFunction<CommandOptions>;

// Runtime gate for inputs belonging to this extension: a command input whose
// retrieval command matches our pattern and that carries args. Unlike
// input_schema.json (which must leave unrelated inputs valid for IntelliSense),
// this actively rejects them by requiring the fields. The args shape is checked
// separately by validateArrayOptionsInput / validateCommandOptionsInput.
const statusBarParamInputSchema = {
    type: 'object',
    required: ['id', 'type', 'command', 'args'],
    properties: {
        id: { type: 'string' },
        type: { const: 'command' },
        command: { type: 'string', pattern: '^statusBarParam\\.get\\..+$' },
        args: {
            oneOf: [{ type: 'array' }, { type: 'object' }],
        },
    },
};
export const validateStatusBarParamInput = ajv.compile<Input>(statusBarParamInputSchema);

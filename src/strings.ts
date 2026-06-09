/** Extension id and contributed command ids. */
const EXTENSION_ID = 'statusBarParam';
export const Strings = {
    EXTENSION_ID,
    COMMAND_ADD: `${EXTENSION_ID}.add`,
    COMMAND_RESET_SELECTIONS: `${EXTENSION_ID}.resetSelections`,
    COMMAND_SELECT: `${EXTENSION_ID}.select`,
    COMMAND_EDIT: `${EXTENSION_ID}.edit`,
    COMMAND_COPY_CMD: `${EXTENSION_ID}.copyCmd`,
    COMMAND_DELETE: `${EXTENSION_ID}.delete`,
} as const;

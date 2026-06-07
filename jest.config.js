/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/*.test.ts'],
    // the optional @vscode/test-electron smoke layer runs in a real VS Code host,
    // not under Jest's mocked vscode — keep Jest out of it
    testPathIgnorePatterns: ['/node_modules/', '<rootDir>/src/test/integration/'],
    // route the (host-provided) `vscode` module to the jest-mock-vscode wrapper
    moduleNameMapper: {
        '^vscode$': '<rootDir>/src/test/mocks/vscode.ts',
    },
    // reset call data between tests; mock implementations are kept
    clearMocks: true,
    setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/test/**',
        '!src/**/*.d.ts',
    ],
    coverageDirectory: '<rootDir>/coverage',
    // ratchet so coverage can't silently regress (current: ~94% stmts / 95% lines,
    // 86% branches / 91% funcs); thresholds sit a point or two under to absorb noise
    coverageThreshold: {
        global: {
            statements: 93,
            branches: 84,
            functions: 89,
            lines: 94,
        },
    },
};

// Jest setup (setupFilesAfterEnv). The extension logs heavily via
// console.debug/log and deliberately console.error on handled failures (e.g. a
// command param whose shell command fails). None of the tests assert on console
// output, so silence it to keep the reporter focused on real assertions. A test
// that wants to assert on logging can re-spy locally.
beforeAll(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

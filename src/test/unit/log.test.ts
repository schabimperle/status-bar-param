import * as log from '../../log';

describe('log.debug gating', () => {
    const original = process.env.STATUS_BAR_PARAM_DEBUG;
    let spy: jest.SpyInstance;

    beforeEach(() => {
        spy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    });
    afterEach(() => {
        spy.mockRestore();
        if (original === undefined) {
            delete process.env.STATUS_BAR_PARAM_DEBUG;
        } else {
            process.env.STATUS_BAR_PARAM_DEBUG = original;
        }
    });

    it('stays silent when the debug flag is unset', () => {
        delete process.env.STATUS_BAR_PARAM_DEBUG;
        log.debug('trace', 1);
        expect(spy).not.toHaveBeenCalled();
    });

    it('forwards to console.debug when the debug flag is set', () => {
        process.env.STATUS_BAR_PARAM_DEBUG = '1';
        log.debug('trace', 1);
        expect(spy).toHaveBeenCalledWith('trace', 1);
    });
});

// One simulated DOM for every web test, preloaded once: files that each register and unregister
// their own DOM pull it out from under each other through the shared testing-library module.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://127.0.0.1/voices/' });

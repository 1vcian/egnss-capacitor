import { registerPlugin } from '@capacitor/core';

import type { EgnssPlugin } from './definitions';

const Egnss = registerPlugin<EgnssPlugin>('Egnss', {
  web: () => import('./web').then((m) => new m.EgnssWeb()),
});

export * from './definitions';
export { Egnss };

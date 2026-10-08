import { z } from 'zod';
import type { RunSearchPage } from '../runSearch.js';
import { cursorPageOf } from './primitives.js';
import { runSchema } from './runs.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const runSearchPageSchema = namedContractSchema('RunSearchPage', cursorPageOf(runSchema));

type _RunSearchPage = Expect<
  MutuallyAssignable<z.infer<typeof runSearchPageSchema>, RunSearchPage>
>;

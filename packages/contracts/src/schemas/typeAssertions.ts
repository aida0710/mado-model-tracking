/**
 * Compile-time checks that a zod schema and its contract type describe the same values. Each
 * schema file declares `type _X = Expect<MutuallyAssignable<z.infer<typeof xSchema>, X>>`; tsc
 * fails when a contract type gains, loses or changes a required field without the schema.
 */
export type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type Expect<T extends true> = T;

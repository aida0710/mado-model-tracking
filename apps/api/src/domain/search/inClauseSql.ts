export type InListOperator = 'IN' | 'NOT IN';

/**
 * Compiles an MLflow `IN (...)` / `NOT IN (...)` comparison against one bound text[] parameter.
 * Binding the whole list keeps the SQL shape fixed regardless of how many values are given.
 * NOT IN follows SQL semantics: rows whose expression is NULL match neither IN nor NOT IN.
 */
export function inClauseSql(comparison: {
  expression: string;
  operator: InListOperator;
  valuesParameter: string;
}): string {
  const quantifier = comparison.operator === 'IN' ? '= ANY' : '<> ALL';
  return `(${comparison.expression}) ${quantifier}(${comparison.valuesParameter}::text[])`;
}

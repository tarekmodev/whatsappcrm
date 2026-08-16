/**
 * Sizes the definition admin surface shares between its table and that table's
 * skeleton, so the two cannot disagree.
 */

/**
 * Rows the table draws while loading.
 *
 * Three, not `CUSTOM_FIELD_LIMITS.definitionsPerTenant`: the cap is 50 and a real
 * tenant defines a handful, so fifty placeholders would be a page of grey the
 * data could never fill.
 */
export const CUSTOM_FIELDS_SKELETON_COUNT = 3;

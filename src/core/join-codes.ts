// Store the original 12-character code so existing memberships/codes need no migration.
// Grouping is a presentation concern; accept both grouped and ungrouped input.
export const normalizeJoinCode = (code: string) => code.trim().replaceAll("-", "").toUpperCase();
export const formatJoinCode = (code: string) => normalizeJoinCode(code).match(/.{1,4}/g)?.join("-") ?? "";

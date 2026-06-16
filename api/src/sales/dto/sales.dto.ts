/**
 * DTOs for the sales-organization API.
 *
 * The ported real sales-org routes (team list, member detail, member outlets,
 * my-outlets) are all GET endpoints whose only request inputs are path params
 * (validated inline in the controller as plain strings). There are no request
 * bodies or query filters on the ported routes, so this module currently holds
 * no body/query DTOs — it exists to mirror the template layout and provides a
 * home for future sales-org write DTOs (class-validator + Prisma enums).
 */

export {};

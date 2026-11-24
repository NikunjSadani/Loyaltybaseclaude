import { IsEmail, IsOptional, IsString, Matches, MinLength, ValidateIf } from 'class-validator';

/**
 * DTO for the single-record EMPLOYEE edit endpoint
 * (PATCH /v1/admin/sales-users/:id → AdminCoreService.updateEmployee).
 *
 * An "employee" is a `User` (login) linked 1:1 to a `SalesUser` (hierarchy) via
 * `SalesUser.userId`. This DTO mirrors ONLY the fields the bulk "Employee
 * Hierarchy" Excel upload writes (see hierarchy-persistence.ts persistHierarchy):
 *   - name / phone / email  → the User row
 *   - hierarchyLevelId      → the SalesUser fine level (drives User.role too)
 *   - reportingToId         → the SalesUser reporting link
 *
 * Every field is optional (a partial edit). STRICT EXCLUSIONS (never editable here):
 * employeeCode (immutable identity key), region/zone (dormant — not written by the
 * bulk upload), isActive/deactivation (that's the row toggle / bulk resign path).
 */
/** Body for POST /v1/admin/sales-users/:id/revoke-sessions ("Retry sign-out"). */
export class RetrySignOutDto {
  @IsString()
  @MinLength(1)
  userId!: string;
}

export class UpdateEmployeeDto {
  /**
   * Blank ('' / whitespace) is allowed ONLY together with a blank phone — that marks the
   * position VACANT (the employee left). The both-or-neither rule is enforced in the service
   * (it needs both fields at once) with a plain-words 400.
   */
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  /** A 10-digit phone, or '' (blank) to mark the position vacant together with a blank name. */
  @ValidateIf((o: UpdateEmployeeDto) => o.phone !== '')
  @IsOptional()
  @Matches(/^\d{10}$/, { message: 'Phone must be 10 digits' })
  phone?: string;

  /** The SalesUser's fine hierarchy level (SalesHierarchyLevel.id, tenant-scoped). */
  @IsOptional()
  @IsString()
  @MinLength(1)
  hierarchyLevelId?: string;

  /**
   * The SalesUser this employee reports to (SalesUser.id, tenant-scoped, active).
   * Pass `null` to clear the reporting link (top of the tree). A non-null value is
   * cycle-guarded in the service (must not be self or inside the employee's subtree).
   */
  @IsOptional()
  @IsString()
  reportingToId?: string | null;
}

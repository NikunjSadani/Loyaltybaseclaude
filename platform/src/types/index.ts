// ─── Geo ─────────────────────────────────────────────────────────────────────

/**
 * A single geo-capture event — latitude, longitude, accuracy (metres), and ISO timestamp.
 * Captured twice during KYC enrollment:
 *   1. When the outlet board photo is taken  (boardPhotoGeo)
 *   2. When the cancelled cheque is uploaded or UPI QR is scanned  (paymentGeo)
 */
export interface GeoCapture {
  lat:      number;
  lng:      number;
  accuracy: number;  // metres
  ts:       string;  // ISO-8601
}

// ─── Enums ───────────────────────────────────────────────────────────────────

export enum UserRole {
  GIFSY_ADMIN  = 'GIFSY_ADMIN',
  CLIENT_ADMIN = 'CLIENT_ADMIN',
  MIS_USER     = 'MIS_USER',
  // Sales hierarchy — XSR → SO → ASM → RSM → ZM → NM
  XSR = 'XSR',  // Executive Sales Representative (field-level)
  SO  = 'SO',   // Sales Officer
  ASM = 'ASM',  // Area Sales Manager
  RSM = 'RSM',  // Regional Sales Manager
  ZM  = 'ZM',   // Zonal Manager
  NM  = 'NM',   // National Manager
  // Channel partners
  SSS          = 'SSS',
  WHOLESALER   = 'WHOLESALER',
  SUB_STOCKIST = 'SUB_STOCKIST',
  SSS_TOT      = 'SSS_TOT',       // SSS TOT
}

/** The four outlet types — determines reward track and KPI set */
export enum OutletType {
  SSS          = 'SSS',
  WHOLESALER   = 'WHOLESALER',
  SUB_STOCKIST = 'SUB_STOCKIST',
  SSS_TOT      = 'SSS_TOT',
}

/** POINTS = wholesaler (points → catalogue/voucher/bank), INR = all others (direct bank payout) */
export type RewardTrack = 'POINTS' | 'INR';

/** Whether a voucher has a fixed face value or the partner can enter any amount */
export enum VoucherDenominationType {
  FIXED       = 'FIXED',
  FREE_AMOUNT = 'FREE_AMOUNT',
}

export enum KYCStatus {
  NOT_STARTED            = 'NOT_STARTED',   // outlet exists; KYC not yet initiated
  NOT_INTERESTED         = 'NOT_INTERESTED', // sales agent marked outlet as not interested; outlet deactivated
  PENDING                = 'PENDING',
  SUBMITTED              = 'SUBMITTED',
  UNDER_REVIEW           = 'UNDER_REVIEW',
  PENDING_SO_APPROVAL    = 'PENDING_SO_APPROVAL',   // XSR submitted → awaiting SO
  PENDING_ASM_APPROVAL   = 'PENDING_ASM_APPROVAL',  // SO submitted  → awaiting ASM (or escalated from SO)
  PENDING_RSM_APPROVAL   = 'PENDING_RSM_APPROVAL',  // Escalated when ASM (or SO+ASM) has resigned
  PENDING_GIFSY          = 'PENDING_GIFSY',          // First approved → awaiting Gifsy
  APPROVED               = 'APPROVED',
  REJECTED               = 'REJECTED',
  RESUBMISSION_REQUIRED  = 'RESUBMISSION_REQUIRED',
  RE_KYC_REQUIRED        = 'RE_KYC_REQUIRED',
}

/** Roles that can submit a KYC form (field-level only) */
export type KYCSubmitterRole = 'XSR' | 'SO';

export interface ApprovalEvent {
  stage:     'FIRST_APPROVER' | 'GIFSY';
  action:    'APPROVED' | 'REJECTED';
  by:        string;
  role:      string;
  timestamp: string;
  remarks?:  string;
}

export enum RedemptionStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DISPATCHED = 'DISPATCHED',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  REVERSED = 'REVERSED',
}

export enum PayoutMode {
  UPI = 'UPI',
  BANK_TRANSFER = 'BANK_TRANSFER',
  VOUCHER = 'VOUCHER',
  GIFT = 'GIFT',
  CATALOGUE = 'CATALOGUE',
}

export enum IncentiveType {
  SALES = 'SALES',
  VISIBILITY = 'VISIBILITY',
  SECONDARY_SALES = 'SECONDARY_SALES',
  LOYALTY = 'LOYALTY',
  REFERRAL = 'REFERRAL',
  MILESTONE = 'MILESTONE',
}

export enum CalculationMethod {
  FLAT = 'FLAT',
  PERCENTAGE = 'PERCENTAGE',
  SLAB = 'SLAB',
  PER_UNIT = 'PER_UNIT',
  HYBRID = 'HYBRID',
}

export enum ChannelPartnerClass {
  GOLD = 'GOLD',
  SILVER = 'SILVER',
  BRONZE = 'BRONZE',
  PLATINUM = 'PLATINUM',
  STANDARD = 'STANDARD',
}

export enum TransactionType {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
  LOCK = 'LOCK',
  UNLOCK = 'UNLOCK',
  EXPIRE = 'EXPIRE',
  REVERSE = 'REVERSE',
}

export enum WalletBucket {
  EARNED = 'EARNED',
  LOCKED = 'LOCKED',
  REDEEMABLE = 'REDEEMABLE',
  REDEEMED = 'REDEEMED',
  EXPIRED = 'EXPIRED',
}

export enum NotificationChannel {
  SMS = 'SMS',
  WHATSAPP = 'WHATSAPP',
  EMAIL = 'EMAIL',
  PUSH = 'PUSH',
}

export enum NotificationEvent {
  OTP = 'OTP',
  KYC_APPROVED = 'KYC_APPROVED',
  KYC_REJECTED = 'KYC_REJECTED',
  KYC_UNDER_REVIEW = 'KYC_UNDER_REVIEW',  // First approver accepted → partner notified
  POINTS_EARNED = 'POINTS_EARNED',
  POINTS_CREDITED = 'POINTS_CREDITED',         // KPI achievement → points credited (Wholesaler)
  POINTS_EXPIRY_WARNING = 'POINTS_EXPIRY_WARNING',
  REDEMPTION_CONFIRMED = 'REDEMPTION_CONFIRMED',
  DISPATCH_UPDATE = 'DISPATCH_UPDATE',
  PAYOUT_PROCESSED = 'PAYOUT_PROCESSED',
  PAYOUT_CONFIRMED = 'PAYOUT_CONFIRMED',       // Gifsy uploads UTR (INR outlets)
  SCHEME_LAUNCHED = 'SCHEME_LAUNCHED',
  TARGET_MILESTONE = 'TARGET_MILESTONE',
}

export enum UploadBatchStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  PARTIAL = 'PARTIAL',
}

export enum TDSSection {
  SECTION_194R = '194R',
  SECTION_194C = '194C',
}

// ─── API Response Types ───────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  statusCode?: number;
}

export interface PaginatedResponse<T = unknown> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  message?: string;
}

// ─── Entity Types ─────────────────────────────────────────────────────────────

export interface User {
  id: string;
  mobile: string;
  email?: string | null;
  name?: string | null;
  role: UserRole;
  partnerId?: string | null;
  clientId?: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChannelPartner {
  id: string;
  userId: string;
  firmName: string;
  partnerClass: ChannelPartnerClass;
  gstNumber?: string | null;
  panNumber?: string | null;
  kycStatus: KYCStatus;
  tier?: string | null;
  regionId?: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface KYCDocument {
  id: string;
  partnerId: string;
  documentType: string;
  documentNumber?: string | null;
  fileUrl: string;
  status: KYCStatus;
  rejectionReason?: string | null;
  verifiedAt?: Date | null;
  verifiedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Wallet {
  id: string;
  userId: string;
  earnedPoints: number;
  lockedPoints: number;
  redeemablePoints: number;
  redeemedPoints: number;
  expiredPoints: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletTransaction {
  id: string;
  walletId: string;
  userId: string;
  type: TransactionType;
  bucket: WalletBucket;
  amount: number;
  balanceAfter: number;
  schemeId?: string | null;
  invoiceId?: string | null;
  description?: string | null;
  /** KPI that generated this transaction (earn entries only; undefined for redemptions/expiry). */
  kpiLabel?: string;
  /** Optional admin-supplied note shown under the transaction description. */
  narration?: string;
  reversedById?: string | null;
  reversalReason?: string | null;
  createdAt: Date;
}

export interface Scheme {
  id: string;
  clientId: string;
  name: string;
  description?: string | null;
  incentiveType: IncentiveType;
  calculationMethod: CalculationMethod;
  startDate: Date;
  endDate: Date;
  holdingPeriodDays: number;
  targetValue?: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SchemeSlab {
  id: string;
  schemeId: string;
  minValue: number;
  maxValue?: number | null;
  payoutValue: number;
  isOverachievement: boolean;
  createdAt: Date;
}

export interface Invoice {
  id: string;
  partnerId: string;
  schemeId?: string | null;
  uploadBatchId?: string | null;
  invoiceNumber: string;
  invoiceDate: Date;
  amount: number;
  productCategory?: string | null;
  pointsEarned?: number | null;
  isProcessed: boolean;
  processedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UploadBatch {
  id: string;
  clientId: string;
  uploadedBy: string;
  fileName: string;
  fileUrl: string;
  status: UploadBatchStatus;
  totalRecords: number;
  processedRecords: number;
  failedRecords: number;
  errorFileUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Redemption {
  id: string;
  userId: string;
  walletTransactionId: string;
  payoutMode: PayoutMode;
  points: number;
  valueInPaise: number;
  status: RedemptionStatus;
  trackingNumber?: string | null;
  deliveryAddress?: RedemptionAddress | null;
  failureReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RedemptionAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
}

export interface TDSRecord {
  id: string;
  payoutId: string;
  partnerId: string;
  pan?: string | null;
  section: string;
  grossAmountPaise: number;
  tdsRate: number;
  tdsAmountPaise: number;
  netAmountPaise: number;
  financialYear: string;
  createdAt: Date;
}

export interface OTP {
  id: string;
  userId: string;
  otp: string;
  type: string;
  expiresAt: Date;
  isUsed: boolean;
  createdAt: Date;
}

export interface NotificationTemplate {
  id: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  templateBody: string;
  templateId?: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationQueue {
  id: string;
  userId: string;
  templateId: string;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
  scheduledAt?: Date | null;
  sentAt?: Date | null;
  status: string;
  errorMessage?: string | null;
  createdAt: Date;
}

export interface VisibilitySubmission {
  id: string;
  partnerId: string;
  schemeId: string;
  outletId?: string | null;
  visibilityType: string;
  imageUrl: string;
  imageHash?: string | null;
  exactHash?: string | null;
  geoLat?: number | null;
  geoLng?: number | null;
  captureTime?: Date | null;
  isDuplicate: boolean;
  duplicateReason?: string | null;
  matchedSubmissionId?: string | null;
  status: string;
  pointsEarned?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Gifsy Configurable Settings ─────────────────────────────────────────────

export interface GifsySettings {
  /** Points-to-INR conversion rate. Default 1 (1 pt = ₹1). */
  pointsConversionRate:    number;
  /** Minimum ₹ amount for a bank-transfer redemption. Default 100. */
  minBankTransferAmount:   number;
  /** Minimum ₹ amount for a free-amount voucher redemption. Default 100. */
  minVoucherFreeAmount:    number;
  /**
   * Amber pace-zone threshold as a % of time elapsed. Default 10.
   *
   * Amber fires when: gap (timePct − achievedPct) ≤ timePct × (threshold / 100).
   * Example at 40% elapsed with threshold 10: amber if achievedPct ≥ 36%.
   * Lower = more stringent (smaller amber window before red).
   * Configurable per client from the admin settings panel.
   */
  paceAmberThreshold:      number;
  /**
   * Whether the sales team can submit visibility photos through the app.
   * Default: true (enabled). Set to false for tenants like Deoleo who
   * handle visibility photo capture through their own internal process.
   */
  visibilityPhotoEnabled?: boolean;
  /**
   * Controls which redemption channels are visible in the partner rewards catalogue.
   * All three default to true. Disable any to hide that tab entirely for the tenant.
   */
  redemptionChannels?: {
    physicalGifts: boolean;
    vouchers:      boolean;
    bankTransfer:  boolean;
  };
  /** Sales team app customisations — all optional, tenant-specific */
  salesApp?: {
    /** Override label for the "View Points Ledger" quick action. Default: 'View Points Ledger' */
    ledgerLabel?: string;
    /** When true, "Redeem Gift" quick action is shown only for WHOLESALER outlets. Default: false */
    redeemGiftWholesalerOnly?: boolean;
  };
  /** Credits & Payouts bulk upload module settings */
  creditsPayouts?: {
    /** Day of month after which the previous month's upload is locked. Default 10. */
    monthCutoffDay:  number;
    /** Maximum points per outlet per upload (safety cap). Default 50000. */
    safetyCapPoints: number;
    /** Maximum INR payout per outlet per upload (safety cap). Default 100000. */
    safetyCapInr:    number;
    /** Require a second CLIENT_ADMIN to confirm an upload batch (4-eyes). Default false. */
    fourEyesEnabled: boolean;
    /** Gifsy internal email recipients notified when a client batch is confirmed. */
    notifyEmails:    string[];
  };
}

// ─── INR Payout Ledger Entry (Retailer / Sub-Stockist / MT) ──────────────────

export interface PayoutLedgerEntry {
  id:              string;
  period:          string;      // '2026-05'
  kpiLabel:        string;
  achievedPct:     number;
  payoutAmountInr: number;
  uploadedAt:      string;      // ISO — when Deoleo uploaded the file
  utr?:            string;      // set by Gifsy after bank transfer
  paidAt?:         string;      // ISO date of payment
  status:          'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED';
  narration?:      string;      // optional admin-supplied note shown under the row
}

// ─── Wallet Balance Type ──────────────────────────────────────────────────────

export interface WalletBalance {
  earned: number;
  locked: number;
  redeemable: number;
  redeemed: number;
  expired: number;
  available: number;
}

// ─── TDS Computation Result ───────────────────────────────────────────────────

export interface TDSComputationResult {
  grossAmount: number;
  tdsRate: number;
  tdsAmount: number;
  netAmount: number;
}

// ─── Incentive Calculation Result ─────────────────────────────────────────────

export interface IncentiveCalculationResult {
  invoiceId: string;
  schemeId: string;
  pointsEarned: number;
  calculationMethod: CalculationMethod;
  breakdown: Record<string, unknown>;
}

// ─── Duplicate Check Result ───────────────────────────────────────────────────

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  reason?: string;
  matchedSubmissionId?: string;
}

// ─── EXIF Validation Result ───────────────────────────────────────────────────

export interface ExifValidationResult {
  valid: boolean;
  captureTime?: Date;
  reason?: string;
}

// ─── Employee Hierarchy ───────────────────────────────────────────────────────

/** One level in a tenant's sales hierarchy configuration */
export interface TenantHierarchyLevel {
  tenantId: string;
  level: number;      // 1 = leaf (owns outlets), highest = root (no manager)
  roleCode: string;   // e.g. 'ISR', 'SO', 'NSM'
  roleLabel: string;  // display name
  isLeaf: boolean;    // can own outlets directly
  isRoot: boolean;    // no reporting manager required
}

/** An employee in the hierarchy — position-based, not person-based */
export interface HierarchyEmployee {
  id: string;                 // territory/position code: "Pune101"
  tenantId: string;
  roleCode: string;           // matched against TenantHierarchyLevel.roleCode
  roleLabel: string;          // display name
  reportsToId: string | null; // null for root (NSM)
  hierarchyPath: string;      // /NSM-01/ZNM-W1/RSM-MH/ASM-MUM/SO-MUM1/ISR-M001/
  name: string | null;        // null for placeholder positions
  mobile: string | null;      // 10 digits or null
  status: 'ACTIVE' | 'PLACEHOLDER';
  hasOutlets: boolean;        // whether this employee has outlets tagged to them
  hasSubReports: boolean;     // whether any employee directly reports to this one
}

/** Raw row parsed from the hierarchy upload Excel */
export interface EmployeeUploadRow {
  rowNum: number;
  hierarchy: string;
  employeeId: string;
  employeeName: string;
  employeePhone: string;
  reportingManagerHierarchy: string;   // blank for root
  reportingManagerEmployeeId: string;  // blank for root
}

/** Validation result for one row in the upload */
export interface EmployeeRowValidationResult {
  rowNum: number;
  employeeId: string;
  status: 'OK' | 'ERROR' | 'WARNING';
  errors: string[];
  warnings: string[];
  /** CREATE = new employee; UPDATE_INFO = only name/phone changed;
   *  UPDATE_HIERARCHY = role or reporting manager changed; SKIP = blank row */
  action: 'CREATE' | 'UPDATE_INFO' | 'UPDATE_HIERARCHY' | 'SKIP';
}

/** Full result of validating an employee upload file */
export interface EmployeeUploadValidationResult {
  headerError: string | null;
  rows: EmployeeRowValidationResult[];
  hasErrors: boolean;
  canProceed: boolean;
  summary: {
    total: number;
    creates: number;
    updates: number;
    errors: number;
  };
}

// ─── Outlet Upload ────────────────────────────────────────────────────────────

/** Full outlet master record created/stored in the system */
export interface OutletRecord {
  outletId:         string;   // admin-defined unique ID
  outletName:       string;
  programName:      string;   // from admin-configured program list
  programCategory:  string;   // from admin-configured category list
  outletType:       OutletType;
  beat:             string;
  distributorId:    string;   // reference only, no validation
  distributorName:  string;   // reference only
  isMetro:          boolean;  // Yes/No from upload
  city:             string;
  state:            string;
  xsrId:            string;   // leaf-level employee ID (ISR)
  // Hierarchy chain derived from xsrId via employee hierarchy table
  hierarchyL1Id:    string;   // ISR (same as xsrId)
  hierarchyL2Id:    string;   // SO
  hierarchyL3Id:    string;   // ASM
  hierarchyL4Id:    string;   // RSM
  hierarchyL5Id:    string;   // ZNM
  hierarchyL6Id:    string;   // NSM
  kycStatus:        KYCStatus;
  isActive:         boolean;
  addedDate:        string;   // ISO date string
  // Re-KYC flags (null if no re-KYC pending)
  reKycFlags?:      ReKYCFlags | null;
}

/** Which KYC fields need to be re-captured (set by admin via Re-KYC upload) */
export interface ReKYCFlags {
  outletName:       boolean;  // outlet name correction — routes through KYC approval chain
  ownerName:        boolean;
  mobileNumber:     boolean;
  gstNumber:        boolean;
  panNumber:        boolean;
  streetAddress:    boolean;
  city:             boolean;
  pincode:          boolean;
  state:            boolean;
  bankName:         boolean;
  accountHolderName: boolean;
  accountNumber:    boolean;
  ifscCode:         boolean;
  upiId:            boolean;
  gstCertificate:   boolean;  // document re-upload
  ownerPhoto:       boolean;  // document re-upload
  addressProof:     boolean;  // document re-upload
  storeBoardPhoto:  boolean;  // document re-upload
  cancelledCheque:  boolean;  // document re-upload
  selfDeclaration:  boolean;  // document re-upload (conditional)
  remarks:          string;   // admin's note to the sales team
}

/** Raw row parsed from the outlet addition upload Excel */
export interface OutletUploadRow {
  rowNum:           number;
  outletId:         string;
  outletName:       string;
  programName:      string;
  programCategory:  string;
  outletType:       string;
  beat:             string;
  distributorId:    string;
  distributorName:  string;
  metro:            string;   // raw string — "Yes" / "No" / blank
  city:             string;
  state:            string;
  zone:             string;   // optional geographic zone, e.g. "West Zone" — blank is accepted
  xsrId:            string;
}

/** Validation result for one row in the outlet addition upload */
export interface OutletUploadRowResult {
  rowNum:    number;
  outletId:  string;
  status:    'OK' | 'ERROR';
  errors:    string[];
  action:    'CREATE' | 'UPDATE' | 'REACTIVATE';
}

/** Full result of validating an outlet addition upload file */
export interface OutletUploadValidationResult {
  headerError: string | null;
  rows:        OutletUploadRowResult[];
  hasErrors:   boolean;
  canProceed:  boolean;
  summary:     { total: number; creates: number; updates: number; reactivates: number; errors: number };
}

/** Raw row parsed from the Re-KYC flag upload Excel */
export interface ReKYCFlagRow {
  rowNum:           number;
  outletId:         string;
  // Each field: "yes" (case-insensitive) or blank → maps to boolean
  outletName:       string;  // flagged Yes = outlet name correction needed
  ownerName:        string;
  mobileNumber:     string;
  gstNumber:        string;
  panNumber:        string;
  streetAddress:    string;
  city:             string;
  pincode:          string;
  state:            string;
  bankName:         string;
  accountHolderName: string;
  accountNumber:    string;
  ifscCode:         string;
  upiId:            string;
  gstCertificate:   string;
  ownerPhoto:       string;
  addressProof:     string;
  storeBoardPhoto:  string;
  cancelledCheque:  string;
  selfDeclaration:  string;
  remarks:          string;
}

/** Validation result for one row in the Re-KYC flag upload */
export interface ReKYCFlagRowResult {
  rowNum:    number;
  outletId:  string;
  status:    'OK' | 'ERROR';
  errors:    string[];
  flagCount: number;   // how many fields are marked "yes"
}

/** Full result of validating a Re-KYC flag upload file */
export interface ReKYCFlagValidationResult {
  headerError: string | null;
  rows:        ReKYCFlagRowResult[];
  hasErrors:   boolean;
  canProceed:  boolean;
  summary:     { total: number; flagged: number; errors: number };
}

// ─── Outlet Deactivation ──────────────────────────────────────────────────────

export interface OutletDeactivateRow {
  rowNum:   number;
  outletId: string;
}

export interface OutletDeactivateRowResult {
  rowNum:   number;
  outletId: string;
  status:   'OK' | 'ERROR';
  errors:   string[];
}

export interface OutletDeactivateValidationResult {
  headerError: string | null;
  rows:        OutletDeactivateRowResult[];
  hasErrors:   boolean;
  canProceed:  boolean;
  summary:     { total: number; deactivates: number; errors: number };
}

// ─── Credits & Payouts Bulk Upload Module ─────────────────────────────────────

/** Award type a field gives to a given outlet type */
export type FieldAwardType = 'POINTS' | 'PAYOUT' | 'NA';

/**
 * A configurable field (e.g. "Scheme Volume", "Visibility") in the
 * Credits & Payouts upload module. Managed by Gifsy admin.
 */
export interface CreditField {
  id:               string;
  name:             string;
  isActive:         boolean;
  /** When true, Gifsy downloads this field as a separate payout file. */
  isSeparatePayout: boolean;
  /**
   * Maps outlet type → award type for this field.
   * WHOLESALER → POINTS, SSS/SUB_STOCKIST/SSS_TOT → PAYOUT for Deoleo.
   */
  outletTypeAwards: Record<string, FieldAwardType>;
  createdAt:        string;   // ISO string — used for ordering
  order:            number;   // creation order (1-based), never changes
}

/** One parsed row from the Credits & Payouts upload */
export interface CreditUploadRow {
  rowNum:    number;
  outletId:  string;
  outletName: string;
  fieldId:   string;
  fieldName: string;
  amount:    number;
  narration: string;
  awardType: 'POINTS' | 'PAYOUT';
  status:    'OK' | 'ERROR' | 'SKIP';
  errors:    string[];
}

/** Full result from parsing a Credits & Payouts upload file */
export interface CreditParseResult {
  headerError:   string | null;
  rows:          CreditUploadRow[];
  hasErrors:     boolean;
  canProceed:    boolean;
  summary: {
    total:          number;
    ok:             number;
    skipped:        number;
    errors:         number;
    totalPoints:    number;
    totalPayoutInr: number;
  };
}

/** Status of a payout entry created from a confirmed upload */
export type PayoutEntryStatus = 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED';

/** A single payout entry per outlet per field per month */
export interface CreditPayoutEntry {
  id:              string;
  batchId:         string;
  outletId:        string;
  outletName:      string;
  fieldId:         string;
  fieldName:       string;
  period:          string;   // 'YYYY-MM'
  amount:          number;   // INR
  narration:       string;
  status:          PayoutEntryStatus;
  utr?:            string;
  paidAt?:         string;
  createdAt:       string;
}

/** A single points credit entry per outlet per field per month */
export interface CreditPointsEntry {
  id:        string;
  batchId:   string;
  outletId:  string;
  outletName: string;
  fieldId:   string;
  fieldName: string;
  period:    string;   // 'YYYY-MM'
  amount:    number;   // points
  narration: string;
  createdAt: string;
}

/** An uploaded and confirmed batch of credit/payout entries */
export interface CreditBatch {
  id:          string;
  period:      string;   // 'YYYY-MM'
  status:      'PENDING_CONFIRM' | 'CONFIRMED' | 'PARTIALLY_REVERSED';
  uploadedBy:  string;
  uploadedAt:  string;
  confirmedAt?: string;
  confirmedBy?: string;
  totalOutlets: number;
  totalPoints:  number;
  totalPayoutInr: number;
  rows:         CreditUploadRow[];
}

// ─── Bank Details Snapshot ────────────────────────────────────────────────────

/** Bank details captured at the moment a Gifsy payout file is downloaded */
export interface BankSnapshot {
  outletId:           string;
  bankName:           string;
  accountHolderName?: string;
  accountNumber:      string;
  ifscCode:           string;
  upiId:              string;
  snapshotAt:         string;   // ISO
}

// ─── Gifsy Payout Batch ───────────────────────────────────────────────────────

export type PayoutBatchStatus = 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'FAILED';
export type PayoutGroupType   = 'STANDARD' | 'SEPARATE';

/** One row in a Gifsy payout download batch */
export interface PayoutBatchRow {
  outletId:           string;
  outletName:         string;
  phone:              string;
  bankName:           string;
  accountHolderName?: string;
  accountNumber:      string;
  ifscCode:           string;
  upiId:           string;
  kycStatus:       string;
  amount:          number;        // sum of all PENDING payout entries for this outlet
  isDeactivated:   boolean;       // flag if outlet was deactivated after upload
  utrStatus:       'PENDING' | 'PAID' | 'FAILED';
  utr?:            string;
  paidAt?:         string;
  failureReason?:  string;
  entryIds:        string[];      // IDs of CreditPayoutEntry records in this row
}

/** A Gifsy-generated payout download batch (one per period + group) */
export interface PayoutBatch {
  id:            string;        // batch ID e.g. 'PB-2026-05-001'
  creditBatchId: string;        // which credit batch (or 'MULTI' if spans multiple)
  period:        string;        // 'YYYY-MM'
  groupType:     PayoutGroupType;
  fieldId?:      string;        // for SEPARATE batches
  fieldName?:    string;
  status:        PayoutBatchStatus;
  downloadedAt:  string;
  downloadedBy:  string;
  totalAmount:   number;
  bankSnapshots: BankSnapshot[];
  rows:          PayoutBatchRow[];
}

// ─── UTR Upload ───────────────────────────────────────────────────────────────

export interface UtrUploadRow {
  rowNum:     number;
  outletId:   string;
  batchId:    string;
  utr:        string;
  success:    boolean;     // true = success, false = failure
  remarks:    string;
  status:     'OK' | 'ERROR' | 'SKIP';
  errors:     string[];
}

export interface UtrParseResult {
  headerError: string | null;
  rows:        UtrUploadRow[];
  hasErrors:   boolean;
  canProceed:  boolean;
  summary: {
    total:       number;
    ok:          number;
    skipped:     number;
    errors:      number;
    paidCount:   number;
    failedCount: number;
  };
}

// ─── Outlet Master Row ────────────────────────────────────────────────────────
//
// One row in the Outlet Master Excel download. Covers all ~70 columns agreed
// in the product spec across 9 sections:
//   A: Identity      B: Contact/Address   C: Program/Distribution
//   D: Sales Hierarchy (6 levels)         E: Enrollment / KYC Status
//   F: KYC / Approval details             G: KYC Documents (including signature)
//   H: Banking (including accountHolder)  I: Lifecycle timestamps

export interface OutletMasterRow {
  // ── A: Identity ──────────────────────────────────────────────────────────────
  outletId:        string;
  outletCode?:     string;   // Human-readable code e.g. OUT-2026-001
  outletName:      string;
  outletType:      string;
  partnerClass?:   string;   // SSS / WHOLESALER / SUB_STOCKIST
  programName:     string;
  programCategory: string;
  beat:            string;
  isMetro:         boolean;

  // ── B: Contact / Address ─────────────────────────────────────────────────────
  ownerName?:      string;
  phone?:          string;
  addressLine1:    string;
  addressLine2?:   string;
  city:            string;
  state:           string;
  pincode:         string;

  // ── C: Program / Distribution ────────────────────────────────────────────────
  distributorId?:   string;
  distributorName?: string;

  // ── D: Sales Hierarchy (6 levels; L1 = leaf / ISR, L6 = root / NSM) ─────────
  hierarchyL1Id:    string;
  hierarchyL1Name:  string;
  hierarchyL2Id:    string;
  hierarchyL2Name:  string;
  hierarchyL3Id:    string;
  hierarchyL3Name:  string;
  hierarchyL4Id:    string;
  hierarchyL4Name:  string;
  hierarchyL5Id:    string;
  hierarchyL5Name:  string;
  hierarchyL6Id:    string;
  hierarchyL6Name:  string;

  // ── E: Enrollment / KYC Status ───────────────────────────────────────────────
  kycStatus:        string;
  isActive:         boolean;
  addedDate:        string;   // ISO date
  enrolledByName?:  string;   // Sales person who enrolled the outlet

  // ── F: KYC / Approval ────────────────────────────────────────────────────────
  panNumber?:        string;
  gstNumber?:        string;
  kycApprovedAt?:    string;  // ISO
  kycRejectedAt?:    string;  // ISO
  kycRejectionReason?: string;

  // ── G: KYC Documents ─────────────────────────────────────────────────────────
  docAadhaarFront?:     string;  // URL or placeholder
  docAadhaarBack?:      string;
  docPanCard?:          string;
  docGstCertificate?:   string;
  docTradeLicense?:     string;
  docShopEstablishment?: string;
  docBankPassbook?:     string;
  docCancelledCheque?:  string;
  docSelfie?:           string;
  docBoardPhoto?:       string;  // Geo-tagged board photo
  docSignature?:        string;  // Signature URL — shown in outlet master

  // ── H: Banking ───────────────────────────────────────────────────────────────
  bankName?:            string;
  accountHolderName?:   string;
  accountNumber?:       string;
  ifscCode?:            string;
  upiId?:               string;
  paymentMode?:         string;

  // ── I: Lifecycle ─────────────────────────────────────────────────────────────
  createdAt:            string;   // ISO
  updatedAt:            string;   // ISO
  deactivatedAt?:       string;   // ISO
  reactivatedAt?:       string;   // ISO
}

// ─── Reversal Request ─────────────────────────────────────────────────────────

export type ReversalStatus = 'PENDING_GIFSY' | 'APPROVED' | 'REJECTED' | 'PARTIAL';

export interface ReversalRequest {
  id:              string;
  batchId:         string;
  outletId:        string;
  outletName:      string;
  fieldId:         string;
  fieldName:       string;
  period:          string;
  awardType:       'POINTS' | 'PAYOUT';
  originalAmount:  number;
  requestedAmount: number;
  approvedAmount?: number;
  requestedBy:     string;
  requestedAt:     string;
  status:          ReversalStatus;
  approvedBy?:     string;
  approvedAt?:     string;
  remarks?:        string;
}


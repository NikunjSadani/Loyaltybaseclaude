// ─── Enums ───────────────────────────────────────────────────────────────────

export enum UserRole {
  GIFSY_ADMIN = 'GIFSY_ADMIN',
  CLIENT_ADMIN = 'CLIENT_ADMIN',
  MIS_USER = 'MIS_USER',
  SALES_MANAGER = 'SALES_MANAGER',
  AREA_SALES_MANAGER = 'AREA_SALES_MANAGER',
  TERRITORY_SALES_OFFICER = 'TERRITORY_SALES_OFFICER',
  SALES_EXECUTIVE = 'SALES_EXECUTIVE',
  RETAILER = 'RETAILER',
  WHOLESALER = 'WHOLESALER',
  SUB_STOCKIST = 'SUB_STOCKIST',
}

export enum KYCStatus {
  PENDING = 'PENDING',
  SUBMITTED = 'SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  RESUBMISSION_REQUIRED = 'RESUBMISSION_REQUIRED',
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
  POINTS_EARNED = 'POINTS_EARNED',
  POINTS_EXPIRY_WARNING = 'POINTS_EXPIRY_WARNING',
  REDEMPTION_CONFIRMED = 'REDEMPTION_CONFIRMED',
  DISPATCH_UPDATE = 'DISPATCH_UPDATE',
  PAYOUT_PROCESSED = 'PAYOUT_PROCESSED',
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

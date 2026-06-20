-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER', 'SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR', 'SSS', 'WHOLESALER', 'SUB_STOCKIST');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('LOGIN', 'REGISTRATION', 'PASSWORD_RESET', 'KYC_CONSENT', 'WITHDRAWAL', 'PROFILE_UPDATE', 'REDEMPTION_CONFIRM');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'APPROVE', 'REJECT', 'EXPORT', 'IMPORT');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'PENDING_PENNY_DROP', 'PENDING_AGREEMENT', 'PENDING_SO_APPROVAL', 'PENDING_ASM_APPROVAL', 'PENDING_RSM_APPROVAL', 'PENDING_GIFSY', 'APPROVED', 'REJECTED', 'RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED', 'RE_KYC_REQUIRED', 'SUSPENDED', 'NOT_INTERESTED');

-- CreateEnum
CREATE TYPE "OutletKycIntent" AS ENUM ('NOT_INTERESTED');

-- CreateEnum
CREATE TYPE "KycDocumentType" AS ENUM ('AADHAAR_FRONT', 'AADHAAR_BACK', 'PAN_CARD', 'GST_CERTIFICATE', 'TRADE_LICENSE', 'SHOP_ESTABLISHMENT', 'BANK_PASSBOOK', 'CANCELLED_CHEQUE', 'SELFIE', 'SIGNATURE', 'STORE_BOARD_PHOTO', 'SELF_DECLARATION', 'OTHER');

-- CreateEnum
CREATE TYPE "KycDocumentStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KycFieldKey" AS ENUM ('PAYMENT', 'GST_VALIDATION', 'GST_DOCUMENT', 'ADDRESS', 'ADDRESS_DOCUMENT', 'BOARD_PHOTO', 'OWNER_PHOTO');

-- CreateEnum
CREATE TYPE "KycFieldDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KycFieldSource" AS ENUM ('EXCEL', 'PORTAL');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('INDIVIDUAL', 'HUF', 'COMPANY', 'FIRM', 'LLP', 'OTHERS');

-- CreateEnum
CREATE TYPE "GstRegistrationType" AS ENUM ('REGULAR', 'COMPOSITE', 'UNREGISTERED');

-- CreateEnum
CREATE TYPE "DataRequestType" AS ENUM ('ACCESS', 'CORRECTION', 'DELETION', 'PORTABILITY');

-- CreateEnum
CREATE TYPE "DataRequestStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SchemeType" AS ENUM ('PURCHASE_INCENTIVE', 'VISIBILITY', 'GROWTH_INCENTIVE', 'REFERRAL', 'WELCOME_BONUS', 'MILESTONE', 'SLAB_BASED', 'TARGET_BASED');

-- CreateEnum
CREATE TYPE "SchemeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('POINTS', 'CASHBACK', 'GIFT_CARD', 'PHYSICAL_GIFT', 'VOUCHER');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('CREDIT_POINTS_EARNED', 'CREDIT_BONUS', 'CREDIT_REVERSAL', 'CREDIT_ADJUSTMENT', 'DEBIT_REDEMPTION', 'DEBIT_EXPIRY', 'DEBIT_ADJUSTMENT', 'LOCK_HOLDING', 'UNLOCK_HOLDING');

-- CreateEnum
CREATE TYPE "PointsLedgerType" AS ENUM ('EARN', 'LOCK', 'UNLOCK', 'REDEEM', 'EXPIRE', 'ADJUST', 'REVERSE');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'DELIVERED', 'CANCELLED', 'RETURNED', 'FAILED');

-- CreateEnum
CREATE TYPE "RewardCatalogStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'OUT_OF_STOCK', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "PayoutMode" AS ENUM ('GIFT_CARD', 'UPI', 'BANK_TRANSFER', 'PHYSICAL_GIFT');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'INITIATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED', 'HOLD');

-- CreateEnum
CREATE TYPE "PayoutBatchStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PROCESSING', 'PARTIALLY_COMPLETED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TdsSection" AS ENUM ('SEC_194R', 'SEC_194C');

-- CreateEnum
CREATE TYPE "TdsDepositorType" AS ENUM ('CLIENT', 'GIFSY');

-- CreateEnum
CREATE TYPE "FundLedgerType" AS ENUM ('RECEIPT', 'DISBURSEMENT', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "VisibilityStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "VisibilityProgramStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'PENDING_USER', 'RESOLVED', 'CLOSED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('KYC', 'POINTS', 'REDEMPTION', 'PAYOUT', 'SCHEME', 'TECHNICAL', 'ACCOUNT', 'OTHER');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'EMAIL', 'PUSH', 'WHATSAPP', 'IN_APP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('CSV', 'XLSX', 'PDF');

-- CreateEnum
CREATE TYPE "ReportFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ON_DEMAND');

-- CreateEnum
CREATE TYPE "SalesUploadStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "TargetPeriod" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "TargetStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeaderboardType" AS ENUM ('POINTS_EARNED', 'SALES_VALUE', 'GROWTH_PERCENTAGE', 'REDEMPTION_COUNT');

-- CreateEnum
CREATE TYPE "LeaderboardPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'ALL_TIME');

-- CreateEnum
CREATE TYPE "BannerPosition" AS ENUM ('HOME_TOP', 'HOME_MIDDLE', 'HOME_BOTTOM', 'CATALOG_TOP', 'SCHEME_PAGE', 'DASHBOARD');

-- CreateEnum
CREATE TYPE "BannerStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ONBOARDING');

-- CreateEnum
CREATE TYPE "AutoInvoiceStatus" AS ENUM ('GENERATED', 'PAID');

-- CreateEnum
CREATE TYPE "OutletVisibilityStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED');

-- CreateEnum
CREATE TYPE "CreditBatchStatus" AS ENUM ('PENDING_CONFIRM', 'CONFIRMED', 'PARTIALLY_REVERSED');

-- CreateEnum
CREATE TYPE "CreditAwardType" AS ENUM ('POINTS', 'PAYOUT');

-- CreateEnum
CREATE TYPE "CreditReversalStatus" AS ENUM ('PENDING_GIFSY', 'APPROVED', 'PARTIAL', 'REJECTED');

-- CreateEnum
CREATE TYPE "CreditEntryStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED');

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "internalName" TEXT NOT NULL,
    "status" "ClientStatus" NOT NULL,
    "onboardedAt" TIMESTAMP(3) NOT NULL,
    "branding" JSONB NOT NULL,
    "features" JSONB NOT NULL,
    "approvalHierarchy" JSONB NOT NULL,
    "notifications" JSONB NOT NULL,
    "invoicing" JSONB NOT NULL,
    "wallet" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "avatarUrl" TEXT,
    "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
    "fcmToken" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "loginCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "refreshToken" TEXT,
    "deviceId" TEXT,
    "deviceName" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "targetUserId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "oldValues" JSONB,
    "newValues" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_hierarchy_levels" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_hierarchy_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_users" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hierarchyLevelId" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "reportingToId" TEXT,
    "region" TEXT,
    "zone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "sales_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_user_assignments" (
    "id" TEXT NOT NULL,
    "salesUserId" TEXT NOT NULL,
    "partnerId" TEXT,
    "outletId" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_user_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_partners" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "partnerCode" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "gstNumber" TEXT,
    "panNumber" TEXT,
    "entityType" "EntityType",
    "gstRegistrationType" "GstRegistrationType",
    "bankName" TEXT,
    "bankAccountNumber" TEXT,
    "bankAccountHolder" TEXT,
    "ifscCode" TEXT,
    "upiId" TEXT,
    "paymentMode" TEXT,
    "totalEarnedPoints" INTEGER NOT NULL DEFAULT 0,
    "referredBy" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "onboardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "channel_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_submissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "partnerId" TEXT,
    "status" "KycStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "reviewerNotes" TEXT,
    "pennydropRef" TEXT,
    "pennydropStatus" TEXT,
    "pennydropVerifiedAt" TIMESTAMP(3),
    "agreementRef" TEXT,
    "agreementSignedAt" TIMESTAMP(3),
    "escalatedFrom" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "boardPhotoLat" DECIMAL(10,8),
    "boardPhotoLng" DECIMAL(11,8),
    "boardPhotoGeoAccuracy" DECIMAL(8,2),
    "boardPhotoGeoAt" TIMESTAMP(3),
    "paymentLat" DECIMAL(10,8),
    "paymentLng" DECIMAL(11,8),
    "paymentGeoAccuracy" DECIMAL(8,2),
    "paymentGeoAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_documents" (
    "id" TEXT NOT NULL,
    "kycSubmissionId" TEXT NOT NULL,
    "documentType" "KycDocumentType" NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT,
    "fileSizeBytes" INTEGER,
    "mimeType" TEXT,
    "status" "KycDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_status_history" (
    "id" TEXT NOT NULL,
    "kycSubmissionId" TEXT NOT NULL,
    "fromStatus" "KycStatus",
    "toStatus" "KycStatus" NOT NULL,
    "changedByUserId" TEXT,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_verification_items" (
    "id" TEXT NOT NULL,
    "kycSubmissionId" TEXT NOT NULL,
    "fieldKey" "KycFieldKey" NOT NULL,
    "decision" "KycFieldDecision" NOT NULL DEFAULT 'PENDING',
    "source" "KycFieldSource",
    "remark" TEXT,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kyc_verification_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kycSubmissionId" TEXT,
    "consentType" TEXT NOT NULL,
    "consentText" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "ipAddress" TEXT,
    "deviceInfo" TEXT,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestType" "DataRequestType" NOT NULL,
    "status" "DataRequestStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "processedBy" TEXT,
    "processedAt" TIMESTAMP(3),
    "responseUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlet_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_type_client_configs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "outletTypeId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "displayName" TEXT,
    "loyaltyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "schemesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "visibilityEnabled" BOOLEAN NOT NULL DEFAULT true,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "leaderboardEnabled" BOOLEAN NOT NULL DEFAULT true,
    "targetsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "kycRequired" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlet_type_client_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlets" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "partnerId" TEXT,
    "outletTypeId" TEXT NOT NULL,
    "distributorCode" TEXT,
    "distributorName" TEXT,
    "beat" TEXT,
    "metro" TEXT,
    "zone" TEXT,
    "programName" TEXT,
    "programCategory" TEXT,
    "outletCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerName" TEXT,
    "phone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "district" TEXT,
    "state" TEXT NOT NULL,
    "pincode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "latitude" DECIMAL(10,8),
    "longitude" DECIMAL(11,8),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "kycIntent" "OutletKycIntent",
    "kycIntentBy" TEXT,
    "kycIntentAt" TIMESTAMP(3),
    "reKycFlags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "reactivatedAt" TIMESTAMP(3),

    CONSTRAINT "outlets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_geo_history" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "latitude" DECIMAL(10,8) NOT NULL,
    "longitude" DECIMAL(11,8) NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceInfo" TEXT,
    "accuracy" DECIMAL(8,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outlet_geo_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schemes" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "schemeType" "SchemeType" NOT NULL,
    "status" "SchemeStatus" NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "holdingPeriodDays" INTEGER NOT NULL DEFAULT 30,
    "rewardType" "RewardType" NOT NULL,
    "budgetPaise" INTEGER,
    "spentPaise" INTEGER NOT NULL DEFAULT 0,
    "termsAndConditions" TEXT,
    "isStackable" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "metadata" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheme_eligibility" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "specificPartnerId" TEXT,
    "stateCode" TEXT,
    "cityCode" TEXT,
    "pincodePattern" TEXT,
    "isExclusion" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheme_eligibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "earnedPoints" INTEGER NOT NULL DEFAULT 0,
    "lockedPoints" INTEGER NOT NULL DEFAULT 0,
    "redeemablePoints" INTEGER NOT NULL DEFAULT 0,
    "redeemedPoints" INTEGER NOT NULL DEFAULT 0,
    "expiredPoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimeEarned" INTEGER NOT NULL DEFAULT 0,
    "lifetimeRedeemed" INTEGER NOT NULL DEFAULT 0,
    "lifetimeExpired" INTEGER NOT NULL DEFAULT 0,
    "lastTransactionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "transactionType" "WalletTransactionType" NOT NULL,
    "points" INTEGER NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "balanceType" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points_ledger" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "schemeId" TEXT,
    "transactionType" "PointsLedgerType" NOT NULL,
    "points" INTEGER NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "isExpired" BOOLEAN NOT NULL DEFAULT false,
    "isClaimed" BOOLEAN NOT NULL DEFAULT false,
    "claimedAt" TIMESTAMP(3),
    "sourceType" TEXT,
    "sourceId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "points_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_expiry_config" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "schemeId" TEXT,
    "expiryDays" INTEGER NOT NULL,
    "warningDaysBefore" INTEGER NOT NULL DEFAULT 7,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "point_expiry_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_categories" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "parentId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_catalog" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrls" JSONB,
    "pointsCost" INTEGER NOT NULL,
    "mrpPaise" INTEGER,
    "redemptionMode" "PayoutMode" NOT NULL,
    "status" "RewardCatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "minRedemptionPoints" INTEGER,
    "maxRedemptionPoints" INTEGER,
    "stockQuantity" INTEGER,
    "termsAndConditions" TEXT,
    "metadata" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "reward_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redemption_orders" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "rewardId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'PENDING',
    "pointsDeducted" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "totalPointsCost" INTEGER NOT NULL,
    "valuePaise" BIGINT,
    "redemptionMode" "PayoutMode" NOT NULL,
    "deliveryName" TEXT,
    "deliveryPhone" TEXT,
    "deliveryAddressLine1" TEXT,
    "deliveryAddressLine2" TEXT,
    "deliveryCity" TEXT,
    "deliveryState" TEXT,
    "deliveryPincode" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "voucherCode" TEXT,
    "voucherProvider" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "redemption_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redemption_status_history" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" "RedemptionStatus",
    "toStatus" "RedemptionStatus" NOT NULL,
    "changedById" TEXT,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redemption_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visibility_programs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "VisibilityProgramStatus" NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "pointsPerSubmission" INTEGER NOT NULL,
    "maxSubmissionsPerMonth" INTEGER,
    "checklistItems" JSONB,
    "imageRequirements" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "visibility_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visibility_submissions" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "status" "VisibilityStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "imageUrls" JSONB,
    "checklistData" JSONB,
    "latitude" DECIMAL(10,8),
    "longitude" DECIMAL(11,8),
    "deviceInfo" TEXT,
    "pointsAwarded" INTEGER,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "isFraudFlagged" BOOLEAN NOT NULL DEFAULT false,
    "fraudScore" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visibility_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visibility_approvals" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "fromStatus" "VisibilityStatus",
    "toStatus" "VisibilityStatus" NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visibility_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visibility_fraud_log" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "flagType" TEXT NOT NULL,
    "flagDetails" JSONB,
    "fraudScore" DECIMAL(5,2) NOT NULL,
    "isConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visibility_fraud_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visibility_image_hashes" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "imageHash" TEXT NOT NULL,
    "hashAlgorithm" TEXT NOT NULL DEFAULT 'phash',
    "isDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "duplicateOf" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visibility_image_hashes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_batches" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "status" "PayoutBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "payoutMode" "PayoutMode" NOT NULL,
    "totalAmountPaise" BIGINT NOT NULL DEFAULT 0,
    "transactionCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_transactions" (
    "id" TEXT NOT NULL,
    "batchId" TEXT,
    "partnerId" TEXT NOT NULL,
    "redemptionOrderId" TEXT,
    "payoutMode" "PayoutMode" NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "amountPaise" BIGINT NOT NULL,
    "beneficiaryName" TEXT,
    "beneficiaryPhone" TEXT,
    "upiId" TEXT,
    "bankAccountNumber" TEXT,
    "ifscCode" TEXT,
    "bankName" TEXT,
    "giftCardCode" TEXT,
    "giftCardProvider" TEXT,
    "providerRefId" TEXT,
    "providerResponse" JSONB,
    "failureReason" TEXT,
    "initiatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "tdsApplicable" BOOLEAN NOT NULL DEFAULT false,
    "tdsPaise" BIGINT NOT NULL DEFAULT 0,
    "netAmountPaise" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fund_ledger" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ledgerType" "FundLedgerType" NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "balancePaise" BIGINT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fund_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fund_receipts" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "paymentMode" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "bankName" TEXT,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fund_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_records" (
    "id" TEXT NOT NULL,
    "payoutTransactionId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "panNumber" TEXT,
    "tdsPaise" BIGINT NOT NULL,
    "section" "TdsSection",
    "tdsRate" DECIMAL(5,2) NOT NULL,
    "assessmentYear" TEXT,
    "quarterPeriod" TEXT,
    "formType" TEXT,
    "certificateNumber" TEXT,
    "certificateIssuedAt" TIMESTAMP(3),
    "certificateUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tds_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_off_platform_entries" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "section" "TdsSection" NOT NULL DEFAULT 'SEC_194R',
    "entryDate" TIMESTAMP(3) NOT NULL,
    "panNumber" TEXT NOT NULL,
    "outletCode" TEXT,
    "amountPaise" BIGINT NOT NULL,
    "uploadBatchId" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_off_platform_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_deposits" (
    "id" TEXT NOT NULL,
    "section" "TdsSection" NOT NULL,
    "depositorType" "TdsDepositorType" NOT NULL,
    "clientId" TEXT,
    "depositDate" TIMESTAMP(3) NOT NULL,
    "panNumber" TEXT NOT NULL,
    "outletCode" TEXT,
    "amountPaise" BIGINT NOT NULL,
    "uploadBatchId" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_invoices" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "outletCode" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "periodStartDate" TIMESTAMP(3),
    "periodEndDate" TIMESTAMP(3),
    "status" "AutoInvoiceStatus" NOT NULL DEFAULT 'GENERATED',
    "invoiceNumberEdited" BOOLEAN NOT NULL DEFAULT false,
    "lineItems" JSONB NOT NULL,
    "subtotalPaise" BIGINT NOT NULL,
    "gstPaise" BIGINT NOT NULL DEFAULT 0,
    "gstType" TEXT,
    "totalPaise" BIGINT NOT NULL,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "pdfUrl" TEXT,
    "emailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_configs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "leaderboardType" "LeaderboardType" NOT NULL,
    "period" "LeaderboardPeriod" NOT NULL,
    "topN" INTEGER NOT NULL DEFAULT 10,
    "rewardPoints" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leaderboard_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_snapshots" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "snapshotDate" TIMESTAMP(3) NOT NULL,
    "periodStartDate" TIMESTAMP(3) NOT NULL,
    "periodEndDate" TIMESTAMP(3) NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leaderboard_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_entries" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" DECIMAL(15,2) NOT NULL,
    "previousRank" INTEGER,
    "rankChange" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ticketNumber" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "assignedToId" TEXT,
    "category" "TicketCategory" NOT NULL,
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "slaBreached" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_status_history" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "fromStatus" "TicketStatus",
    "toStatus" "TicketStatus" NOT NULL,
    "changedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" TEXT,
    "bodyTemplate" TEXT NOT NULL,
    "variables" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_queue" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "templateId" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "recipientPhone" TEXT,
    "recipientEmail" TEXT,
    "recipientFcm" TEXT,
    "variables" JSONB,
    "scheduledAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_delivery_log" (
    "id" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL,
    "providerRef" TEXT,
    "providerResponse" JSONB,
    "deliveredAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_delivery_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_configs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banner_management" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "linkUrl" TEXT,
    "position" "BannerPosition" NOT NULL,
    "status" "BannerStatus" NOT NULL DEFAULT 'INACTIVE',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "banner_management_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_settings" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "settingKey" TEXT NOT NULL,
    "settingValue" JSONB NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "isEditable" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "program_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_reports" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "reportCode" TEXT NOT NULL,
    "reportName" TEXT NOT NULL,
    "description" TEXT,
    "frequency" "ReportFrequency" NOT NULL,
    "format" "ReportFormat" NOT NULL DEFAULT 'XLSX',
    "filters" JSONB,
    "recipientEmails" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_delivery_log" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "triggeredById" TEXT,
    "status" TEXT NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "fileUrl" TEXT,
    "fileKey" TEXT,
    "fileSizeBytes" INTEGER,
    "rowCount" INTEGER,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "emailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_delivery_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheme_enrollments" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "enrollmentMode" TEXT NOT NULL DEFAULT 'SELF',
    "formValues" JSONB,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheme_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheme_enrollment_forms" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "campaignType" TEXT NOT NULL DEFAULT 'LOYALTY_ONLY',
    "formSchema" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheme_enrollment_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "deviceInfo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "login_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_visibility_upload_batches" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL,
    "errorCount" INTEGER NOT NULL,
    "errors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outlet_visibility_upload_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_visibility_records" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "outletCode" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" "OutletVisibilityStatus" NOT NULL,
    "dateOfCapture" TIMESTAMP(3),
    "approvedBy" TEXT,
    "capturedByEmployeeId" TEXT,
    "capturedByEmployeeName" TEXT,
    "capturedByEmployeePhone" TEXT,
    "uploadBatchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlet_visibility_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_visibility_audit_logs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "outletCode" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "previousStatus" "OutletVisibilityStatus",
    "newStatus" "OutletVisibilityStatus" NOT NULL,
    "uploadBatchId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outlet_visibility_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_upload_batches" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_upload_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_sales_records" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "outletCode" TEXT NOT NULL,
    "outletName" TEXT NOT NULL,
    "outletType" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "kpiValues" JSONB NOT NULL,
    "batchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlet_sales_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_defs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "hasNameOverride" BOOLEAN NOT NULL DEFAULT false,
    "nameOverrideLabel" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kpi_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "target_upload_batches" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "target_upload_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_targets" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "outletCode" TEXT NOT NULL,
    "outletName" TEXT NOT NULL,
    "outletType" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "targetValues" JSONB NOT NULL,
    "batchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlet_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_fields" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSeparatePayout" BOOLEAN NOT NULL DEFAULT false,
    "outletTypeAwards" JSONB NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_batches" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" "CreditBatchStatus" NOT NULL DEFAULT 'PENDING_CONFIRM',
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "totalOutlets" INTEGER NOT NULL DEFAULT 0,
    "totalPoints" INTEGER NOT NULL DEFAULT 0,
    "totalPayoutPaise" BIGINT NOT NULL DEFAULT 0,
    "rows" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_payout_entries" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "downloadId" TEXT,
    "outletId" TEXT NOT NULL,
    "outletName" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "narration" TEXT NOT NULL DEFAULT '',
    "status" "CreditEntryStatus" NOT NULL DEFAULT 'PENDING',
    "utr" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_payout_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_payout_downloads" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "downloadCode" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "groupType" TEXT NOT NULL,
    "fieldId" TEXT,
    "fieldName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "downloadedBy" TEXT NOT NULL,
    "downloadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalAmountPaise" BIGINT NOT NULL,
    "bankSnapshots" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_payout_downloads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_reversals" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "outletName" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "awardType" "CreditAwardType" NOT NULL,
    "originalPaise" BIGINT NOT NULL,
    "requestedPaise" BIGINT NOT NULL,
    "approvedPaise" BIGINT,
    "shortfallPaise" BIGINT NOT NULL DEFAULT 0,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "status" "CreditReversalStatus" NOT NULL DEFAULT 'PENDING_GIFSY',
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_clientId_idx" ON "users"("clientId");

-- CreateIndex
CREATE INDEX "users_phone_idx" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "users_clientId_phone_key" ON "users"("clientId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_clientId_email_key" ON "users"("clientId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_token_key" ON "user_sessions"("token");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_refreshToken_key" ON "user_sessions"("refreshToken");

-- CreateIndex
CREATE INDEX "user_sessions_userId_idx" ON "user_sessions"("userId");

-- CreateIndex
CREATE INDEX "user_sessions_clientId_idx" ON "user_sessions"("clientId");

-- CreateIndex
CREATE INDEX "user_sessions_token_idx" ON "user_sessions"("token");

-- CreateIndex
CREATE INDEX "user_sessions_expiresAt_idx" ON "user_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "otp_codes_phone_idx" ON "otp_codes"("phone");

-- CreateIndex
CREATE INDEX "otp_codes_userId_idx" ON "otp_codes"("userId");

-- CreateIndex
CREATE INDEX "otp_codes_purpose_idx" ON "otp_codes"("purpose");

-- CreateIndex
CREATE INDEX "otp_codes_expiresAt_idx" ON "otp_codes"("expiresAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "audit_logs_targetUserId_idx" ON "audit_logs"("targetUserId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "sales_hierarchy_levels_clientId_idx" ON "sales_hierarchy_levels"("clientId");

-- CreateIndex
CREATE INDEX "sales_hierarchy_levels_level_idx" ON "sales_hierarchy_levels"("level");

-- CreateIndex
CREATE UNIQUE INDEX "sales_hierarchy_levels_clientId_code_key" ON "sales_hierarchy_levels"("clientId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "sales_hierarchy_levels_clientId_level_key" ON "sales_hierarchy_levels"("clientId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "sales_users_userId_key" ON "sales_users"("userId");

-- CreateIndex
CREATE INDEX "sales_users_clientId_idx" ON "sales_users"("clientId");

-- CreateIndex
CREATE INDEX "sales_users_userId_idx" ON "sales_users"("userId");

-- CreateIndex
CREATE INDEX "sales_users_hierarchyLevelId_idx" ON "sales_users"("hierarchyLevelId");

-- CreateIndex
CREATE INDEX "sales_users_reportingToId_idx" ON "sales_users"("reportingToId");

-- CreateIndex
CREATE INDEX "sales_users_employeeCode_idx" ON "sales_users"("employeeCode");

-- CreateIndex
CREATE INDEX "sales_users_deletedAt_idx" ON "sales_users"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sales_users_clientId_employeeCode_key" ON "sales_users"("clientId", "employeeCode");

-- CreateIndex
CREATE INDEX "sales_user_assignments_salesUserId_idx" ON "sales_user_assignments"("salesUserId");

-- CreateIndex
CREATE INDEX "sales_user_assignments_partnerId_idx" ON "sales_user_assignments"("partnerId");

-- CreateIndex
CREATE INDEX "sales_user_assignments_outletId_idx" ON "sales_user_assignments"("outletId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_partners_userId_key" ON "channel_partners"("userId");

-- CreateIndex
CREATE INDEX "channel_partners_clientId_idx" ON "channel_partners"("clientId");

-- CreateIndex
CREATE INDEX "channel_partners_userId_idx" ON "channel_partners"("userId");

-- CreateIndex
CREATE INDEX "channel_partners_partnerCode_idx" ON "channel_partners"("partnerCode");

-- CreateIndex
CREATE INDEX "channel_partners_gstNumber_idx" ON "channel_partners"("gstNumber");

-- CreateIndex
CREATE INDEX "channel_partners_isActive_idx" ON "channel_partners"("isActive");

-- CreateIndex
CREATE INDEX "channel_partners_deletedAt_idx" ON "channel_partners"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "channel_partners_clientId_partnerCode_key" ON "channel_partners"("clientId", "partnerCode");

-- CreateIndex
CREATE UNIQUE INDEX "channel_partners_clientId_gstNumber_key" ON "channel_partners"("clientId", "gstNumber");

-- CreateIndex
CREATE INDEX "kyc_submissions_userId_idx" ON "kyc_submissions"("userId");

-- CreateIndex
CREATE INDEX "kyc_submissions_partnerId_idx" ON "kyc_submissions"("partnerId");

-- CreateIndex
CREATE INDEX "kyc_submissions_status_idx" ON "kyc_submissions"("status");

-- CreateIndex
CREATE INDEX "kyc_submissions_submittedAt_idx" ON "kyc_submissions"("submittedAt");

-- CreateIndex
CREATE INDEX "kyc_documents_kycSubmissionId_idx" ON "kyc_documents"("kycSubmissionId");

-- CreateIndex
CREATE INDEX "kyc_documents_documentType_idx" ON "kyc_documents"("documentType");

-- CreateIndex
CREATE INDEX "kyc_documents_status_idx" ON "kyc_documents"("status");

-- CreateIndex
CREATE INDEX "kyc_status_history_kycSubmissionId_idx" ON "kyc_status_history"("kycSubmissionId");

-- CreateIndex
CREATE INDEX "kyc_status_history_createdAt_idx" ON "kyc_status_history"("createdAt");

-- CreateIndex
CREATE INDEX "kyc_verification_items_kycSubmissionId_idx" ON "kyc_verification_items"("kycSubmissionId");

-- CreateIndex
CREATE INDEX "kyc_verification_items_decision_idx" ON "kyc_verification_items"("decision");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_verification_items_kycSubmissionId_fieldKey_key" ON "kyc_verification_items"("kycSubmissionId", "fieldKey");

-- CreateIndex
CREATE INDEX "consent_records_userId_idx" ON "consent_records"("userId");

-- CreateIndex
CREATE INDEX "consent_records_kycSubmissionId_idx" ON "consent_records"("kycSubmissionId");

-- CreateIndex
CREATE INDEX "consent_records_consentType_idx" ON "consent_records"("consentType");

-- CreateIndex
CREATE INDEX "data_requests_userId_idx" ON "data_requests"("userId");

-- CreateIndex
CREATE INDEX "data_requests_status_idx" ON "data_requests"("status");

-- CreateIndex
CREATE INDEX "data_requests_requestType_idx" ON "data_requests"("requestType");

-- CreateIndex
CREATE INDEX "outlet_type_client_configs_clientId_idx" ON "outlet_type_client_configs"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "outlet_type_client_configs_clientId_outletTypeId_key" ON "outlet_type_client_configs"("clientId", "outletTypeId");

-- CreateIndex
CREATE INDEX "outlets_clientId_idx" ON "outlets"("clientId");

-- CreateIndex
CREATE INDEX "outlets_partnerId_idx" ON "outlets"("partnerId");

-- CreateIndex
CREATE INDEX "outlets_outletTypeId_idx" ON "outlets"("outletTypeId");

-- CreateIndex
CREATE INDEX "outlets_distributorCode_idx" ON "outlets"("distributorCode");

-- CreateIndex
CREATE INDEX "outlets_pincode_idx" ON "outlets"("pincode");

-- CreateIndex
CREATE INDEX "outlets_state_idx" ON "outlets"("state");

-- CreateIndex
CREATE INDEX "outlets_isActive_idx" ON "outlets"("isActive");

-- CreateIndex
CREATE INDEX "outlets_deletedAt_idx" ON "outlets"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "outlets_clientId_outletCode_key" ON "outlets"("clientId", "outletCode");

-- CreateIndex
CREATE INDEX "outlet_geo_history_outletId_idx" ON "outlet_geo_history"("outletId");

-- CreateIndex
CREATE INDEX "outlet_geo_history_capturedAt_idx" ON "outlet_geo_history"("capturedAt");

-- CreateIndex
CREATE INDEX "schemes_clientId_idx" ON "schemes"("clientId");

-- CreateIndex
CREATE INDEX "schemes_status_idx" ON "schemes"("status");

-- CreateIndex
CREATE INDEX "schemes_startDate_endDate_idx" ON "schemes"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "schemes_schemeType_idx" ON "schemes"("schemeType");

-- CreateIndex
CREATE INDEX "schemes_deletedAt_idx" ON "schemes"("deletedAt");

-- CreateIndex
CREATE INDEX "scheme_eligibility_schemeId_idx" ON "scheme_eligibility"("schemeId");

-- CreateIndex
CREATE INDEX "scheme_eligibility_specificPartnerId_idx" ON "scheme_eligibility"("specificPartnerId");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_partnerId_key" ON "wallets"("partnerId");

-- CreateIndex
CREATE INDEX "wallets_partnerId_idx" ON "wallets"("partnerId");

-- CreateIndex
CREATE INDEX "wallet_transactions_walletId_idx" ON "wallet_transactions"("walletId");

-- CreateIndex
CREATE INDEX "wallet_transactions_transactionType_idx" ON "wallet_transactions"("transactionType");

-- CreateIndex
CREATE INDEX "wallet_transactions_referenceType_referenceId_idx" ON "wallet_transactions"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "wallet_transactions_createdAt_idx" ON "wallet_transactions"("createdAt");

-- CreateIndex
CREATE INDEX "points_ledger_walletId_idx" ON "points_ledger"("walletId");

-- CreateIndex
CREATE INDEX "points_ledger_schemeId_idx" ON "points_ledger"("schemeId");

-- CreateIndex
CREATE INDEX "points_ledger_lockedUntil_idx" ON "points_ledger"("lockedUntil");

-- CreateIndex
CREATE INDEX "points_ledger_expiresAt_idx" ON "points_ledger"("expiresAt");

-- CreateIndex
CREATE INDEX "points_ledger_isExpired_idx" ON "points_ledger"("isExpired");

-- CreateIndex
CREATE INDEX "points_ledger_createdAt_idx" ON "points_ledger"("createdAt");

-- CreateIndex
CREATE INDEX "point_expiry_config_clientId_idx" ON "point_expiry_config"("clientId");

-- CreateIndex
CREATE INDEX "point_expiry_config_schemeId_idx" ON "point_expiry_config"("schemeId");

-- CreateIndex
CREATE INDEX "reward_categories_clientId_idx" ON "reward_categories"("clientId");

-- CreateIndex
CREATE INDEX "reward_categories_parentId_idx" ON "reward_categories"("parentId");

-- CreateIndex
CREATE INDEX "reward_catalog_clientId_idx" ON "reward_catalog"("clientId");

-- CreateIndex
CREATE INDEX "reward_catalog_categoryId_idx" ON "reward_catalog"("categoryId");

-- CreateIndex
CREATE INDEX "reward_catalog_status_idx" ON "reward_catalog"("status");

-- CreateIndex
CREATE INDEX "reward_catalog_redemptionMode_idx" ON "reward_catalog"("redemptionMode");

-- CreateIndex
CREATE INDEX "reward_catalog_deletedAt_idx" ON "reward_catalog"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "redemption_orders_orderNumber_key" ON "redemption_orders"("orderNumber");

-- CreateIndex
CREATE INDEX "redemption_orders_partnerId_idx" ON "redemption_orders"("partnerId");

-- CreateIndex
CREATE INDEX "redemption_orders_rewardId_idx" ON "redemption_orders"("rewardId");

-- CreateIndex
CREATE INDEX "redemption_orders_status_idx" ON "redemption_orders"("status");

-- CreateIndex
CREATE INDEX "redemption_orders_orderNumber_idx" ON "redemption_orders"("orderNumber");

-- CreateIndex
CREATE INDEX "redemption_orders_createdAt_idx" ON "redemption_orders"("createdAt");

-- CreateIndex
CREATE INDEX "redemption_status_history_orderId_idx" ON "redemption_status_history"("orderId");

-- CreateIndex
CREATE INDEX "redemption_status_history_createdAt_idx" ON "redemption_status_history"("createdAt");

-- CreateIndex
CREATE INDEX "visibility_programs_clientId_idx" ON "visibility_programs"("clientId");

-- CreateIndex
CREATE INDEX "visibility_programs_status_idx" ON "visibility_programs"("status");

-- CreateIndex
CREATE INDEX "visibility_programs_startDate_endDate_idx" ON "visibility_programs"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "visibility_programs_deletedAt_idx" ON "visibility_programs"("deletedAt");

-- CreateIndex
CREATE INDEX "visibility_submissions_programId_idx" ON "visibility_submissions"("programId");

-- CreateIndex
CREATE INDEX "visibility_submissions_partnerId_idx" ON "visibility_submissions"("partnerId");

-- CreateIndex
CREATE INDEX "visibility_submissions_outletId_idx" ON "visibility_submissions"("outletId");

-- CreateIndex
CREATE INDEX "visibility_submissions_status_idx" ON "visibility_submissions"("status");

-- CreateIndex
CREATE INDEX "visibility_submissions_submittedAt_idx" ON "visibility_submissions"("submittedAt");

-- CreateIndex
CREATE INDEX "visibility_approvals_submissionId_idx" ON "visibility_approvals"("submissionId");

-- CreateIndex
CREATE INDEX "visibility_approvals_reviewerUserId_idx" ON "visibility_approvals"("reviewerUserId");

-- CreateIndex
CREATE INDEX "visibility_fraud_log_submissionId_idx" ON "visibility_fraud_log"("submissionId");

-- CreateIndex
CREATE INDEX "visibility_fraud_log_flagType_idx" ON "visibility_fraud_log"("flagType");

-- CreateIndex
CREATE INDEX "visibility_fraud_log_isConfirmed_idx" ON "visibility_fraud_log"("isConfirmed");

-- CreateIndex
CREATE INDEX "visibility_image_hashes_submissionId_idx" ON "visibility_image_hashes"("submissionId");

-- CreateIndex
CREATE INDEX "visibility_image_hashes_imageHash_idx" ON "visibility_image_hashes"("imageHash");

-- CreateIndex
CREATE UNIQUE INDEX "visibility_image_hashes_imageHash_key" ON "visibility_image_hashes"("imageHash");

-- CreateIndex
CREATE INDEX "payout_batches_clientId_idx" ON "payout_batches"("clientId");

-- CreateIndex
CREATE INDEX "payout_batches_status_idx" ON "payout_batches"("status");

-- CreateIndex
CREATE INDEX "payout_batches_payoutMode_idx" ON "payout_batches"("payoutMode");

-- CreateIndex
CREATE INDEX "payout_batches_createdAt_idx" ON "payout_batches"("createdAt");

-- CreateIndex
CREATE INDEX "payout_transactions_batchId_idx" ON "payout_transactions"("batchId");

-- CreateIndex
CREATE INDEX "payout_transactions_partnerId_idx" ON "payout_transactions"("partnerId");

-- CreateIndex
CREATE INDEX "payout_transactions_status_idx" ON "payout_transactions"("status");

-- CreateIndex
CREATE INDEX "payout_transactions_payoutMode_idx" ON "payout_transactions"("payoutMode");

-- CreateIndex
CREATE INDEX "payout_transactions_createdAt_idx" ON "payout_transactions"("createdAt");

-- CreateIndex
CREATE INDEX "fund_ledger_clientId_idx" ON "fund_ledger"("clientId");

-- CreateIndex
CREATE INDEX "fund_ledger_ledgerType_idx" ON "fund_ledger"("ledgerType");

-- CreateIndex
CREATE INDEX "fund_ledger_referenceType_referenceId_idx" ON "fund_ledger"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "fund_ledger_createdAt_idx" ON "fund_ledger"("createdAt");

-- CreateIndex
CREATE INDEX "fund_receipts_clientId_idx" ON "fund_receipts"("clientId");

-- CreateIndex
CREATE INDEX "fund_receipts_receivedAt_idx" ON "fund_receipts"("receivedAt");

-- CreateIndex
CREATE INDEX "fund_receipts_referenceNumber_idx" ON "fund_receipts"("referenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "tds_records_payoutTransactionId_key" ON "tds_records"("payoutTransactionId");

-- CreateIndex
CREATE INDEX "tds_records_partnerId_idx" ON "tds_records"("partnerId");

-- CreateIndex
CREATE INDEX "tds_records_panNumber_idx" ON "tds_records"("panNumber");

-- CreateIndex
CREATE INDEX "tds_records_quarterPeriod_idx" ON "tds_records"("quarterPeriod");

-- CreateIndex
CREATE INDEX "tds_off_platform_entries_clientId_panNumber_idx" ON "tds_off_platform_entries"("clientId", "panNumber");

-- CreateIndex
CREATE INDEX "tds_off_platform_entries_clientId_entryDate_idx" ON "tds_off_platform_entries"("clientId", "entryDate");

-- CreateIndex
CREATE INDEX "tds_deposits_section_panNumber_idx" ON "tds_deposits"("section", "panNumber");

-- CreateIndex
CREATE INDEX "tds_deposits_clientId_section_panNumber_idx" ON "tds_deposits"("clientId", "section", "panNumber");

-- CreateIndex
CREATE INDEX "tds_deposits_depositDate_idx" ON "tds_deposits"("depositDate");

-- CreateIndex
CREATE UNIQUE INDEX "auto_invoices_invoiceNumber_key" ON "auto_invoices"("invoiceNumber");

-- CreateIndex
CREATE INDEX "auto_invoices_clientId_idx" ON "auto_invoices"("clientId");

-- CreateIndex
CREATE INDEX "auto_invoices_partnerId_idx" ON "auto_invoices"("partnerId");

-- CreateIndex
CREATE INDEX "auto_invoices_invoiceDate_idx" ON "auto_invoices"("invoiceDate");

-- CreateIndex
CREATE UNIQUE INDEX "auto_invoices_clientId_outletCode_period_key" ON "auto_invoices"("clientId", "outletCode", "period");

-- CreateIndex
CREATE INDEX "leaderboard_configs_clientId_idx" ON "leaderboard_configs"("clientId");

-- CreateIndex
CREATE INDEX "leaderboard_configs_leaderboardType_idx" ON "leaderboard_configs"("leaderboardType");

-- CreateIndex
CREATE INDEX "leaderboard_configs_period_idx" ON "leaderboard_configs"("period");

-- CreateIndex
CREATE INDEX "leaderboard_configs_isActive_idx" ON "leaderboard_configs"("isActive");

-- CreateIndex
CREATE INDEX "leaderboard_snapshots_configId_idx" ON "leaderboard_snapshots"("configId");

-- CreateIndex
CREATE INDEX "leaderboard_snapshots_snapshotDate_idx" ON "leaderboard_snapshots"("snapshotDate");

-- CreateIndex
CREATE INDEX "leaderboard_snapshots_isPublished_idx" ON "leaderboard_snapshots"("isPublished");

-- CreateIndex
CREATE INDEX "leaderboard_entries_snapshotId_idx" ON "leaderboard_entries"("snapshotId");

-- CreateIndex
CREATE INDEX "leaderboard_entries_partnerId_idx" ON "leaderboard_entries"("partnerId");

-- CreateIndex
CREATE INDEX "leaderboard_entries_rank_idx" ON "leaderboard_entries"("rank");

-- CreateIndex
CREATE UNIQUE INDEX "leaderboard_entries_snapshotId_rank_key" ON "leaderboard_entries"("snapshotId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "leaderboard_entries_snapshotId_partnerId_key" ON "leaderboard_entries"("snapshotId", "partnerId");

-- CreateIndex
CREATE INDEX "tickets_clientId_idx" ON "tickets"("clientId");

-- CreateIndex
CREATE INDEX "tickets_createdById_idx" ON "tickets"("createdById");

-- CreateIndex
CREATE INDEX "tickets_assignedToId_idx" ON "tickets"("assignedToId");

-- CreateIndex
CREATE INDEX "tickets_status_idx" ON "tickets"("status");

-- CreateIndex
CREATE INDEX "tickets_category_idx" ON "tickets"("category");

-- CreateIndex
CREATE INDEX "tickets_priority_idx" ON "tickets"("priority");

-- CreateIndex
CREATE INDEX "tickets_createdAt_idx" ON "tickets"("createdAt");

-- CreateIndex
CREATE INDEX "tickets_deletedAt_idx" ON "tickets"("deletedAt");

-- CreateIndex
CREATE INDEX "ticket_messages_ticketId_idx" ON "ticket_messages"("ticketId");

-- CreateIndex
CREATE INDEX "ticket_messages_senderId_idx" ON "ticket_messages"("senderId");

-- CreateIndex
CREATE INDEX "ticket_messages_createdAt_idx" ON "ticket_messages"("createdAt");

-- CreateIndex
CREATE INDEX "ticket_status_history_ticketId_idx" ON "ticket_status_history"("ticketId");

-- CreateIndex
CREATE INDEX "ticket_status_history_createdAt_idx" ON "ticket_status_history"("createdAt");

-- CreateIndex
CREATE INDEX "notification_templates_clientId_idx" ON "notification_templates"("clientId");

-- CreateIndex
CREATE INDEX "notification_templates_channel_idx" ON "notification_templates"("channel");

-- CreateIndex
CREATE INDEX "notification_templates_isActive_idx" ON "notification_templates"("isActive");

-- CreateIndex
CREATE INDEX "notification_queue_userId_idx" ON "notification_queue"("userId");

-- CreateIndex
CREATE INDEX "notification_queue_status_idx" ON "notification_queue"("status");

-- CreateIndex
CREATE INDEX "notification_queue_channel_idx" ON "notification_queue"("channel");

-- CreateIndex
CREATE INDEX "notification_queue_scheduledAt_idx" ON "notification_queue"("scheduledAt");

-- CreateIndex
CREATE INDEX "notification_queue_createdAt_idx" ON "notification_queue"("createdAt");

-- CreateIndex
CREATE INDEX "notification_delivery_log_queueId_idx" ON "notification_delivery_log"("queueId");

-- CreateIndex
CREATE INDEX "notification_delivery_log_status_idx" ON "notification_delivery_log"("status");

-- CreateIndex
CREATE INDEX "notification_delivery_log_createdAt_idx" ON "notification_delivery_log"("createdAt");

-- CreateIndex
CREATE INDEX "admin_configs_clientId_idx" ON "admin_configs"("clientId");

-- CreateIndex
CREATE INDEX "admin_configs_key_idx" ON "admin_configs"("key");

-- CreateIndex
CREATE INDEX "admin_configs_isPublic_idx" ON "admin_configs"("isPublic");

-- CreateIndex
CREATE INDEX "banner_management_clientId_idx" ON "banner_management"("clientId");

-- CreateIndex
CREATE INDEX "banner_management_position_idx" ON "banner_management"("position");

-- CreateIndex
CREATE INDEX "banner_management_status_idx" ON "banner_management"("status");

-- CreateIndex
CREATE INDEX "banner_management_startDate_endDate_idx" ON "banner_management"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "banner_management_deletedAt_idx" ON "banner_management"("deletedAt");

-- CreateIndex
CREATE INDEX "program_settings_clientId_idx" ON "program_settings"("clientId");

-- CreateIndex
CREATE INDEX "program_settings_settingKey_idx" ON "program_settings"("settingKey");

-- CreateIndex
CREATE INDEX "program_settings_category_idx" ON "program_settings"("category");

-- CreateIndex
CREATE UNIQUE INDEX "program_settings_clientId_settingKey_key" ON "program_settings"("clientId", "settingKey");

-- CreateIndex
CREATE INDEX "scheduled_reports_clientId_idx" ON "scheduled_reports"("clientId");

-- CreateIndex
CREATE INDEX "scheduled_reports_createdByUserId_idx" ON "scheduled_reports"("createdByUserId");

-- CreateIndex
CREATE INDEX "scheduled_reports_frequency_idx" ON "scheduled_reports"("frequency");

-- CreateIndex
CREATE INDEX "scheduled_reports_isActive_idx" ON "scheduled_reports"("isActive");

-- CreateIndex
CREATE INDEX "scheduled_reports_nextRunAt_idx" ON "scheduled_reports"("nextRunAt");

-- CreateIndex
CREATE INDEX "scheduled_reports_deletedAt_idx" ON "scheduled_reports"("deletedAt");

-- CreateIndex
CREATE INDEX "report_delivery_log_reportId_idx" ON "report_delivery_log"("reportId");

-- CreateIndex
CREATE INDEX "report_delivery_log_triggeredById_idx" ON "report_delivery_log"("triggeredById");

-- CreateIndex
CREATE INDEX "report_delivery_log_status_idx" ON "report_delivery_log"("status");

-- CreateIndex
CREATE INDEX "report_delivery_log_startedAt_idx" ON "report_delivery_log"("startedAt");

-- CreateIndex
CREATE INDEX "scheme_enrollments_userId_idx" ON "scheme_enrollments"("userId");

-- CreateIndex
CREATE INDEX "scheme_enrollments_schemeId_idx" ON "scheme_enrollments"("schemeId");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_enrollments_schemeId_userId_key" ON "scheme_enrollments"("schemeId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_enrollment_forms_schemeId_key" ON "scheme_enrollment_forms"("schemeId");

-- CreateIndex
CREATE INDEX "login_logs_userId_idx" ON "login_logs"("userId");

-- CreateIndex
CREATE INDEX "login_logs_createdAt_idx" ON "login_logs"("createdAt");

-- CreateIndex
CREATE INDEX "outlet_visibility_upload_batches_clientId_idx" ON "outlet_visibility_upload_batches"("clientId");

-- CreateIndex
CREATE INDEX "outlet_visibility_upload_batches_createdAt_idx" ON "outlet_visibility_upload_batches"("createdAt");

-- CreateIndex
CREATE INDEX "outlet_visibility_records_clientId_month_idx" ON "outlet_visibility_records"("clientId", "month");

-- CreateIndex
CREATE INDEX "outlet_visibility_records_clientId_outletCode_idx" ON "outlet_visibility_records"("clientId", "outletCode");

-- CreateIndex
CREATE UNIQUE INDEX "outlet_visibility_records_clientId_outletCode_month_key" ON "outlet_visibility_records"("clientId", "outletCode", "month");

-- CreateIndex
CREATE INDEX "outlet_visibility_audit_logs_clientId_outletCode_month_idx" ON "outlet_visibility_audit_logs"("clientId", "outletCode", "month");

-- CreateIndex
CREATE INDEX "outlet_visibility_audit_logs_uploadBatchId_idx" ON "outlet_visibility_audit_logs"("uploadBatchId");

-- CreateIndex
CREATE INDEX "sales_upload_batches_clientId_idx" ON "sales_upload_batches"("clientId");

-- CreateIndex
CREATE INDEX "sales_upload_batches_month_idx" ON "sales_upload_batches"("month");

-- CreateIndex
CREATE INDEX "sales_upload_batches_uploadedById_idx" ON "sales_upload_batches"("uploadedById");

-- CreateIndex
CREATE INDEX "outlet_sales_records_clientId_idx" ON "outlet_sales_records"("clientId");

-- CreateIndex
CREATE INDEX "outlet_sales_records_month_idx" ON "outlet_sales_records"("month");

-- CreateIndex
CREATE INDEX "outlet_sales_records_outletCode_idx" ON "outlet_sales_records"("outletCode");

-- CreateIndex
CREATE INDEX "outlet_sales_records_batchId_idx" ON "outlet_sales_records"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "outlet_sales_records_clientId_outletCode_month_key" ON "outlet_sales_records"("clientId", "outletCode", "month");

-- CreateIndex
CREATE INDEX "kpi_defs_clientId_idx" ON "kpi_defs"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_defs_clientId_code_key" ON "kpi_defs"("clientId", "code");

-- CreateIndex
CREATE INDEX "target_upload_batches_clientId_idx" ON "target_upload_batches"("clientId");

-- CreateIndex
CREATE INDEX "target_upload_batches_month_idx" ON "target_upload_batches"("month");

-- CreateIndex
CREATE INDEX "target_upload_batches_uploadedById_idx" ON "target_upload_batches"("uploadedById");

-- CreateIndex
CREATE INDEX "outlet_targets_clientId_idx" ON "outlet_targets"("clientId");

-- CreateIndex
CREATE INDEX "outlet_targets_month_idx" ON "outlet_targets"("month");

-- CreateIndex
CREATE INDEX "outlet_targets_outletCode_idx" ON "outlet_targets"("outletCode");

-- CreateIndex
CREATE INDEX "outlet_targets_batchId_idx" ON "outlet_targets"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "outlet_targets_clientId_outletCode_month_key" ON "outlet_targets"("clientId", "outletCode", "month");

-- CreateIndex
CREATE INDEX "credit_fields_clientId_idx" ON "credit_fields"("clientId");

-- CreateIndex
CREATE INDEX "credit_fields_isActive_idx" ON "credit_fields"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "credit_fields_clientId_name_key" ON "credit_fields"("clientId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "credit_batches_batchCode_key" ON "credit_batches"("batchCode");

-- CreateIndex
CREATE INDEX "credit_batches_clientId_idx" ON "credit_batches"("clientId");

-- CreateIndex
CREATE INDEX "credit_batches_period_idx" ON "credit_batches"("period");

-- CreateIndex
CREATE INDEX "credit_batches_status_idx" ON "credit_batches"("status");

-- CreateIndex
CREATE INDEX "credit_payout_entries_clientId_idx" ON "credit_payout_entries"("clientId");

-- CreateIndex
CREATE INDEX "credit_payout_entries_batchId_idx" ON "credit_payout_entries"("batchId");

-- CreateIndex
CREATE INDEX "credit_payout_entries_outletId_idx" ON "credit_payout_entries"("outletId");

-- CreateIndex
CREATE INDEX "credit_payout_entries_period_idx" ON "credit_payout_entries"("period");

-- CreateIndex
CREATE INDEX "credit_payout_entries_status_idx" ON "credit_payout_entries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "credit_payout_downloads_downloadCode_key" ON "credit_payout_downloads"("downloadCode");

-- CreateIndex
CREATE INDEX "credit_payout_downloads_clientId_idx" ON "credit_payout_downloads"("clientId");

-- CreateIndex
CREATE INDEX "credit_payout_downloads_period_idx" ON "credit_payout_downloads"("period");

-- CreateIndex
CREATE INDEX "credit_payout_downloads_status_idx" ON "credit_payout_downloads"("status");

-- CreateIndex
CREATE INDEX "credit_reversals_clientId_idx" ON "credit_reversals"("clientId");

-- CreateIndex
CREATE INDEX "credit_reversals_batchId_idx" ON "credit_reversals"("batchId");

-- CreateIndex
CREATE INDEX "credit_reversals_outletId_idx" ON "credit_reversals"("outletId");

-- CreateIndex
CREATE INDEX "credit_reversals_status_idx" ON "credit_reversals"("status");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_users" ADD CONSTRAINT "sales_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_users" ADD CONSTRAINT "sales_users_hierarchyLevelId_fkey" FOREIGN KEY ("hierarchyLevelId") REFERENCES "sales_hierarchy_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_users" ADD CONSTRAINT "sales_users_reportingToId_fkey" FOREIGN KEY ("reportingToId") REFERENCES "sales_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_user_assignments" ADD CONSTRAINT "sales_user_assignments_salesUserId_fkey" FOREIGN KEY ("salesUserId") REFERENCES "sales_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_user_assignments" ADD CONSTRAINT "sales_user_assignments_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "channel_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_user_assignments" ADD CONSTRAINT "sales_user_assignments_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_partners" ADD CONSTRAINT "channel_partners_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "channel_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_kycSubmissionId_fkey" FOREIGN KEY ("kycSubmissionId") REFERENCES "kyc_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_status_history" ADD CONSTRAINT "kyc_status_history_kycSubmissionId_fkey" FOREIGN KEY ("kycSubmissionId") REFERENCES "kyc_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_verification_items" ADD CONSTRAINT "kyc_verification_items_kycSubmissionId_fkey" FOREIGN KEY ("kycSubmissionId") REFERENCES "kyc_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_kycSubmissionId_fkey" FOREIGN KEY ("kycSubmissionId") REFERENCES "kyc_submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_type_client_configs" ADD CONSTRAINT "outlet_type_client_configs_outletTypeId_fkey" FOREIGN KEY ("outletTypeId") REFERENCES "outlet_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "channel_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_outletTypeId_fkey" FOREIGN KEY ("outletTypeId") REFERENCES "outlet_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_geo_history" ADD CONSTRAINT "outlet_geo_history_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_eligibility" ADD CONSTRAINT "scheme_eligibility_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "channel_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "schemes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_categories" ADD CONSTRAINT "reward_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "reward_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_catalog" ADD CONSTRAINT "reward_catalog_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "reward_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_orders" ADD CONSTRAINT "redemption_orders_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "channel_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_orders" ADD CONSTRAINT "redemption_orders_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "reward_catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redemption_status_history" ADD CONSTRAINT "redemption_status_history_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "redemption_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visibility_submissions" ADD CONSTRAINT "visibility_submissions_programId_fkey" FOREIGN KEY ("programId") REFERENCES "visibility_programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visibility_submissions" ADD CONSTRAINT "visibility_submissions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "channel_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visibility_submissions" ADD CONSTRAINT "visibility_submissions_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visibility_approvals" ADD CONSTRAINT "visibility_approvals_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "visibility_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visibility_fraud_log" ADD CONSTRAINT "visibility_fraud_log_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "visibility_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_transactions" ADD CONSTRAINT "payout_transactions_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "payout_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_transactions" ADD CONSTRAINT "payout_transactions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "channel_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_records" ADD CONSTRAINT "tds_records_payoutTransactionId_fkey" FOREIGN KEY ("payoutTransactionId") REFERENCES "payout_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_configId_fkey" FOREIGN KEY ("configId") REFERENCES "leaderboard_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_entries" ADD CONSTRAINT "leaderboard_entries_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "leaderboard_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_entries" ADD CONSTRAINT "leaderboard_entries_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "channel_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_status_history" ADD CONSTRAINT "ticket_status_history_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_queue" ADD CONSTRAINT "notification_queue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_queue" ADD CONSTRAINT "notification_queue_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "notification_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_delivery_log" ADD CONSTRAINT "notification_delivery_log_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "notification_queue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_delivery_log" ADD CONSTRAINT "report_delivery_log_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "scheduled_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_delivery_log" ADD CONSTRAINT "report_delivery_log_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_enrollments" ADD CONSTRAINT "scheme_enrollments_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_enrollments" ADD CONSTRAINT "scheme_enrollments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_enrollment_forms" ADD CONSTRAINT "scheme_enrollment_forms_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_logs" ADD CONSTRAINT "login_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_visibility_records" ADD CONSTRAINT "outlet_visibility_records_uploadBatchId_fkey" FOREIGN KEY ("uploadBatchId") REFERENCES "outlet_visibility_upload_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_visibility_audit_logs" ADD CONSTRAINT "outlet_visibility_audit_logs_uploadBatchId_fkey" FOREIGN KEY ("uploadBatchId") REFERENCES "outlet_visibility_upload_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_sales_records" ADD CONSTRAINT "outlet_sales_records_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "sales_upload_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_targets" ADD CONSTRAINT "outlet_targets_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "target_upload_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_payout_entries" ADD CONSTRAINT "credit_payout_entries_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "credit_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_payout_entries" ADD CONSTRAINT "credit_payout_entries_downloadId_fkey" FOREIGN KEY ("downloadId") REFERENCES "credit_payout_downloads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reversals" ADD CONSTRAINT "credit_reversals_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "credit_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Partial UNIQUE indexes that Prisma cannot model (recovered from
-- migrations-manual/P6_tds_foundation.sql). TDS re-upload dedup: a batch id is
-- unique per tenant, only when supplied. The TDS upload service relies on the
-- resulting P2002 to reject duplicate batch re-uploads; without these, duplicate
-- TDS rows inflate PAN/FY liability totals (money/compliance path). The squash
-- (migrate diff --from-empty) cannot emit partial indexes, so they live here.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "tds_off_platform_entries_client_batch_key"
  ON "tds_off_platform_entries" ("clientId", "uploadBatchId") WHERE "uploadBatchId" IS NOT NULL;
CREATE UNIQUE INDEX "tds_deposits_client_section_batch_key"
  ON "tds_deposits" ("clientId", "section", "uploadBatchId") WHERE "uploadBatchId" IS NOT NULL;

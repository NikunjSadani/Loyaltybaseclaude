# Product Requirements Document — Addendum
## Enterprise Trade Loyalty Platform
### Deoleo India Pvt. Ltd. | Built by Gifsy
### Sections 31–37 | May 2026

---

## 31. Channel Partner Types, Outlet Tiers & Incentive Configuration

### 31.1 Channel Partner Classes

The platform shall support exactly three channel partner classes. Each class is a distinct entity type with independent onboarding flows, incentive logic, approval workflows, and reporting dimensions.

| Class Code | Class Name     | Description                                                                 |
|------------|----------------|-----------------------------------------------------------------------------|
| CP-01      | Retailer       | Point-of-sale outlets that stock and sell Deoleo products to end consumers  |
| CP-02      | Wholesaler     | Intermediaries that purchase in bulk and redistribute to retailers           |
| CP-03      | Sub-stockist   | Regional distribution agents operating below the primary stockist level      |

### 31.2 Configurable Tier Framework

Each channel partner class shall support a configurable, multi-level tier structure. The tier framework shall operate as follows:

- **Tier Count:** The number of tiers within each class is configurable by the Master Admin (Gifsy) from the Admin Portal. There is no system-imposed minimum or maximum number of tiers.
- **Tier Names:** Tier names are fully configurable. No default naming convention (e.g., Silver, Gold, Platinum) is enforced by the platform. Names shall be defined by the Master Admin at the time of program setup and may be updated for future program cycles.
- **Tier Assignment:** Each registered channel partner is assigned a tier within their class at onboarding or upon first qualifying purchase, as configured by the Master Admin.
- **Tier Upgrade Criteria:** The conditions under which a channel partner is promoted to a higher tier (e.g., cumulative purchase value, volume of SKUs, scheme achievement percentage) shall be fully configurable per class.
- **Tier Downgrade Criteria:** The conditions under which a channel partner is demoted to a lower tier shall be independently configurable per class. Downgrade rules shall support period-based review cycles (e.g., quarterly reassessment).
- **Tier Review Period:** The frequency of tier reassessment (monthly, quarterly, annually, or program-end) shall be configurable per class.

All tier configuration changes made by the Master Admin shall be version-controlled with a change log (modified by, timestamp, previous value, new value).

### 31.3 Independent Incentive Logic per Channel Partner Class

Each channel partner class shall have a fully independent incentive configuration, maintained separately in the Admin Portal. Incentive parameters for one class shall have no dependency on or inheritance from another class.

The following incentive parameters shall be independently configurable per class:

| Parameter                    | Description                                                                                                   |
|------------------------------|---------------------------------------------------------------------------------------------------------------|
| Incentive Types Enabled      | Which incentive types are available for the class (e.g., purchase-based, visibility, referral, secondary sales) |
| Calculation Method           | Flat amount, slab-based, percentage of purchase value, per-unit rate, or hybrid combinations                   |
| Payout Cap                   | Maximum incentive amount payable to a partner in a defined period; configurable as absolute value or percentage |
| Overachievement Slabs        | Additional incentive tiers applicable when a partner exceeds the primary scheme target                         |
| Holding Period               | Duration for which earned points remain in a locked state before becoming redeemable (see Section 31.5)        |
| Points Conversion Rate       | Rate at which earned points are converted to cash or reward value (see Section 31.4)                           |
| Reward Catalog Visibility    | Which reward catalog categories and items are visible and redeemable by partners in this class                 |
| Scheme Eligibility           | Which schemes a partner in this class is eligible to participate in                                            |

### 31.4 Tier-Differentiated Incentive Parameters

Within each channel partner class, individual tiers may carry differentiated incentive parameters. The following parameters shall be overridable at the tier level:

- Calculation method and slab definitions
- Payout cap (absolute or percentage)
- Points conversion rate
- Reward catalog visibility scope
- Overachievement slab thresholds and rates

Where a tier-level override is not configured, the class-level default shall apply. The Admin Portal shall clearly display the effective parameter for each tier (inherited vs. overridden).

### 31.5 Points-to-Cash Conversion Rate

- The points-to-cash conversion rate shall be configurable per channel partner class from the Master Admin Portal.
- Optionally, the rate may be further differentiated at the tier level within a class.
- Conversion rates shall be versioned. Any change to the conversion rate shall be effective from a configurable future date and shall not retroactively alter the value of points already credited.
- The effective conversion rate applicable to a partner at the time of redemption shall be the rate associated with their current class and tier.

### 31.6 Holding Period Configuration

- The holding period — the duration after which locked (credited but unredeemable) points become available for redemption — shall be configurable per scheme, per channel partner class.
- Holding periods are defined in calendar days or working days, as configured per scheme.
- A single scheme may carry different holding periods for different channel partner classes.
- Points subject to a holding period shall be displayed to the channel partner as "Locked Points" with the earliest unlock date shown.
- Upon expiry of the holding period, locked points shall automatically transition to redeemable status. No manual intervention shall be required for this transition.

---

## 32. Fund Management & Reconciliation

### 32.1 Overview

The platform shall maintain a dedicated program fund ledger to track all financial inflows from the client (Deoleo India Pvt. Ltd.) and all outflows arising from incentive payouts and fulfillment activities. The fund management module shall be accessible to Gifsy Admin and Client Admin roles with role-appropriate read/write permissions.

### 32.2 Fund Ledger Structure

The fund ledger shall track the following balances on a continuous basis:

| Ledger Line Item             | Description                                                                                          |
|------------------------------|------------------------------------------------------------------------------------------------------|
| Opening Balance              | Fund balance at the start of the reporting period                                                    |
| Funds Received               | Total payments received from Deoleo India Pvt. Ltd. into the program fund during the period          |
| Funds Utilised               | Total outflows from the program fund during the period, broken down by payout mode (see Section 32.3)|
| Closing Balance              | Opening Balance + Funds Received − Funds Utilised                                                    |
| Pending Liability            | Value of approved incentives that have been sanctioned but not yet disbursed to channel partners      |
| Available Balance            | Closing Balance − Pending Liability                                                                   |
| Reconciliation Variance      | Any unexplained difference between system-computed balance and actual fund position, if applicable    |

### 32.3 Payout Mode Breakdown

Funds Utilised shall be disaggregated by the following payout modes within the reconciliation statement:

| Payout Mode Code | Payout Mode Description                                                                 |
|------------------|-----------------------------------------------------------------------------------------|
| PM-01            | Amazon / Gift Card Redemptions — value of gift cards or Amazon vouchers issued          |
| PM-02            | Direct Bank Transfer (UPI) — incentive amounts transferred via UPI to channel partners  |
| PM-03            | Direct Bank Transfer (NEFT / IMPS) — incentive amounts transferred via NEFT or IMPS    |
| PM-04            | Physical Gift Fulfillment — procurement and courier cost of physical reward items       |

Each disbursement transaction in the system shall be tagged to one of the above payout mode codes at the time of processing.

### 32.4 Fund Reconciliation Report

A fund reconciliation report shall be available to Gifsy Admin and Client Admin. The report shall support the following filters:

- Reporting period (custom date range, monthly, quarterly)
- Payout mode
- Channel partner class

The report shall present the ledger line items defined in Section 32.2, with a drill-down capability into individual transactions contributing to each line item.

The reconciliation report shall be exportable in Microsoft Excel (.xlsx) format in accordance with Section 37.

### 32.5 Low-Balance Alert

- A configurable minimum fund balance threshold shall be defined in the Admin Portal by the Gifsy Admin.
- When the Available Balance (as defined in Section 32.2) falls below the configured threshold, an automated alert shall be triggered.
- Alert recipients shall include Gifsy Admin and designated Client Admin users.
- Alert delivery channel: in-platform notification and email.
- The alert shall include the current available balance, the configured threshold, and the total pending liability at the time of the alert.

### 32.6 Payment Receipt Recording

- All payments received from Deoleo India Pvt. Ltd. shall be recorded in the system by the Gifsy Admin with the following mandatory fields: payment date, amount, reference number (UTR/NEFT reference), and a remarks field.
- Payment receipts shall be available for download by Client Admin for internal reconciliation.

---

## 33. KYC SLA Tracking & Gifsy KPI Dashboard

### 33.1 Overview

A dedicated KPI monitoring dashboard shall be built for Gifsy operational users to track platform health, operational compliance, and SLA adherence. KYC turnaround time shall be treated as a primary operational KPI and shall be monitored in real time.

### 33.2 KYC SLA Definition

| SLA Parameter         | Default Value                     | Configurable |
|-----------------------|-----------------------------------|--------------|
| SLA Target            | 48 working hours from submission  | Yes          |
| SLA Review Unit       | Working hours                     | Yes          |
| SLA Measurement Start | Timestamp of KYC document submission by channel partner | No |
| SLA Measurement End   | Timestamp of approval or rejection action by Gifsy KYC reviewer | No |

The SLA target shall be configurable by the Master Admin from the Admin Portal. Changes to the SLA target shall apply to new submissions from the effective date and shall not retroactively alter the SLA status of existing pending submissions.

### 33.3 KYC SLA Metrics

The following KYC SLA metrics shall be tracked and displayed on the Gifsy KPI Dashboard:

| Metric                        | Definition                                                                                               |
|-------------------------------|----------------------------------------------------------------------------------------------------------|
| Average KYC Approval Time     | Mean time (in working hours) between KYC submission and final approval action, for the selected period   |
| SLA Compliance Rate           | Percentage of KYC submissions approved or rejected within the configured SLA target                      |
| SLA Breach Count              | Number of submissions where the SLA target was exceeded; filterable by state, sales user, and period     |
| Pending KYC Aging             | Count of pending KYC submissions segmented by aging bucket: 0–24 hrs, 24–48 hrs, 48+ hrs               |
| Rejection Rate                | Percentage of KYC submissions rejected, segmented by rejection reason code                               |
| Re-upload Rate                | Percentage of KYC submissions that required at least one document re-upload by the channel partner       |

### 33.4 KPI Dashboard — Display Requirements

- KPI cards for each metric defined in Section 33.3 shall be displayed on the Gifsy Admin dashboard as persistent, above-the-fold cards.
- Each KPI card shall display: current value, trend indicator (vs. prior period), and target (where applicable).
- Submissions that have breached the configured SLA target shall be highlighted in red within all relevant dashboard views, reports, and pending queues.
- Filters available on the dashboard: date range, state, sales user (DSE/ASM), channel partner class.

### 33.5 Weekly KPI Summary Report

- An automated weekly KPI summary report shall be generated every Monday for the preceding calendar week.
- The report shall cover all metrics defined in Section 33.3, plus any additional KPIs surfaced on the Gifsy Admin dashboard.
- Distribution: delivered via email to configured Gifsy Admin recipients in Microsoft Excel (.xlsx) format.
- The report generation schedule and recipient list shall be configurable by the Master Admin.

### 33.6 SLA Breach Escalation

- Submissions that have been pending for more than the configured SLA target without action shall trigger an escalation notification to the designated Gifsy KYC team lead.
- A secondary escalation shall be triggered if the submission remains unresolved for 2× the SLA target duration.
- Escalation recipients and thresholds shall be configurable from the Admin Portal.

---

## 34. TDS Compliance

### 34.1 Regulatory Scope

The platform shall be designed to support compliance with the following Income Tax Act provisions applicable to the program:

| Section | Applicability                                                                                          |
|---------|--------------------------------------------------------------------------------------------------------|
| 194R    | TDS on incentives, benefits, and perquisites provided to channel partners (Retailers, Wholesalers, Sub-stockists) |
| 194C    | TDS on payments made to channel partners or third parties for visibility execution services             |

Detailed rate structures, threshold values, aggregate limit definitions, and computation rules shall be governed by a separate TDS Policy document to be provided by Deoleo India Pvt. Ltd. The TDS Policy document shall be incorporated into this PRD by reference upon receipt. The platform shall be configurable to implement the rules specified in that document without requiring a code change, to the extent that rate and threshold parameters are admin-configurable.

### 34.2 TDS Deduction Logic

- The platform shall automatically calculate applicable TDS before initiating any payout disbursement.
- TDS deduction shall be triggered at the time of payout processing, not at the time of points credit.
- The net payout amount disbursed to the channel partner shall be the gross incentive amount minus the applicable TDS amount.
- TDS deduction shall be applied per PAN. The system shall aggregate incentive values across all payouts to the same PAN within the applicable financial year for threshold comparison purposes.
- Where a channel partner's PAN is not available (pending KYC), TDS shall be deducted at the higher rate applicable under the Income Tax Act for PAN-not-furnished cases. Payouts shall not be blocked solely on account of pending PAN verification; however, higher TDS rates shall apply.

### 34.3 TDS Computation Reports

The platform shall generate the following TDS-related reports:

| Report Name                        | Description                                                                                         | Available To              |
|------------------------------------|-----------------------------------------------------------------------------------------------------|---------------------------|
| TDS Computation Report — by PAN    | Gross payout, TDS rate applied, TDS amount deducted, and net payout, aggregated per PAN             | Gifsy Admin, Client Admin |
| TDS Computation Report — by Period | All TDS deductions made within a selected date range, filterable by payout type and section         | Gifsy Admin, Client Admin |
| 194R Incentive Report              | Detailed report of all benefits/incentives subject to Section 194R, per recipient PAN               | Client Admin              |
| 194C Payment Report                | Detailed report of all payments subject to Section 194C, including service description and PAN      | Gifsy Operations          |

### 34.4 TDS Liability Ledger

- The platform shall maintain a running TDS liability ledger tracking:
  - Total TDS deducted (by section, by period)
  - TDS amounts remitted to government (to be updated manually by Gifsy Finance)
  - Outstanding TDS liability (deducted but not yet remitted)
- The ledger shall be accessible to Gifsy Admin only.

### 34.5 TDS Data Export for Filing

- The platform shall support export of TDS computation data in Microsoft Excel (.xlsx) format, structured to facilitate quarterly TDS return preparation (Form 26Q / Form 27Q as applicable).
- Exported data fields shall include: PAN, name, gross payment amount, TDS section, TDS rate, TDS amount, payment date, and challan reference (to be entered manually post-remittance).

---

## 35. DPDP Act 2023 Compliance

### 35.1 Overview

The platform shall be designed, developed, and operated in full compliance with India's Digital Personal Data Protection Act, 2023 (DPDP Act) and any rules notified thereunder. Gifsy, as the Data Fiduciary for the purposes of this platform, shall implement appropriate technical and organisational measures to protect the personal data of all channel partners (Data Principals) enrolled in the program.

### 35.2 Consent Management

- **Explicit Consent at Onboarding:** Informed, explicit consent shall be obtained from every channel partner before any personal data is collected or processed. Consent shall be presented in clear, plain language. Consent collection shall be a mandatory step in the onboarding flow; the registration cannot be completed without consent.
- **Consent Record:** Each consent action shall be recorded with the following attributes:

  | Attribute         | Description                                              |
  |-------------------|----------------------------------------------------------|
  | Timestamp         | Date and time of consent action (UTC + IST)              |
  | IP Address        | IP address from which the consent was submitted          |
  | Method of Capture | Channel through which consent was recorded (e.g., mobile app, web portal, assisted onboarding via sales user) |
  | Consent Version   | Version identifier of the consent notice presented       |
  | Data Principal ID | Internal identifier of the consenting channel partner    |

- **Consent Withdrawal:** A mechanism for channel partners to withdraw consent shall be available within the platform (mobile app and web portal). Upon withdrawal, the platform shall cease processing personal data for program participation purposes, subject to overriding legal obligations for data that must be retained (see Section 35.5).
- **Re-consent:** If the consent notice is materially updated, re-consent shall be sought from existing channel partners before the updated notice takes effect.

### 35.3 Data Principal Rights

The platform shall support the following rights for channel partners as Data Principals, exercisable through a self-service workflow within the app or through the support module:

| Right                     | Platform Implementation                                                                                              |
|---------------------------|----------------------------------------------------------------------------------------------------------------------|
| Right to Access           | Channel partner can view all personal data held about them in the platform, downloadable in .xlsx format             |
| Right to Correction       | Channel partner can raise a correction request for inaccurate or outdated personal data; routed to Gifsy KYC review  |
| Right to Erasure          | Channel partner can request deletion of personal data; processed subject to legal and compliance hold obligations    |
| Right to Grievance Redressal | A named Data Protection Officer (DPO) contact or grievance mechanism shall be accessible within the platform      |

- All data requests shall be logged with a unique request ID, submission timestamp, type of request, current status, and resolution timestamp.
- A data request workflow shall be built into the support module, accessible to channel partners and actionable by Gifsy Admin.
- Target resolution time for data requests: 30 days from submission, as per the DPDP Act.

### 35.4 Data Minimisation

- The platform shall collect only personal data that is necessary for the following defined purposes: KYC verification, incentive payout processing, and program participation.
- Collection of data fields beyond those required for the above purposes shall require explicit justification and Master Admin approval before implementation.
- The following categories of sensitive personal data shall be encrypted both at rest and in transit using industry-standard encryption (AES-256 at rest; TLS 1.2 or higher in transit):

  | Data Category          | Example Fields                          |
  |------------------------|-----------------------------------------|
  | Tax Identification     | PAN number                              |
  | Financial Account Data | Bank account number, IFSC code, UPI ID  |
  | Identity Documents     | Aadhaar number (if collected), GST number |
  | KYC Document Images    | Uploaded document scans/photographs     |

### 35.5 Data Retention

Personal data shall be retained only for the period necessary for the purpose for which it was collected. The following retention schedules shall apply:

| Data Category                      | Retention Period                                               | Basis                                    |
|------------------------------------|----------------------------------------------------------------|------------------------------------------|
| Financial and audit records        | 7 years from transaction date                                  | Section 21.3 of this PRD; Companies Act  |
| KYC documents                      | As per RBI / PMLA guidelines (currently 5 years from relationship end) | PMLA 2002 and RBI KYC Master Directions |
| Consent records                    | Duration of program + 3 years                                  | DPDP Act compliance                      |
| TDS records                        | 7 years from the end of relevant financial year                | Income Tax Act                           |
| Inactive channel partner data      | To be reviewed for deletion after program end date             | DPDP Act — purpose limitation            |
| Communication logs (SMS/WhatsApp)  | 1 year from date of communication                              | Operational requirement                  |

A semi-annual data retention review shall be conducted by Gifsy to identify and delete personal data that has exceeded its retention period, subject to applicable legal holds.

### 35.6 Data Processing Agreement

- A Data Processing Agreement (DPA) shall be executed between Gifsy (as Data Fiduciary) and Deoleo India Pvt. Ltd. (as Client) prior to platform go-live.
- All sub-processors engaged by Gifsy that handle personal data of channel partners — including but not limited to SMS gateway providers, WhatsApp Business API providers, courier and fulfillment APIs, and payment gateway providers — shall be bound by a sub-processor agreement incorporating equivalent data protection obligations.
- A register of sub-processors shall be maintained by Gifsy and made available to Deoleo India Pvt. Ltd. upon request.

### 35.7 Data Breach Response

- In the event of a confirmed personal data breach, Gifsy shall notify:
  - Affected Data Principals (channel partners) without undue delay
  - The Data Protection Board of India within 72 hours of becoming aware of the breach, as required by the DPDP Act
- The platform shall maintain comprehensive logs of all personal data access and export events to support breach investigation and traceability. Logs shall include: user identity, action performed, data fields accessed, timestamp, and source IP.
- A documented Incident Response Procedure for data breaches shall be maintained by Gifsy and reviewed annually.

---

## 36. Visibility Duplicate Detection

### 36.1 Overview

The platform shall implement an automated duplicate detection framework for all visibility execution image uploads. Detection shall execute at the time of upload, prior to submission entering the approval queue, without requiring manual reviewer intervention. Submissions identified as probable duplicates shall be held from payout eligibility pending review.

### 36.2 Detection Methods

Four independent detection mechanisms shall be implemented. All four shall run in parallel on each new upload. A submission need only trigger one mechanism to be flagged.

#### 36.2.1 Perceptual Hash Comparison

- At the time of upload, a perceptual hash (pHash) of the submitted image shall be computed by the platform.
- The computed pHash shall be compared against the pHash database of all previously approved and all currently pending visibility submissions for the same outlet.
- If the similarity score between the new image and any existing image exceeds a configurable threshold, the submission shall be flagged as a suspected duplicate.
- The similarity threshold shall be configurable by the Master Admin (expressed as a percentage similarity score; default: 90%).

#### 36.2.2 Geo-Proximity Check

- The geo-coordinates captured at the time of upload shall be compared against coordinates of all previously approved visibility submissions for the same outlet and the same visibility type.
- If the new upload's coordinates fall within a configurable radius of a prior approved submission, and the prior submission was made within a configurable time window, the new upload shall be flagged for review.

  | Parameter               | Default Value | Configurable |
  |-------------------------|---------------|--------------|
  | Proximity Radius        | 50 metres     | Yes          |
  | Lookback Time Window    | 30 days       | Yes          |

#### 36.2.3 EXIF Timestamp Metadata Validation

- The EXIF metadata embedded in the uploaded image shall be extracted and validated.
- The EXIF-recorded capture timestamp shall be compared against:
  - The upload timestamp (the two must fall within a configurable acceptable window)
  - The current active scheme period start date
- Images where the EXIF timestamp predates the current scheme period start date shall be **automatically rejected** (not merely flagged) and shall not enter the approval queue.
- Images where EXIF metadata is absent or has been stripped shall be flagged for manual review.
- The acceptable window between EXIF timestamp and upload timestamp shall be configurable (default: 24 hours).

#### 36.2.4 Repeated Submission Detection (Exact Hash Match)

- An exact cryptographic hash (SHA-256) of each uploaded image file shall be computed and stored at the time of upload.
- If the SHA-256 hash of a new upload matches that of any previously uploaded image — regardless of outlet, uploader identity, or scheme — the submission shall be **automatically rejected**.
- The rejection shall be logged as a fraud attempt in the system with the following attributes: uploading user, outlet code, timestamp, matched original upload reference.

### 36.3 Flagging & Disposition Rules

| Trigger                             | Disposition         | Payout Eligibility            | Fraud Log | Notification                  |
|-------------------------------------|---------------------|-------------------------------|-----------|-------------------------------|
| Perceptual hash match (above threshold) | Suspected Duplicate | Suspended pending manual review | Yes    | Gifsy Admin notified          |
| Geo-proximity match                 | Suspected Duplicate | Suspended pending manual review | Yes    | Gifsy Admin notified          |
| EXIF timestamp pre-scheme-period    | Auto-Rejected       | Not eligible                  | Yes       | Upload user notified          |
| EXIF metadata absent                | Flagged for Review  | Suspended pending manual review | No     | Gifsy Admin notified          |
| Exact SHA-256 hash match            | Auto-Rejected       | Not eligible                  | Yes       | Gifsy Admin notified; upload user notified |

### 36.4 Fraud Log & Reviewer Queue

- All flagged and auto-rejected submissions shall be recorded in a Visibility Fraud Log, accessible to Gifsy Admin.
- The Fraud Log shall display: submission ID, outlet code, uploading user, detection method triggered, flag timestamp, current status, and reviewer action (if any).
- Gifsy Admin shall be able to override a "Suspected Duplicate" flag and approve or reject the submission with a mandatory remarks entry.
- A cumulative fraud flag count shall be maintained per sales user. Exceeding a configurable threshold of fraud flags shall trigger an escalation notification to the Gifsy Admin for further action.

---

## 37. Report Export Format

### 37.1 Standardised Export Format

All reports generated across all modules of the platform — including but not limited to Operational, Business, Finance, Engagement, Scheme Performance, KPI, TDS, Reconciliation, and Compliance reports — shall be exported exclusively in Microsoft Excel (.xlsx) format.

### 37.2 Scheduled Report Delivery

All scheduled and automated reports (including the weekly KPI summary defined in Section 33.5 and any other time-triggered reports) shall be delivered via email as Microsoft Excel (.xlsx) file attachments.

### 37.3 Format Scope Exclusions

The following export formats are explicitly **out of scope** for the current program:

| Format | Status      |
|--------|-------------|
| PDF    | Out of scope |
| CSV    | Out of scope |
| XML    | Out of scope |
| JSON   | Out of scope |

No request for export in any format other than .xlsx shall be fulfilled by the platform in the current scope. Any future requirement for additional export formats shall be treated as a change request and subject to the change management process defined in Section 30 of this PRD.

### 37.4 Excel File Standards

- All .xlsx exports shall be formatted for readability: column headers in the first row, data starting from the second row, with auto-fitted column widths where technically feasible.
- Reports containing monetary values shall format currency columns to two decimal places.
- Date fields shall be formatted as DD-MM-YYYY.
- Each exported file shall include a header section (first three rows or a dedicated "Report Info" sheet) containing: report name, generated by (user name and role), generation timestamp, and filter parameters applied.

---

*End of Sections 31–37*

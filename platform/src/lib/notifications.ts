// Notification service stub - replace with actual SMS/WhatsApp/email provider
export type NotificationChannel = 'SMS' | 'WHATSAPP' | 'EMAIL'

export type NotificationType =
  | 'OTP'
  | 'KYC_APPROVED'
  | 'KYC_REJECTED'
  | 'REDEMPTION_CONFIRMED'
  | 'PAYOUT_PROCESSED'
  | 'VISIBILITY_APPROVED'
  | 'VISIBILITY_REJECTED'
  | 'TICKET_UPDATE'
  | 'GENERIC'

interface SendOtpParams {
  mobile: string
  otp: string
  channel: NotificationChannel
}

interface SendNotificationParams {
  mobile?: string
  email?: string
  type: NotificationType
  data?: Record<string, any>
}

export async function sendOtp({ mobile, otp, channel }: SendOtpParams): Promise<boolean> {
  // TODO: integrate actual SMS/WhatsApp provider (e.g., Twilio, Gupshup)
  console.log(`[NOTIFICATION] Sending OTP ${otp} to ${mobile} via ${channel}`)
  return true
}

export async function sendNotification({ mobile, email, type, data }: SendNotificationParams): Promise<boolean> {
  // TODO: integrate actual notification provider
  console.log(`[NOTIFICATION] Sending ${type} to ${mobile ?? email}`, data)
  return true
}

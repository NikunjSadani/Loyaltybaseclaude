import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/auth'
import { CLIENT_REGISTRY } from '@/lib/platform/client-registry'

const ok  = (data: any, status = 200) => NextResponse.json({ success: true,  data  }, { status })
const err = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status })

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req)
    if (!authUser) return err('Unauthorized', 401)
    if (authUser.role !== 'GIFSY_ADMIN') return err('Forbidden', 403)

    const clients = Object.entries(CLIENT_REGISTRY).map(([id, config]) => ({
      id,
      slug:              config.slug,
      internalName:      config.internalName,
      status:            config.status,
      onboardedAt:       config.onboardedAt,
      displayName:       config.branding.displayName,
      primaryColor:      config.branding.primaryColor,
      logoUrl:           config.branding.logoUrl,
      supportEmail:      config.branding.supportEmail,
      productBrands:     config.branding.productBrands,
      partnerClassCount: config.partnerClasses.length,
      features: {
        visibilityInvoiceModule: config.features.visibilityInvoiceModule,
        kycApprovalFlow:         config.features.kycApprovalFlow,
        walletModule:            config.features.walletModule,
        salesTeamApp:            config.features.salesTeamApp,
        referralModule:          config.features.referralModule,
      },
    }))

    return ok({ clients })
  } catch (e: any) {
    console.error('[gifsy/clients GET]', e)
    return err('Failed to fetch clients', 500)
  }
}

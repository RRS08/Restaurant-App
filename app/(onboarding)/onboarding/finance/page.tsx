// Finance / bank sync — last onboarding step. Encouraged, skippable.

import { redirect } from 'next/navigation'
import { getOnboardingContext } from '@/app/actions/onboarding'
import { isPlaidConfigured } from '@/lib/plaid/client'
import FinanceStepClient from './client'

export default async function OnboardingFinancePage() {
  const ctx = await getOnboardingContext()
  if (!ctx.ok) redirect('/onboarding')

  const plaidConfigured = isPlaidConfigured()
  const postPath = ctx.operatingMode === 'external_pos' ? '/settings' : '/menu'

  return <FinanceStepClient plaidConfigured={plaidConfigured} postPath={postPath} opMode={ctx.operatingMode ?? 'native_pos'} />
}

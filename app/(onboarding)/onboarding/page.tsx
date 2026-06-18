import OnboardingWizard from './wizard'
import { getLang } from '@/lib/i18n-server'

export default async function OnboardingPage() {
  const lang = await getLang()
  return <OnboardingWizard lang={lang} />
}

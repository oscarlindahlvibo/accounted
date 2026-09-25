/**
 * BolagsverketService: the single entry point for the rest of Accounted.
 * See docs/integrations/bolagsverket.md for the full integration writeup.
 */
export { isBolagsverketConfigured, getBolagsverketConfig, BolagsverketConfigError } from './env'
export { getBolagsverketAccessToken } from './token'
export { bolagsverketRequest, BolagsverketApiError, type BolagsverketErrorCode } from './client'
export {
  getBolagsverketOrganisation,
  lookupCompanyViaBolagsverket,
  mapBolagsverketToCompanyLookupResult,
} from './organisation'
export {
  getBolagsverketAnnualReports,
  getBolagsverketAnnualReportDocument,
  type BolagsverketAnnualReport,
  type BolagsverketAnnualReportDocument,
} from './annual-reports'
export { testBolagsverketConnection, type BolagsverketConnectionCheck } from './test-connection'

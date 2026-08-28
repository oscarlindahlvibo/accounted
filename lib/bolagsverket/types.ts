/**
 * Types mirroring Bolagsverket's VärdefullaDatamängder v1 OpenAPI spec
 * exactly (fetched 2026-08-27 from the acceptance devportal's own published
 * swagger.json — not guessed). Field names are the real API field names in
 * Swedish; only fields that actually exist in the spec are modeled here.
 *
 * Every data field on `Organisation` can carry an optional `fel` (the
 * source failed to answer for just that field) and `dataproducent`
 * ('Bolagsverket' | 'SCB'): callers must check `fel` before trusting a
 * field, not assume presence.
 */

export interface BvFel {
  typ: 'ORGANISATION_FINNS_EJ' | 'OGILTIG_BEGARAN' | 'OTILLGANGLIG_UPPGIFTSKALLA' | 'TIMEOUT' | string
  felBeskrivning?: string
}

export type BvDataproducent = 'Bolagsverket' | 'SCB'

export interface BvKodKlartext {
  kod: string
  klartext: string
}

export interface BvIdentitetsbeteckning {
  identitetsbeteckning: string
  typ: BvKodKlartext
}

export interface BvPostadress {
  postnummer: string
  utdelningsadress?: string
  postort?: string
  coAdress?: string
  land?: string
}

export interface BvPostadressOrganisation {
  postadress: BvPostadress
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvOrganisationsnamnObjekt {
  namn: string
  registreringsdatum?: string
  organisationsnamntyp?: BvKodKlartext
  verksamhetsbeskrivningSarskiltForetagsnamn?: string
}

export interface BvOrganisationsnamn {
  organisationsnamnLista?: BvOrganisationsnamnObjekt[]
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvOrganisationsform {
  kod: string
  klartext: string
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvJuridiskForm {
  kod: string
  klartext: string
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvVerksamOrganisation {
  kod: 'JA' | 'NEJ'
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvReklamsparr {
  kod: 'JA' | 'NEJ'
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvAvregistreradOrganisation {
  avregistreringsdatum?: string
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvAvregistreringsorsak {
  kod: string
  klartext: string
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvPagaendeForfarandeObjekt {
  kod: string
  klartext: string
  fromDatum?: string
}

export interface BvPagaendeAvvecklingsEllerOmstruktureringsforfarande {
  pagaendeAvvecklingsEllerOmstruktureringsforfarandeLista?: BvPagaendeForfarandeObjekt[]
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvOrganisationsdatum {
  registreringsdatum: string
  infortHosScb?: string
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvVerksamhetsbeskrivning {
  beskrivning: string
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvNaringsgrenOrganisation {
  sni: BvKodKlartext[]
  dataproducent?: BvDataproducent
  fel?: BvFel
}

export interface BvOrganisation {
  organisationsidentitet?: BvIdentitetsbeteckning
  namnskyddslopnummer?: number
  organisationsnamn?: BvOrganisationsnamn
  registreringsland?: BvKodKlartext
  reklamsparr?: BvReklamsparr
  organisationsform?: BvOrganisationsform
  avregistreradOrganisation?: BvAvregistreradOrganisation
  avregistreringsorsak?: BvAvregistreringsorsak
  pagaendeAvvecklingsEllerOmstruktureringsforfarande?: BvPagaendeAvvecklingsEllerOmstruktureringsforfarande
  juridiskForm?: BvJuridiskForm
  verksamOrganisation?: BvVerksamOrganisation
  organisationsdatum?: BvOrganisationsdatum
  verksamhetsbeskrivning?: BvVerksamhetsbeskrivning
  naringsgrenOrganisation?: BvNaringsgrenOrganisation
  postadressOrganisation?: BvPostadressOrganisation
}

export interface BvOrganisationerSvar {
  organisationer?: BvOrganisation[]
}

/** RFC 7807 error envelope Bolagsverket returns on 400/401/403/404/500. */
export interface BvApiError {
  type: string
  instance: string
  status: number
  title: string
  detail?: string
  timestamp?: string
  requestId?: string
}

export interface BvDokumentlistaItem {
  dokumentId: string
  filformat: string
  rapporteringsperiodTom?: string
  registreringstidpunkt?: string
}

export interface BvDokumentlistaSvar {
  dokument?: BvDokumentlistaItem[]
}

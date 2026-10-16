/** A content revision and its current process generation are different identities. */
export interface SourceRuntimeRevision {
  apiId: string
  providerId: string
  providerVersion?: string
  generation: number
}
export type SourceChangeEvent = ({kind:'runtime';phase:'invalidated'|'ready'} & SourceRuntimeRevision) | {kind:'metadata'}

export type BuildMetadata = {
  panelVersion: string
  buildSha: string
  apiContractVersion: number
}

export function compiledBuildMetadata(): BuildMetadata {
  return {
    panelVersion: typeof __PANEL_VERSION__ !== 'undefined' ? __PANEL_VERSION__ : '0.0.0',
    buildSha: typeof __PANEL_BUILD_SHA__ !== 'undefined' ? __PANEL_BUILD_SHA__ : 'unknown',
    apiContractVersion:
      typeof __PANEL_API_CONTRACT_VERSION__ !== 'undefined'
        ? __PANEL_API_CONTRACT_VERSION__
        : 1,
  }
}

export function assessBuildCompatibility(
  frontend: BuildMetadata,
  backend: Partial<BuildMetadata>,
) {
  const compatible =
    backend.panelVersion === frontend.panelVersion &&
    backend.buildSha === frontend.buildSha &&
    backend.apiContractVersion === frontend.apiContractVersion
  return compatible
    ? { compatible: true as const }
    : {
        compatible: false as const,
        code: 'version_mismatch' as const,
        reason: 'The frontend and backend were built from different panel versions.',
      }
}

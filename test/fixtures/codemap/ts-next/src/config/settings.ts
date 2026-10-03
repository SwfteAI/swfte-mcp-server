// Runtime settings loaded once at boot from the settings service (values are not in the repo).
export interface Settings {
  publicAgentId: string;
  embedKey: string;
  locale: string;
}

export const settings: Settings = {
  publicAgentId: '',
  embedKey: '',
  locale: 'en',
};

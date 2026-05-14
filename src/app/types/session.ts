// Reflects the Playwright StorageState shape used for session persistence.
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface PlaywrightOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
  origins: PlaywrightOrigin[];
}

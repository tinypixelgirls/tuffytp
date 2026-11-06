import type { YtpApi } from '../shared/types';

declare global {
  interface Window {
    ytp: YtpApi;
  }
}

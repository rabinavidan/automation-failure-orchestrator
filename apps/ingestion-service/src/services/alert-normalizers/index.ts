import type { ZodTypeAny } from 'zod';
import {
  SentinelAlertSchema,
  SplunkAlertWebhookSchema,
  WazuhAlertSchema,
} from '@orchestrator/shared-types';
import type { SecurityAlert } from '@orchestrator/shared-types';
import { normalizeSplunkAlert } from './splunk';
import { normalizeSentinelAlert } from './sentinel';
import { normalizeWazuhAlert } from './wazuh';

export interface VendorNormalizer {
  label: string;
  schema: ZodTypeAny;
  normalize: (payload: never) => SecurityAlert;
}

/**
 * SIEM adapters: each validates the vendor's native payload and maps it onto the
 * vendor-agnostic SecurityAlert contract. Adding a SIEM = one entry here.
 */
export const VENDOR_NORMALIZERS: Record<string, VendorNormalizer> = {
  splunk: { label: 'Splunk', schema: SplunkAlertWebhookSchema, normalize: normalizeSplunkAlert },
  sentinel: {
    label: 'Microsoft Sentinel',
    schema: SentinelAlertSchema,
    normalize: normalizeSentinelAlert,
  },
  wazuh: { label: 'Wazuh', schema: WazuhAlertSchema, normalize: normalizeWazuhAlert },
};

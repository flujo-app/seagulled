// Selected only by FLUJO's trusted build-time execution-adapter alias. These
// imports are resolved by that Source build, not by the Seagulled renderer.
import { createControllerNativeWorkerSourceAdapter } from '@/backend/execution/extensions/controllerNativeAdapter';
import { createNativeSourceAdmissionClient } from './native-source-client.mjs';

const transport = createNativeSourceAdmissionClient({
  url: process.env.SEAGULLED_NATIVE_PARENT_URL,
  token: process.env.SEAGULLED_NATIVE_PARENT_TOKEN,
});
const composed = createControllerNativeWorkerSourceAdapter(transport, {
  origin: process.env.FLUJO_BASE_URL,
  authorization: process.env.SEAGULLED_NATIVE_REQUESTER_AUTHORIZATION,
});
export const configuredExecutionAdapter = composed.adapter;

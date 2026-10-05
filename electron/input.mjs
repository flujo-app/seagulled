function requiredString(value,label,max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is invalid.`);
  return value;
}

export function validateConnectPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Connection details are invalid.');
  const payload = {
    id: requiredString(value.id,'ID',128),
    method: requiredString(value.method,'Connection method',100)
  };
  if (value.key !== undefined) payload.key=requiredString(value.key,'API key',10000);
  if (value.model !== undefined) payload.model=requiredString(value.model,'Model',200);
  if (value.fleetAllowed !== undefined) {
    if (typeof value.fleetAllowed !== 'boolean') throw new Error('Worker permission is invalid.');
    payload.fleetAllowed=value.fleetAllowed;
  }
  return payload;
}

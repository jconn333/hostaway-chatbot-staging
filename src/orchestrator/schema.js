function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m &&
    dt.getUTCDate() === d
  );
}

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateScalar(path, schema, value, errors) {
  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${path} must be a string`);
      return;
    }
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${path} must be at least ${schema.minLength} characters`);
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${path} must be <= ${schema.maxLength} characters`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
    }
    if (schema.format === "date" && !isIsoDate(value)) {
      errors.push(`${path} must be a valid date in YYYY-MM-DD format`);
    }
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) errors.push(`${path} must match ${schema.pattern}`);
    }
    return;
  }

  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      errors.push(`${path} must be a number`);
      return;
    }
    if (schema.type === "integer" && !Number.isInteger(value)) {
      errors.push(`${path} must be an integer`);
    }
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
    return;
  }

  if (schema.type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path} must be a boolean`);
    return;
  }

  if (schema.type === "null") {
    if (value !== null) errors.push(`${path} must be null`);
    return;
  }

  errors.push(`${path} has unsupported schema type ${schema.type}`);
}

function validateBySchema(path, schema, value, errors) {
  if (!schema || typeof schema !== "object") {
    errors.push(`${path} has invalid schema`);
    return;
  }

  if (Array.isArray(schema.anyOf)) {
    const branchErrors = [];
    for (const branch of schema.anyOf) {
      const local = [];
      validateBySchema(path, branch, value, local);
      if (local.length === 0) return;
      branchErrors.push(local.join("; "));
    }
    errors.push(`${path} did not match any allowed schema: ${branchErrors.join(" | ")}`);
    return;
  }

  if (schema.type === "object") {
    if (!isPlainObject(value)) {
      errors.push(`${path} must be an object`);
      return;
    }

    const props = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];

    for (const req of required) {
      if (!(req in value)) {
        errors.push(`${path}.${req} is required`);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }

    for (const [k, v] of Object.entries(value)) {
      if (!props[k]) continue;
      validateBySchema(`${path}.${k}`, props[k], v, errors);
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return;
    }
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${path} must include at least ${schema.minItems} items`);
    }
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${path} must include no more than ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, idx) => validateBySchema(`${path}[${idx}]`, schema.items, item, errors));
    }
    return;
  }

  validateScalar(path, schema, value, errors);
}

export function validateArgs(schema, args) {
  const errors = [];
  validateBySchema("args", schema, args, errors);
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function parseToolArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return { __invalid: `Unsupported args type: ${typeOf(raw)}` };
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return { __invalid: "Tool arguments must parse to an object" };
    }
    return parsed;
  } catch (err) {
    return { __invalid: `Invalid JSON args: ${String(err?.message || err)}` };
  }
}

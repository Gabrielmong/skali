export function inferType(value: string | number | boolean): "switch" | "number" | "text" {
  if (typeof value === "boolean") return "switch";
  if (typeof value === "number") return "number";
  if (value === "true" || value === "false" || value === "True" || value === "False") return "switch";
  return /^-?\d+(\.\d+)?$/.test(value) ? "number" : "text";
}

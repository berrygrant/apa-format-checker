export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "Unknown size";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatTimestamp(isoString) {
  if (!isoString) {
    return "";
  }

  const value = new Date(isoString);

  if (Number.isNaN(value.valueOf())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

export function humanizeStatus(status) {
  if (!status) {
    return "Pending";
  }

  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

